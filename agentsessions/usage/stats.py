"""Backing implementation for `agent-sessions json stats`.

Aggregates `~/.claude/projects/*/*.jsonl` (including sidechain lines) into 10-minute
buckets and returns totals for the 5-hour and 7-day reset windows. Sub-agent
transcripts found under `<project>/<id>/` (anywhere below it, e.g. under
`subagents/`, at any depth) are rolled up into the parent session's id.

Windows are read from whichever file under `~/.agents/sessions/status/*.json`
(written by `hooks.record_status`) has `rate_limits` and the newest mtime: `end`
comes from `resets_at` (or now, if missing), `start` is `end - 5h/7d`, and
`used_percentage` is `None` if missing.

For each file, the read position (`offset`), 10-minute buckets, and the most recent
`message.id`s (up to 200, for de-duplication) are carried over in
`~/.agents/sessions/stats-cache.json`. Transcripts are append-only, so if a file has
grown, only the part after `offset` is read; if it has shrunk, it's read from
scratch. A corrupted cache (whether the whole file or a single entry) is discarded
and rebuilt from scratch.
"""

import glob
import json
import math
import os
import tempfile
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from . import pricing
from ..sessions.scan import UUID_RE

BUCKET_SECONDS = 600          # 10 minutes
RECENT_IDS_LIMIT = 200
FIVE_HOUR_SECONDS = 5 * 3600
SEVEN_DAY_SECONDS = 7 * 24 * 3600

TOTAL_KEYS = ('calls', 'input', 'output', 'cache_read', 'cache_create')


def _int(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _num(value) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _parse_ts(value) -> Optional[float]:
    """Convert a transcript `timestamp` (ISO 8601 UTC, `...Z` suffix) to epoch seconds."""
    if not isinstance(value, str) or not value.endswith('Z'):
        return None
    raw = value[:-1]
    fmt = '%Y-%m-%dT%H:%M:%S.%f' if '.' in raw else '%Y-%m-%dT%H:%M:%S'
    try:
        return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def _bucket_key(ts: float) -> int:
    return int(ts // BUCKET_SECONDS) * BUCKET_SECONDS


def _empty_totals() -> dict:
    return {'calls': 0, 'input': 0, 'output': 0, 'cache_read': 0, 'cache_create': 0, 'cost': 0.0}


# ---- Windows (rate_limits) -------------------------------------------------

def _roll_forward(end: float, used_percentage: Optional[float], duration: float, now: float) -> Tuple[float, Optional[float]]:
    """If `end` (`resets_at`) is in the past relative to `now`, advance it by whole
    `duration` steps until it becomes the "current window"'s `end`. Without this,
    right after a reset -- before a fresh `rate_limits` payload has arrived -- the
    window would stay stuck on the old one, showing "0:00:00 until reset" while
    costs kept accumulating against the stale window.
    Once rolled forward, `used_percentage` is reported as unknown (`None`), since
    there's no way to know it until a new `rate_limits` payload arrives. If
    `end >= now`, both values are returned unchanged.
    """
    if end >= now:
        return end, used_percentage
    periods = math.ceil((now - end) / duration)
    return end + periods * duration, None


def windows_from_status(status_dir: str, now: float) -> Dict[str, dict]:
    """Returns `{'five_hour': {'end', 'used_percentage'}, 'seven_day': {...}}`.

    Picks whichever `*.json` file in `status_dir` has `rate_limits` and the newest
    mtime. If there's no such file, or a specific key is missing, defaults to
    `end=now`, `used_percentage=None`. If `resets_at` is in the past (the reset
    happened before a fresh `rate_limits` payload arrived), `_roll_forward` advances
    it to the current window.
    """
    best_path = None
    best_mtime = -1.0
    rate_limits: dict = {}
    try:
        entries = os.listdir(status_dir)
    except OSError:
        entries = []
    for name in entries:
        if not name.endswith('.json'):
            continue
        p = os.path.join(status_dir, name)
        try:
            mtime = os.stat(p).st_mtime
        except OSError:
            continue
        if mtime <= best_mtime:
            continue
        try:
            with open(p, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict) or not isinstance(data.get('rate_limits'), dict):
            continue
        best_path = p
        best_mtime = mtime
        rate_limits = data['rate_limits']

    durations = {'five_hour': FIVE_HOUR_SECONDS, 'seven_day': SEVEN_DAY_SECONDS}
    result = {}
    for key in ('five_hour', 'seven_day'):
        rl = rate_limits.get(key) if best_path is not None else None
        resets_at = _num(rl.get('resets_at')) if isinstance(rl, dict) else None
        if resets_at is not None:
            used = rl.get('used_percentage')
            used = used if isinstance(used, (int, float)) and not isinstance(used, bool) else None
            end, used = _roll_forward(resets_at, used, durations[key], now)
            result[key] = {'end': end, 'used_percentage': used}
        else:
            result[key] = {'end': now, 'used_percentage': None}
    return result


# ---- Enumerating transcripts (rolling up sub-agents) -----------------------

def list_transcripts_for_stats(projects_dir: str, min_mtime: float) -> List[Tuple[str, str, float]]:
    """A list of `(path, session_id, mtime)`, excluding anything with `mtime` below `min_mtime`.

    A top-level `<project>/<uuid>.jsonl` uses its own id. Any `.jsonl` found under
    `<project>/<uuid>/` (at any depth) belongs to the parent `<uuid>` (these are
    sub-agent transcripts).
    """
    out: List[Tuple[str, str, float]] = []
    for project_dir in glob.glob(os.path.join(projects_dir, '*')):
        if not os.path.isdir(project_dir):
            continue
        try:
            children = os.listdir(project_dir)
        except OSError:
            continue
        for entry in children:
            full = os.path.join(project_dir, entry)
            if entry.endswith('.jsonl') and os.path.isfile(full):
                sid = entry[:-len('.jsonl')]
                if not UUID_RE.match(sid):
                    continue
                try:
                    mtime = os.stat(full).st_mtime
                except OSError:
                    continue
                if mtime >= min_mtime:
                    out.append((full, sid, mtime))
            elif os.path.isdir(full) and UUID_RE.match(entry):
                sid = entry
                for root, _dirs, files in os.walk(full):
                    for fn in files:
                        if not fn.endswith('.jsonl'):
                            continue
                        p = os.path.join(root, fn)
                        try:
                            mtime = os.stat(p).st_mtime
                        except OSError:
                            continue
                        if mtime >= min_mtime:
                            out.append((p, sid, mtime))
    return out


# ---- Incremental cache -------------------------------------------------------

def load_cache(path: str) -> Dict[str, dict]:
    """Empty if the file doesn't exist. If it's corrupted, ignore it and return
    empty (rebuilt on the next `save_cache`)."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_cache(cache: Dict[str, dict], path: str) -> None:
    dirpath = os.path.dirname(path) or '.'
    os.makedirs(dirpath, exist_ok=True)
    data = json.dumps(cache, ensure_ascii=False).encode('utf-8')
    fd, tmp = tempfile.mkstemp(dir=dirpath, prefix='.stats-cache.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _load_entry(raw_entry) -> Optional[dict]:
    """Returns `None` if the shape is malformed (wrong types), so the caller re-reads
    from scratch."""
    if not isinstance(raw_entry, dict):
        return None
    offset = raw_entry.get('offset')
    size = raw_entry.get('size')
    mtime = raw_entry.get('mtime')
    buckets_raw = raw_entry.get('buckets')
    recent_raw = raw_entry.get('recent_ids')
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        return None
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        return None
    if not isinstance(mtime, (int, float)) or isinstance(mtime, bool):
        return None
    if not isinstance(buckets_raw, dict) or not isinstance(recent_raw, list):
        return None
    buckets: Dict[int, dict] = {}
    try:
        for k, v in buckets_raw.items():
            bucket_start = int(k)
            if not isinstance(v, dict):
                return None
            cost = v.get('cost')
            buckets[bucket_start] = {
                'calls': _int(v.get('calls')),
                'input': _int(v.get('input')),
                'output': _int(v.get('output')),
                'cache_read': _int(v.get('cache_read')),
                'cache_create': _int(v.get('cache_create')),
                'cost': float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) else 0.0,
            }
    except (TypeError, ValueError):
        return None
    recent_ids = [i for i in recent_raw if isinstance(i, str)]
    return {'mtime': float(mtime), 'size': size, 'offset': offset,
            'recent_ids': recent_ids, 'buckets': buckets}


def _update_file_buckets(path: str, raw_entry) -> dict:
    """Read `path` and, based on `raw_entry` (the previous cache entry; ignored if
    corrupted), return updated buckets, offset, and recent `message.id`s. The file
    is assumed to be append-only: if the size has shrunk, it's re-read from scratch;
    if it has grown, only the part after `offset` is read.
    """
    try:
        st = os.stat(path)
    except OSError:
        return {'mtime': 0.0, 'size': 0, 'offset': 0, 'recent_ids': [], 'buckets': {}}
    mtime, size = st.st_mtime, st.st_size

    loaded = _load_entry(raw_entry)
    if loaded is None or loaded['size'] > size:
        offset = 0
        buckets: Dict[int, dict] = {}
        recent_ids: List[str] = []
    elif loaded['size'] == size and loaded['mtime'] == mtime:
        # unchanged: skip opening the file
        return {'mtime': mtime, 'size': size, 'offset': loaded['offset'],
                'recent_ids': loaded['recent_ids'], 'buckets': loaded['buckets']}
    else:
        offset = loaded['offset']
        buckets = loaded['buckets']
        recent_ids = loaded['recent_ids']

    seen = set(recent_ids)
    new_offset = offset
    try:
        with open(path, 'rb') as f:
            f.seek(offset)
            for raw_line in f:
                if not raw_line.endswith(b'\n'):
                    break   # the last line might be a partial write in progress; leave it for next time
                new_offset += len(raw_line)
                line = raw_line.decode('utf-8', errors='replace').strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict) or rec.get('type') != 'assistant':
                    continue
                message = rec.get('message')
                message = message if isinstance(message, dict) else {}
                if message.get('model') == '<synthetic>':
                    continue
                usage = message.get('usage')
                if not isinstance(usage, dict):
                    continue
                msg_id = message.get('id')
                if msg_id is not None:
                    if msg_id in seen:
                        continue
                    seen.add(msg_id)
                    recent_ids.append(msg_id)
                ts = _parse_ts(rec.get('timestamp'))
                if ts is None:
                    continue
                bucket = buckets.setdefault(_bucket_key(ts), _empty_totals())
                bucket['calls'] += 1
                bucket['input'] += _int(usage.get('input_tokens'))
                bucket['output'] += _int(usage.get('output_tokens'))
                bucket['cache_read'] += _int(usage.get('cache_read_input_tokens'))
                bucket['cache_create'] += _int(usage.get('cache_creation_input_tokens'))
                bucket['cost'] += pricing.cost(usage, message.get('model'))
    except OSError:
        pass

    if len(recent_ids) > RECENT_IDS_LIMIT:
        recent_ids = recent_ids[len(recent_ids) - RECENT_IDS_LIMIT:]

    return {'mtime': mtime, 'size': size, 'offset': new_offset,
            'recent_ids': recent_ids, 'buckets': buckets}


# ---- Window totals -----------------------------------------------------------

def _window_totals(files: List[Tuple[str, str, Dict[int, dict]]],
                    start: float, end: float) -> Tuple[dict, Dict[str, dict]]:
    total = _empty_totals()
    sessions: Dict[str, dict] = {}
    for _path, sid, buckets in files:
        for bucket_start, b in buckets.items():
            if bucket_start < start or bucket_start >= end:
                continue
            s = sessions.setdefault(sid, _empty_totals())
            for key in TOTAL_KEYS:
                v = b.get(key, 0)
                s[key] += v
                total[key] += v
            s['cost'] += b.get('cost', 0.0)
            total['cost'] += b.get('cost', 0.0)
    sessions = {sid: s for sid, s in sessions.items() if s['calls'] > 0}
    return total, sessions


# ---- Main entry point ----------------------------------------------------------

def compute(now: float, projects_dir: str, status_dir: str, cache_path: str) -> dict:
    win = windows_from_status(status_dir, now)
    five_end = win['five_hour']['end']
    seven_end = win['seven_day']['end']
    five_start = five_end - FIVE_HOUR_SECONDS
    seven_start = seven_end - SEVEN_DAY_SECONDS
    min_mtime = min(five_start, seven_start)

    transcripts = list_transcripts_for_stats(projects_dir, min_mtime)
    cache = load_cache(cache_path)

    used_paths = set()
    per_file: List[Tuple[str, str, Dict[int, dict]]] = []
    for path, sid, _mtime in transcripts:
        used_paths.add(path)
        entry = _update_file_buckets(path, cache.get(path))
        cache[path] = entry
        per_file.append((path, sid, entry['buckets']))

    for p in list(cache):
        if p not in used_paths:
            del cache[p]
    save_cache(cache, cache_path)

    windows = {}
    for key, start, end in (('five_hour', five_start, five_end), ('seven_day', seven_start, seven_end)):
        total, sessions = _window_totals(per_file, start, end)
        windows[key] = {
            'start': start,
            'end': end,
            'used_percentage': win[key]['used_percentage'],
            'total': total,
            'sessions': sessions,
        }
    return {'windows': windows}

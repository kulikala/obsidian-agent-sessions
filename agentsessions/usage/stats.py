"""Backing implementation for `agent-sessions json stats`.

Aggregates `~/.claude/projects/*/*.jsonl` (including sidechain lines) into 10-minute
buckets and returns totals for the 5-hour and 7-day reset windows. Sub-agent
transcripts found under `<project>/<id>/` (anywhere below it, e.g. under
`subagents/`, at any depth) are rolled up into the parent session's id.

Each window comes from its newest reading: the newest file under
`~/.agents/sessions/status/*.json` (written by `hooks.record_status`) that has it,
or Claude Code's own `/usage` (`usage.claude_usage`), asked when the status files
can't tell (`needs_usage`) or when the user asks for the latest (`json stats --fresh`, a click
on a usage view) -- whichever was taken later. `end` is that reading's
`resets_at`, `start` is `end - 5h/7d`, and `used_percentage` its percentage; a
reading whose reset has passed is stale (`current_window`). No reading at all: `end`
is now and `used_percentage` is `None`.

A window is *exhausted* (`exhausted: true`, `used_percentage` reported as 100)
when Claude Code rejected a request for that window's limit inside it, or when
`used_percentage` itself reads 100 or more. Claude Code's `rate_limits` is a
snapshot of the last *accepted* response (`round(utilization * 1000) / 10`), so
once the limit is hit it keeps the last value below it (typically 99) instead of
reaching 100; the rejection is visible only in the transcript, as a synthetic
assistant line (`isApiErrorMessage: true`, `error: "rate_limit"`) reading
"You've hit your session limit · resets ..." (the 5-hour window) or "... your
weekly limit ..." (the 7-day window). The earliest such line inside the window
is `exhausted_at`; it is `None` when only the percentage says so.

One API response is written as several lines sharing a `message.id`, and the
`output_tokens` of the last one is the final count (the first holds a streamed,
partial figure), so a later line *replaces* the usage recorded for its id. A forked
sub-agent transcript also copies its parent's history, so the same id can appear in
several files; the windows count each id once (the copy with the largest output, the
shallowest file on a tie).

For each file, the read position (`offset`) and one record per `message.id` (its
10-minute bucket, token counts and cost, as of the latest line seen) are carried
over in `~/.agents/sessions/stats-cache.json`; de-duplication across files happens
when the windows are totalled. Transcripts are append-only, so if a file has
grown, only the part after `offset` is read; if it has shrunk, it's read from
scratch. A corrupted cache (whether the whole file or a single entry) is discarded
and rebuilt from scratch -- same treatment as an entry whose `schema_version`
doesn't match this module's `STATS_SCHEMA_VERSION` (see that constant's comment):
an upgrade that changes how a bucket is computed can't leave stale-logic buckets
sitting in the cache forever.
"""

import glob
import json
import math
import os
import tempfile
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from . import claude_usage, pricing
from ..sessions.scan import UUID_RE

BUCKET_SECONDS = 600          # 10 minutes
LIMIT_HITS_LIMIT = 50
FIVE_HOUR_SECONDS = 5 * 3600
SEVEN_DAY_SECONDS = 7 * 24 * 3600

# Bumped whenever this module's per-line bucket computation changes in a way
# that would make an old cache entry's *already-computed* buckets wrong (a
# changed field, a different cost formula, ...) -- unlike the offset/size
# check, which only protects against re-reading lines already accounted for,
# this protects against trusting old buckets computed by logic that no longer
# matches this file's own logic. A mismatched (or missing, i.e. pre-versioning)
# entry is treated as absent: a fresh read from offset 0, discarding the old
# buckets rather than layering new ones on top of possibly-wrong old ones. Same
# mechanism as sessions.scan.SCAN_SCHEMA_VERSION / agents.codex.scan.SCAN_SCHEMA_VERSION,
# versioned independently since this cache's shape (incremental, offset-based)
# is unrelated to theirs (whole-head, mtime/size-based).
STATS_SCHEMA_VERSION = 3

TOTAL_KEYS = ('calls', 'input', 'output', 'cache_read', 'cache_create')

# Layout of one per-`message.id` cache record (a list, to keep the cache small).
CALL_FIELDS = ('bucket', 'input', 'output', 'cache_read', 'cache_create', 'cost')
_OUTPUT = CALL_FIELDS.index('output')


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
    """Returns `{'five_hour': R, 'seven_day': R}`, each window's latest reading in the
    status files: `R = {'resets_at', 'used_percentage', 'as_of'}` (`as_of` the file's
    mtime), or `None` when no file has that window.

    Each window is taken from the newest `*.json` file in `status_dir` that has it, not
    from the newest file overall: at a reset Claude Code drops the expired window from
    the payload, and every idle session rewrites its file then, so the newest file can
    lack a window another file still has.
    """
    result: Dict[str, Optional[dict]] = {'five_hour': None, 'seven_day': None}
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
        if all(r is not None and r['as_of'] >= mtime for r in result.values()):
            continue
        try:
            with open(p, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        rate_limits = data.get('rate_limits') if isinstance(data, dict) else None
        if not isinstance(rate_limits, dict):
            continue
        for key in result:
            rl = rate_limits.get(key)
            resets_at = _num(rl.get('resets_at')) if isinstance(rl, dict) else None
            if resets_at is None or (result[key] is not None and result[key]['as_of'] >= mtime):
                continue
            used = rl.get('used_percentage')
            used = float(used) if isinstance(used, (int, float)) and not isinstance(used, bool) else None
            result[key] = {'resets_at': resets_at, 'used_percentage': used, 'as_of': mtime}
    return result


def _newer(local: Optional[dict], usage: Optional[dict]) -> Tuple[Optional[dict], Optional[str]]:
    """The newer (by `as_of`) of a window's two readings, and where it came from."""
    candidates = [(r, src) for r, src in ((local, 'status'), (usage, 'usage')) if r is not None]
    if not candidates:
        return None, None
    return max(candidates, key=lambda c: c[0]['as_of'])


def needs_usage(readings: Dict[str, Optional[dict]], now: float) -> bool:
    """Whether the current readings (`_newer` per window) can't tell the current windows: a
    window has no reading or its reset has passed. A window that isn't running (`resets_at`
    `None`) is told."""
    return any(r is None or (r['resets_at'] is not None and r['resets_at'] < now)
               for r in readings.values())


def current_window(local: Optional[dict], usage: Optional[dict], duration: float, now: float) -> dict:
    """One window from the newer of its two readings -- the status files' (`local`) and
    `/usage`'s (`usage`), both `{'resets_at', 'used_percentage', 'as_of'}` or `None` --
    as `{'end', 'used_percentage', 'source', 'as_of', 'stale', 'idle'}`. `end`, the
    percentage and (in `compute`) `start` all come from that one reading.

    A reading with no `resets_at` (`/usage`'s for a window that isn't running: no
    request since its reset) is *idle*: its percentage as read (0), and `end` now with
    no length (`compute` gives it `start == end`), so it has no totals, countdown,
    pace or "used up".

    A reading whose reset has passed is *stale*: the window it describes is over and
    what's used since is unknown, so the percentage is `None` and `end` is rolled
    forward by whole windows (`_roll_forward`). That `end` is the real next reset only
    for the 7-day window, whose resets fall on a fixed weekly time; a new 5-hour window
    starts at the first request after the reset, so a stale 5-hour `end` only bounds
    the totals. No reading at all: `end` is now and the percentage `None`.
    """
    reading, source = _newer(local, usage)
    if reading is None:
        return {'end': now, 'used_percentage': None, 'source': None, 'as_of': None, 'stale': False, 'idle': False}
    if reading['resets_at'] is None:
        return {'end': now, 'used_percentage': reading['used_percentage'], 'source': source,
                'as_of': reading['as_of'], 'stale': False, 'idle': True}
    end, used = _roll_forward(reading['resets_at'], reading['used_percentage'], duration, now)
    return {'end': end, 'used_percentage': used, 'source': source, 'as_of': reading['as_of'],
            'stale': reading['resets_at'] < now, 'idle': False}


# ---- Exhausted windows -------------------------------------------------------

# The wording of Claude Code's rejected-request line, per window. Matched only on
# a line already marked as a rate-limit API error, so the same words in
# conversation text never count. "Server is temporarily limiting requests (not
# your usage limit)" and a bare "monthly spend limit" carry neither phrase.
_LIMIT_PHRASES = (('session limit', 'five_hour'), ('weekly limit', 'seven_day'))


def limit_hit_keys(rec: dict) -> List[str]:
    """The window keys (`five_hour`/`seven_day`) a transcript line reports as
    used up, or `[]` for any other line."""
    if rec.get('type') != 'assistant' or rec.get('isApiErrorMessage') is not True:
        return []
    if rec.get('error') != 'rate_limit':
        return []
    message = rec.get('message')
    content = message.get('content') if isinstance(message, dict) else None
    text = ''.join(b.get('text') or '' for b in content
                   if isinstance(b, dict) and b.get('type') == 'text') if isinstance(content, list) else ''
    if 'not your usage limit' in text:
        return []
    return [key for phrase, key in _LIMIT_PHRASES if phrase in text]


def exhaustion(used_percentage: Optional[float], hit_times: List[float],
               start: float, end: float) -> Tuple[bool, Optional[float]]:
    """`(exhausted, exhausted_at)` for one window. Exhausted when a limit hit
    falls inside `[start, end)` or `used_percentage` is 100 or more;
    `exhausted_at` is the earliest hit inside the window, or `None` when only
    the percentage says so."""
    inside = [t for t in hit_times if start <= t < end]
    if inside:
        return True, min(inside)
    if used_percentage is not None and used_percentage >= 100:
        return True, None
    return False, None


def with_exhaustion(window: dict, hit_times: List[float]) -> dict:
    """`window` (`start`, `end`, `used_percentage`) plus `exhausted` and
    `exhausted_at`; `used_percentage` reads at least 100 once exhausted."""
    used = window['used_percentage']
    exhausted, at = exhaustion(used, hit_times, window['start'], window['end'])
    if exhausted and (used is None or used < 100):
        used = 100.0
    return dict(window, used_percentage=used, exhausted=exhausted, exhausted_at=at)


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
    """Returns `None` if the shape is malformed (wrong types) or was computed by
    a different `STATS_SCHEMA_VERSION` (including a pre-versioning entry, which
    has no `schema_version` key at all) -- either way, the caller re-reads from
    scratch rather than trusting buckets that may no longer match this module's
    own logic."""
    if not isinstance(raw_entry, dict):
        return None
    if raw_entry.get('schema_version') != STATS_SCHEMA_VERSION:
        return None
    offset = raw_entry.get('offset')
    size = raw_entry.get('size')
    mtime = raw_entry.get('mtime')
    calls_raw = raw_entry.get('calls')
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        return None
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        return None
    if not isinstance(mtime, (int, float)) or isinstance(mtime, bool):
        return None
    if not isinstance(calls_raw, dict):
        return None
    calls: Dict[str, list] = {}
    for k, v in calls_raw.items():
        if not isinstance(v, list) or len(v) != len(CALL_FIELDS):
            return None
        if any(not isinstance(x, (int, float)) or isinstance(x, bool) for x in v):
            return None
        calls[k] = v
    hits_raw = raw_entry.get('limit_hits')
    if not isinstance(hits_raw, list):
        return None
    limit_hits = [[float(h[0]), h[1]] for h in hits_raw
                  if isinstance(h, list) and len(h) == 2 and isinstance(h[0], (int, float))
                  and not isinstance(h[0], bool) and isinstance(h[1], str)]
    return {'mtime': float(mtime), 'size': size, 'offset': offset,
            'calls': calls, 'limit_hits': limit_hits}


def _update_file_calls(path: str, raw_entry) -> dict:
    """Read `path` and, based on `raw_entry` (the previous cache entry; ignored if
    corrupted), return the updated read offset, per-`message.id` records (see
    `CALL_FIELDS`), and limit hits (`[[timestamp, window key], ...]`, see
    `limit_hit_keys`). The file is assumed to be append-only: if the size has shrunk,
    it's re-read from scratch; if it has grown, only the part after `offset` is read.

    A later line with an id already recorded replaces that record's usage (the last
    line carries the final `output_tokens`) but keeps the bucket of the first line.
    A line without an id is recorded under `@<byte offset>`, which no other file shares.
    """
    try:
        st = os.stat(path)
    except OSError:
        return {'mtime': 0.0, 'size': 0, 'offset': 0, 'calls': {},
                'limit_hits': [], 'schema_version': STATS_SCHEMA_VERSION}
    mtime, size = st.st_mtime, st.st_size

    loaded = _load_entry(raw_entry)
    if loaded is None or loaded['size'] > size:
        offset = 0
        calls: Dict[str, list] = {}
        limit_hits: List[list] = []
    elif loaded['size'] == size and loaded['mtime'] == mtime:
        # unchanged: skip opening the file
        return {'mtime': mtime, 'size': size, 'offset': loaded['offset'],
                'calls': loaded['calls'], 'limit_hits': loaded['limit_hits'],
                'schema_version': STATS_SCHEMA_VERSION}
    else:
        offset = loaded['offset']
        calls = loaded['calls']
        limit_hits = loaded['limit_hits']

    new_offset = offset
    try:
        with open(path, 'rb') as f:
            f.seek(offset)
            for raw_line in f:
                if not raw_line.endswith(b'\n'):
                    break   # the last line might be a partial write in progress; leave it for next time
                line_offset = new_offset
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
                    hit_ts = _parse_ts(rec.get('timestamp'))
                    if hit_ts is not None:
                        limit_hits.extend([hit_ts, key] for key in limit_hit_keys(rec))
                    continue
                usage = message.get('usage')
                if not isinstance(usage, dict):
                    continue
                msg_id = message.get('id')
                key = msg_id if isinstance(msg_id, str) and msg_id else '@%d' % line_offset
                previous = calls.get(key)
                if previous is not None:
                    bucket = previous[0]
                else:
                    ts = _parse_ts(rec.get('timestamp'))
                    if ts is None:
                        continue
                    bucket = _bucket_key(ts)
                calls[key] = [bucket,
                              _int(usage.get('input_tokens')),
                              _int(usage.get('output_tokens')),
                              _int(usage.get('cache_read_input_tokens')),
                              _int(usage.get('cache_creation_input_tokens')),
                              pricing.cost(usage, message.get('model'))]
    except OSError:
        pass

    if len(limit_hits) > LIMIT_HITS_LIMIT:
        limit_hits = limit_hits[len(limit_hits) - LIMIT_HITS_LIMIT:]

    return {'mtime': mtime, 'size': size, 'offset': new_offset,
            'calls': calls, 'limit_hits': limit_hits,
            'schema_version': STATS_SCHEMA_VERSION}


# ---- Window totals -----------------------------------------------------------

def _window_totals(files: List[Tuple[str, str, Dict[str, list]]],
                    start: float, end: float) -> Tuple[dict, Dict[str, dict]]:
    """Sum the per-id records whose bucket is in [start, end). An id present in several
    files (a forked sub-agent copies its parent's history) is counted once: the record
    with the largest output wins, and `files` is walked shallowest first so that on a
    tie the original, not a copy, owns it. Ids starting with '@' are per-file."""
    best: Dict[str, Tuple[str, list]] = {}
    for path, sid, calls in sorted(files, key=lambda f: (f[0].count(os.sep), f[0])):
        for key, rec in calls.items():
            if rec[0] < start or rec[0] >= end:
                continue
            if key[:1] == '@':
                key = '%s%s' % (path, key)
            kept = best.get(key)
            if kept is None or rec[_OUTPUT] > kept[1][_OUTPUT]:
                best[key] = (sid, rec)

    total = _empty_totals()
    sessions: Dict[str, dict] = {}
    for sid, rec in best.values():
        s = sessions.setdefault(sid, _empty_totals())
        for t in (s, total):
            t['calls'] += 1
            t['input'] += rec[1]
            t['output'] += rec[2]
            t['cache_read'] += rec[3]
            t['cache_create'] += rec[4]
            t['cost'] += rec[5]
    return total, sessions


# ---- Main entry point ----------------------------------------------------------

def _usage_readings(got: Optional[dict]) -> Dict[str, dict]:
    """`claude_usage.readings`'s windows as `{'resets_at', 'used_percentage', 'as_of'}`."""
    out: Dict[str, dict] = {}
    for key, r in ((got or {}).get('windows') or {}).items():
        if not isinstance(r, dict):
            continue
        resets_at, used = r.get('resets_at'), r.get('used_percentage')
        if resets_at is not None and not isinstance(resets_at, (int, float)):
            continue
        used = float(used) if isinstance(used, (int, float)) and not isinstance(used, bool) else None
        out[key] = {'resets_at': resets_at, 'used_percentage': used, 'as_of': got['fetched_at']}
    return out


def compute(now: float, projects_dir: str, status_dir: str, cache_path: str,
            usage_path: Optional[str] = None, usage_runner=None, ask_usage: bool = False) -> dict:
    """`{'windows': {'five_hour': W, 'seven_day': W}}`. With `usage_path`, `/usage`'s last
    reading is weighed against the status files', and `/usage` is asked again when the
    newer of the two can't tell the windows (`needs_usage`) or `ask_usage` (the user asked for
    the latest) -- either way at most once per `claude_usage.MIN_INTERVAL_SECONDS`; without
    `usage_path`, the status files alone count."""
    local = windows_from_status(status_dir, now)
    usage: Dict[str, dict] = {}
    if usage_path is not None:
        usage = _usage_readings(claude_usage.readings(now, False, path=usage_path))
        newest = {key: _newer(local[key], usage.get(key))[0] for key in local}
        if ask_usage or needs_usage(newest, now):
            usage = _usage_readings(claude_usage.readings(now, True, path=usage_path, runner=usage_runner))
    win = {key: current_window(local[key], usage.get(key), duration, now)
           for key, duration in (('five_hour', FIVE_HOUR_SECONDS), ('seven_day', SEVEN_DAY_SECONDS))}
    five_end = win['five_hour']['end']
    seven_end = win['seven_day']['end']
    # an idle window (no request since its reset) has no length, so no totals
    five_start = five_end if win['five_hour']['idle'] else five_end - FIVE_HOUR_SECONDS
    seven_start = seven_end if win['seven_day']['idle'] else seven_end - SEVEN_DAY_SECONDS
    min_mtime = min(five_start, seven_start)

    transcripts = list_transcripts_for_stats(projects_dir, min_mtime)
    cache = load_cache(cache_path)

    used_paths = set()
    per_file: List[Tuple[str, str, Dict[str, list]]] = []
    hit_times: Dict[str, List[float]] = {'five_hour': [], 'seven_day': []}
    for path, sid, _mtime in transcripts:
        used_paths.add(path)
        entry = _update_file_calls(path, cache.get(path))
        cache[path] = entry
        per_file.append((path, sid, entry['calls']))
        for ts, key in entry['limit_hits']:
            if key in hit_times:
                hit_times[key].append(ts)

    for p in list(cache):
        if p not in used_paths:
            del cache[p]
    save_cache(cache, cache_path)

    windows = {}
    for key, minutes, start, end in (('five_hour', FIVE_HOUR_SECONDS / 60, five_start, five_end),
                                      ('seven_day', SEVEN_DAY_SECONDS / 60, seven_start, seven_end)):
        total, sessions = _window_totals(per_file, start, end)
        windows[key] = with_exhaustion({
            'key': key,
            # agents.<name>.windows: every window, any agent, carries its
            # own length in minutes, so a pace-calculation formula that only cares
            # about window length (not which agent or which of the fixed
            # five_hour/seven_day slots) can run against any of them uniformly --
            # including a Codex window that isn't 5h or 7d at all (see
            # agents.codex.stats, which needed this for exactly that reason).
            'minutes': minutes,
            'start': start,
            'end': end,
            'used_percentage': win[key]['used_percentage'],
            # Where the reading came from ('status' / 'usage' / None), when it was
            # taken, and whether its reset has passed (see `current_window`).
            'source': win[key]['source'],
            'as_of': win[key]['as_of'],
            'stale': win[key]['stale'],
            'idle': win[key]['idle'],
            'total': total,
            'sessions': sessions,
        }, hit_times[key])
    return {'windows': windows}

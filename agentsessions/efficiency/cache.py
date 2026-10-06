"""Per-transcript cache of file records (`normalize.read_file`).

One file per transcript: `<runtime>/efficiency/cache/<sha1(path)>.json`, holding the
transcript's path, size, mtime, `EFFICIENCY_VERSION` and its file record. A file record has
no conversation text (prompts, replies, commands): lengths, times, flags, tool kinds,
paths relative to the session's folder, hashes, and the byte offsets `excerpt.py` uses to
read a line again. Tasks, rework candidates and hits are never cached -- they depend on the
baselines and the range, and are recomputed from these numbers on every run.

A transcript written within `RACY_WINDOW` seconds isn't trusted from the cache (its mtime
can't tell two writes apart). Entries whose transcript is gone are removed on every run.
A record larger than `MAX_RECORD_BYTES` is coarsened: calls merged into 10-minute buckets
(detector times then have a 10-minute precision).
"""

import hashlib
import json
import os
import tempfile
from typing import Iterable, List, Optional, Tuple

from .. import config
from ..sessions.scan import RACY_WINDOW
from . import normalize

# Bumped whenever a file record's shape or meaning changes: other versions are read again.
EFFICIENCY_VERSION = 1
MAX_RECORD_BYTES = 1 << 20
BUCKET_SECONDS = 600


def cache_dir() -> str:
    return os.path.join(config.RUNTIME_DIR, 'efficiency', 'cache')


def entry_path(path: str, folder: Optional[str] = None) -> str:
    name = hashlib.sha1(path.encode('utf-8', 'surrogatepass')).hexdigest() + '.json'
    return os.path.join(folder or cache_dir(), name)


class Reader:
    """Reads file records through the cache and counts what it had to parse."""

    def __init__(self, now: float, folder: Optional[str] = None):
        self.now = now
        self.folder = folder or cache_dir()
        self.parsed_bytes = 0
        self.parsed_files = 0
        self.hits = 0

    def record(self, path: str, session: Optional[str] = None) -> Optional[dict]:
        try:
            st = os.stat(path)
        except OSError:
            return None
        target = entry_path(path, self.folder)
        trust = self.now - st.st_mtime >= RACY_WINDOW
        if trust:
            entry = _load(target)
            if (entry and entry.get('version') == EFFICIENCY_VERSION and entry.get('path') == path
                    and entry.get('size') == st.st_size and entry.get('mtime') == st.st_mtime):
                self.hits += 1
                return entry['record']
        rec = normalize.read_file(path, session=session)
        self.parsed_bytes += st.st_size
        self.parsed_files += 1
        rec = shrink(rec)
        _save(target, {'version': EFFICIENCY_VERSION, 'path': path, 'size': st.st_size,
                       'mtime': st.st_mtime, 'record': rec})
        return rec


def _load(target: str) -> Optional[dict]:
    try:
        with open(target, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get('record'), dict) else None


def _save(target: str, data: dict) -> None:
    folder = os.path.dirname(target)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix='.efficiency.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        os.replace(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def prune(keep: Iterable[str], folder: Optional[str] = None) -> int:
    """Remove the entries of transcripts not in `keep` (the transcripts that still exist).
    Returns how many were removed."""
    folder = folder or cache_dir()
    wanted = {os.path.basename(entry_path(p, folder)) for p in keep}
    removed = 0
    try:
        names = os.listdir(folder)
    except OSError:
        return 0
    for name in names:
        if name.endswith('.json') and name not in wanted:
            try:
                os.unlink(os.path.join(folder, name))
                removed += 1
            except OSError:
                pass
    return removed


def shrink(rec: dict) -> dict:
    """`rec` as is when it serialises within `MAX_RECORD_BYTES`; otherwise its calls merged
    into 10-minute buckets per chain (tokens summed, the last call's context, tools kept
    without offsets) and its small tool results dropped."""
    if len(json.dumps(rec, separators=(',', ':'))) <= MAX_RECORD_BYTES:
        return rec
    merged: List[dict] = []
    current: Optional[dict] = None
    for c in rec['calls']:
        key = int(c['ts'] // BUCKET_SECONDS) if c['ts'] is not None else None
        if current is not None and current['_bucket'] == key:
            for k in ('in', 'cr', 'cw', 'cw1h', 'out', 'th', 'vis'):
                current[k] += c.get(k, 0)
            current['ctx'] = c['ctx']
            current['tools'] += [_slim(t) for t in c['tools']]
            current['edits'] += c['edits']
            current['text_off'] = c['text_off'] or current['text_off']
            continue
        current = dict(c, tools=[_slim(t) for t in c['tools']], edits=list(c['edits']), _bucket=key)
        merged.append(current)
    for c in merged:
        del c['_bucket']
    out = dict(rec, calls=merged, coarse=True,
               results=[r for r in rec['results'] if r['est'] >= 1000])
    return out


def _slim(tool: dict) -> dict:
    return {k: v for k, v in tool.items() if k in ('n', 'k', 'p', 'id', 'c', 'model')}


def list_sessions(projects_dir: str, min_mtime: float) -> List[Tuple[str, str, float]]:
    """`(main transcript path, session id, mtime)` of every session last written at or after
    `min_mtime`, newest first."""
    from ..usage.stats import list_transcripts_for_stats
    out = []
    for path, sid, mtime in list_transcripts_for_stats(projects_dir, min_mtime):
        if os.path.basename(path) == sid + '.jsonl':
            out.append((path, sid, mtime))
    out.sort(key=lambda x: -x[2])
    return out


def all_transcripts(projects_dir: str) -> List[str]:
    from ..usage.stats import list_transcripts_for_stats
    return [p for p, _sid, _m in list_transcripts_for_stats(projects_dir, 0)]

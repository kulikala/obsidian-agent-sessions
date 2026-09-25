"""Read-only lookup of Codex thread names/titles from Codex's own sqlite database.

Never writes to the database, never holds a lock open. Any failure -- missing
file, locked/corrupt database, unexpected schema -- falls back through
`_last_known` (T-105) rather than raising or returning nothing: a name lookup
is a nice-to-have, never something scan/live/detail should fail over, but a
session's name also shouldn't *disappear* just because this one read attempt
didn't work.

Schema (from `CODEX_HOME/state_5.sqlite`'s `threads` table, checked against real
local data 2026-09-25, 62 rows, plus a real name/title pair for a
2026-09-25-dated session): `id` (== the thread id), `name` (nullable -- set only
by an explicit `/rename`), `title` (Codex's own auto-derived summary of the
first message -- non-null even for an un-renamed thread, and observed to match
the first message text exactly). `name`, when present, is this session's real
(user-chosen) name; `title` is a fallback "first prompt"-equivalent, ranked
above the rollout-derived one in `agents.codex.scan.scan` because some newer
Codex CLI versions' rollouts don't carry a cleanly-recoverable first message at
all (see `rollout.py`'s module docstring on `item_completed`/`user_message`) --
sqlite's own bookkeeping is more reliable than re-deriving it from the
transcript whenever it's available.

T-105 (a real report): with no `codex` process running, `state_5.sqlite`'s
`-wal`/`-shm` files can be entirely absent (WAL checkpointed and cleaned up on
Codex's last clean exit) -- opening a WAL-mode database `mode=ro` in that state
fails outright ("unable to open database file"), since sqlite normally needs to
create `-shm` even just to read, and `mode=ro` forbids creating anything.
`_connect` tries, in order: (1) plain `mode=ro` (works when `-wal`/`-shm`
already exist, e.g. codex is currently running); (2) if that fails and there's
no `-wal` file, `mode=ro&immutable=1` -- telling sqlite the file won't change
skips the WAL/shared-memory setup entirely, safe exactly because there's
nothing in a WAL to miss; (3) if that still fails (including when a `-wal` file
does exist but couldn't be opened read-only for some other reason), copy
`state_5.sqlite`/`-wal`/`-shm` to a private temp directory and open the copy
without any read-only restriction -- always safe, since nothing but this
process ever sees that copy, and it's deleted once the query is done.
"""
import json
import os
import shutil
import sqlite3
import tempfile
from dataclasses import asdict, dataclass
from typing import Dict, List, Optional, Tuple

from ... import config

DB_FILENAME = 'state_5.sqlite'


@dataclass
class ThreadInfo:
    name: Optional[str] = None    # an explicit /rename
    title: Optional[str] = None   # Codex's own auto-generated summary


def _connect_and_probe(target, **kw) -> Optional[sqlite3.Connection]:
    """`sqlite3.connect()` alone doesn't validate the file can actually be
    opened -- that happens lazily, on the first real access -- so a failed
    attempt (e.g. `mode=ro` with no `-shm` it's allowed to create) would
    otherwise look like it succeeded until a query is run against it, well
    after `_connect` had already committed to that attempt. A cheap probe
    query right here forces the real failure to surface at the right point,
    so the fallback chain below actually gets to try its next strategy."""
    try:
        conn = sqlite3.connect(target, **kw)
        conn.execute('SELECT 1')
        return conn
    except sqlite3.Error:
        return None


def _connect(path: str) -> Tuple[Optional[sqlite3.Connection], Optional[str]]:
    """`(connection, temp_dir_to_clean_up_afterward)` -- the second element is
    `None` unless the copy-to-temp-dir fallback was used. `(None, None)` if
    every strategy failed."""
    conn = _connect_and_probe('file:%s?mode=ro' % path, uri=True, timeout=1.0)
    if conn is not None:
        return conn, None

    wal_path = path + '-wal'
    if not os.path.exists(wal_path):
        conn = _connect_and_probe('file:%s?mode=ro&immutable=1' % path, uri=True, timeout=1.0)
        if conn is not None:
            return conn, None

    tmpdir = tempfile.mkdtemp(prefix='agent-sessions-codex-db-')
    try:
        dst = os.path.join(tmpdir, DB_FILENAME)
        shutil.copyfile(path, dst)
        for suffix in ('-wal', '-shm'):
            src = path + suffix
            if os.path.exists(src):
                shutil.copyfile(src, dst + suffix)
        # No `mode=ro`/URI here: this is a private copy nothing else can see,
        # so there's no reason to restrict what sqlite is allowed to do with it
        # (creating its own fresh -shm, say) -- and no risk either, since
        # whatever it does only touches the copy, never the real files.
        conn = _connect_and_probe(dst, timeout=1.0)
        if conn is not None:
            return conn, tmpdir
    except OSError:
        pass
    try:
        shutil.rmtree(tmpdir, ignore_errors=True)
    except OSError:
        pass
    return None, None


def _load_last_known(cache_path: str) -> Dict[str, ThreadInfo]:
    try:
        with open(cache_path, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    out: Dict[str, ThreadInfo] = {}
    for tid, v in data.items():
        if isinstance(tid, str) and isinstance(v, dict):
            out[tid] = ThreadInfo(name=v.get('name') or None, title=v.get('title') or None)
    return out


def _save_last_known(cache_path: str, fresh: Dict[str, ThreadInfo]) -> None:
    """Merges `fresh` into whatever's already on disk (an id not present in
    `fresh` -- because this call's `session_ids` didn't include it -- keeps its
    previously-saved entry rather than being dropped)."""
    existing = _load_last_known(cache_path)
    existing.update(fresh)
    try:
        dirpath = os.path.dirname(cache_path) or '.'
        os.makedirs(dirpath, exist_ok=True)
        data = json.dumps({tid: asdict(info) for tid, info in existing.items()}, ensure_ascii=False).encode('utf-8')
        fd, tmp = tempfile.mkstemp(dir=dirpath, prefix='.codex-names-cache.', suffix='.tmp')
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
            os.replace(tmp, cache_path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    except OSError:
        pass   # best-effort -- a failed cache write never blocks the lookup itself


def lookup_thread_info(home: str, session_ids: List[str],
                        names_cache_path: Optional[str] = None) -> Dict[str, ThreadInfo]:
    """`{thread_id: ThreadInfo}` for every id in `session_ids` that has a
    non-empty `name` and/or `title`. Read-only, one batched query. On success,
    also updates the on-disk last-known-good cache (`names_cache_path`,
    defaulting to `config.CODEX_NAMES_CACHE_PATH`); on failure to even open the
    database (including "no such database", the common case if Codex has never
    been run), falls back to reading that cache instead of returning `{}`."""
    if names_cache_path is None:
        names_cache_path = config.CODEX_NAMES_CACHE_PATH
    if not session_ids:
        return {}
    path = os.path.join(home, DB_FILENAME)
    if not os.path.exists(path):
        return _last_known_subset(names_cache_path, session_ids)

    conn, tmpdir = _connect(path)
    if conn is None:
        return _last_known_subset(names_cache_path, session_ids)
    try:
        conn.row_factory = sqlite3.Row
        placeholders = ','.join('?' for _ in session_ids)
        query = 'SELECT id, name, title FROM threads WHERE id IN (%s)' % placeholders
        out: Dict[str, ThreadInfo] = {}
        for row in conn.execute(query, session_ids):
            name = row['name'] or None
            title = row['title'] or None
            if name or title:
                out[row['id']] = ThreadInfo(name=name, title=title)
        _save_last_known(names_cache_path, out)
        return out
    except sqlite3.Error:
        return _last_known_subset(names_cache_path, session_ids)
    finally:
        conn.close()
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


def _last_known_subset(cache_path: str, session_ids: List[str]) -> Dict[str, ThreadInfo]:
    last_known = _load_last_known(cache_path)
    wanted = set(session_ids)
    return {tid: info for tid, info in last_known.items() if tid in wanted}

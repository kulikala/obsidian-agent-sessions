"""Read-only access to OpenCode's own SQLite database
(`$XDG_DATA_HOME/opencode/opencode.db`, default `~/.local/share/opencode/`; see `db_path` for
`OPENCODE_DB` and the per-channel `opencode-<channel>.db`).

OpenCode keeps no per-session transcript file: sessions, messages and message
parts are rows in one database (`session`, `message`, `part`; `data` columns are
JSON, times are epoch milliseconds). So the adapter's "transcript" of a session
is a pseudo path `opencode:<ses_id>` (see `pseudo_path`); it never names a file,
and nothing here is cached in `scan-cache.json`, since a few indexed queries
are cheaper than the cache bookkeeping.

Only ever opened read-only, so this is safe alongside a live `opencode`
process. The connection strategy is the same as `agents.codex.names`: plain
`mode=ro` (works while OpenCode's `-wal`/`-shm` exist), then `immutable=1` when
there is no `-wal` (nothing to miss), then a private copy. The schema drifts
between OpenCode versions (columns were added by later migrations), so callers
select through `select_columns`, which turns a missing column into `NULL`.
"""
import json
import os
import shutil
import sqlite3
import tempfile
from typing import Any, Iterable, List, Mapping, Optional, Tuple

from ... import paths

DB_FILENAME = 'opencode.db'
PSEUDO_PREFIX = 'opencode:'
DEFAULT_TITLE_PREFIX = 'New session - '


def data_dir() -> str:
    base = os.environ.get('XDG_DATA_HOME') or os.path.join(os.path.expanduser('~'), '.local', 'share')
    return os.path.join(base, 'opencode')


def _written_at(path: str) -> float:
    """When `path` (or its `-wal`, which takes the writes while OpenCode runs) last changed; -1 if absent."""
    times = []
    for p in (path, path + '-wal'):
        try:
            times.append(os.stat(p).st_mtime)
        except OSError:
            pass
    return max(times) if times else -1.0


def db_path(environ: Optional[Mapping[str, str]] = None, data: Optional[str] = None) -> Optional[str]:
    """The database OpenCode uses, by its own rule (`packages/core/src/database/database.ts`):
    `OPENCODE_DB` when set (relative to the data folder unless absolute; `:memory:` means none on
    disk, so `None`); else `opencode.db` for the release channels, or with
    `OPENCODE_DISABLE_CHANNEL_DB` set to `1`/`true`; else `opencode-<channel>.db`. The channel is
    built into the binary, so of `opencode.db` and every `opencode-*.db` the one written last is
    taken (`opencode.db` when none exists yet)."""
    environ = os.environ if environ is None else environ
    data = data or data_dir()
    named = environ.get('OPENCODE_DB')
    if named:
        if named == ':memory:':
            return None
        return named if os.path.isabs(named) else os.path.join(data, named)
    default = os.path.join(data, DB_FILENAME)
    if environ.get('OPENCODE_DISABLE_CHANNEL_DB') in ('1', 'true'):
        return default
    try:
        names = os.listdir(data)
    except OSError:
        return default
    candidates = [os.path.join(data, n) for n in names
                  if n == DB_FILENAME or (n.startswith('opencode-') and n.endswith('.db'))]
    return max(candidates, key=_written_at) if candidates else default


def pseudo_path(session_id: str) -> str:
    return PSEUDO_PREFIX + session_id


def session_id_of(path: str) -> Optional[str]:
    if isinstance(path, str) and path.startswith(PSEUDO_PREFIX) and len(path) > len(PSEUDO_PREFIX):
        return path[len(PSEUDO_PREFIX):]
    return None


def _probe(target, **kw) -> Optional[sqlite3.Connection]:
    """`sqlite3.connect()` opens lazily; the probe query makes a failed attempt
    fail here, so the fallback chain in `connect` actually gets to try the next
    strategy."""
    conn = None
    try:
        conn = sqlite3.connect(target, **kw)
        conn.execute('SELECT 1')
        return conn
    except sqlite3.Error:
        if conn is not None:
            conn.close()
        return None


class Db:
    """A read-only connection; `close()` also removes a private copy, if one was needed."""

    def __init__(self, conn: sqlite3.Connection, tmpdir: Optional[str] = None):
        self.conn = conn
        self.conn.row_factory = sqlite3.Row
        self._tmpdir = tmpdir
        self._columns = {}
        # `json_extract` is in every sqlite built with JSON1 (the norm since 3.38);
        # without it the role filter falls back to a substring test on the JSON.
        try:
            conn.execute("SELECT json_extract('{\"a\":1}', '$.a')")
            self._json = True
        except sqlite3.Error:
            self._json = False

    def close(self) -> None:
        self.conn.close()
        if self._tmpdir:
            shutil.rmtree(self._tmpdir, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def columns(self, table: str) -> List[str]:
        if table not in self._columns:
            try:
                rows = self.conn.execute('PRAGMA table_info(%s)' % table).fetchall()
            except sqlite3.Error:
                rows = []
            self._columns[table] = [r['name'] for r in rows]
        return self._columns[table]

    def select_columns(self, table: str, wanted: Iterable[str], alias: str = '') -> str:
        """`a.x, a.y, NULL AS z` -- `wanted` columns the table lacks read as NULL."""
        have = set(self.columns(table))
        prefix = alias + '.' if alias else ''
        return ', '.join(('%s%s' % (prefix, c)) if c in have else ('NULL AS %s' % c) for c in wanted)

    def role_is(self, role: str, column: str = 'm.data') -> str:
        """An SQL condition: the message row's `data.role` is `role`."""
        if self._json:
            return "json_extract(%s, '$.role') = '%s'" % (column, role)
        return "%s LIKE '%%\"role\":\"%s\"%%'" % (column, role)

    def part_is(self, ptype: str, column: str = 'p.data') -> str:
        """An SQL condition: the part row's `data.type` is `ptype`."""
        if self._json:
            return "json_extract(%s, '$.type') = '%s'" % (column, ptype)
        return "%s LIKE '%%\"type\":\"%s\"%%'" % (column, ptype)

    def query(self, sql: str, params: Tuple = ()) -> List[sqlite3.Row]:
        """All rows, or `[]` if the query fails (missing table, locked, ...)."""
        try:
            return self.conn.execute(sql, params).fetchall()
        except sqlite3.Error:
            return []


def open_db(path: Optional[str] = None) -> Optional[Db]:
    """A read-only `Db`, or `None` if OpenCode has no readable database."""
    path = path or db_path()
    if not path:
        return None
    if not os.path.isfile(path):
        return None
    conn = _probe(paths.sqlite_uri(path, 'mode=ro'), uri=True, timeout=1.0)
    if conn is not None:
        return Db(conn)
    if not os.path.exists(path + '-wal'):
        conn = _probe(paths.sqlite_uri(path, 'mode=ro&immutable=1'), uri=True, timeout=1.0)
        if conn is not None:
            return Db(conn)
    tmpdir = tempfile.mkdtemp(prefix='agent-sessions-opencode-db-')
    try:
        dst = os.path.join(tmpdir, DB_FILENAME)
        shutil.copyfile(path, dst)
        for suffix in ('-wal', '-shm'):
            if os.path.exists(path + suffix):
                shutil.copyfile(path + suffix, dst + suffix)
        conn = _probe(dst, timeout=1.0)
        if conn is not None:
            return Db(conn, tmpdir)
    except OSError:
        pass
    shutil.rmtree(tmpdir, ignore_errors=True)
    return None


def loads(text: Any) -> dict:
    """`text` parsed as a JSON object, `{}` for anything else."""
    if not isinstance(text, str):
        return {}
    try:
        v = json.loads(text)
    except ValueError:
        return {}
    return v if isinstance(v, dict) else {}


def model_of(session_model: Any) -> Optional[str]:
    """`"<providerID>/<id>"` from `session.model` (JSON `{"id", "providerID", ...}`)."""
    d = loads(session_model)
    provider, mid = d.get('providerID'), d.get('id')
    if isinstance(mid, str) and mid:
        return '%s/%s' % (provider, mid) if isinstance(provider, str) and provider else mid
    return None


def model_of_message(data: dict) -> Optional[str]:
    """Same, from an assistant message's `modelID`/`providerID` (or a user
    message's `model: {providerID, modelID}`)."""
    m = data.get('model') if isinstance(data.get('model'), dict) else data
    provider, mid = m.get('providerID'), m.get('modelID')
    if isinstance(mid, str) and mid:
        return '%s/%s' % (provider, mid) if isinstance(provider, str) and provider else mid
    return None


def is_non_interactive(permission) -> bool:
    """`session.permission` (a JSON list of `{permission, pattern, action}`
    rules) denies `question`: the session was made by `opencode run`."""
    if not isinstance(permission, str) or not permission:
        return False
    try:
        rules = json.loads(permission)
    except ValueError:
        return False
    return isinstance(rules, list) and any(
        isinstance(r, dict) and r.get('permission') == 'question' and r.get('action') == 'deny'
        for r in rules)


def text_of_parts(rows: Iterable[sqlite3.Row]) -> str:
    """The joined text of `part.data` rows of type `text`, skipping synthetic
    (tool-injected) and ignored ones."""
    out = []
    for r in rows:
        d = loads(r['data'])
        if d.get('type') != 'text' or d.get('synthetic') or d.get('ignored'):
            continue
        t = d.get('text')
        if isinstance(t, str) and t.strip():
            out.append(t)
    return '\n'.join(out)

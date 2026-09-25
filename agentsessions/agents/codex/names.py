"""Read-only lookup of Codex thread names (set via `/rename`) from Codex's own
sqlite database.

Never writes, never holds a lock open: `sqlite3.connect` is given a `mode=ro` URI,
so a concurrently-running `codex` process can keep writing to the (WAL-mode)
database without this ever blocking it or being blocked by it. Any failure --
missing file, locked/corrupt database, unexpected schema -- returns `{}` rather
than raising; a name lookup is a nice-to-have, never something scan/live/detail
should fail over.

Schema (from `CODEX_HOME/state_5.sqlite`'s `threads` table, checked against real
local data 2026-09-25, 62 rows): `id` (== the thread id), `name` (nullable --
set only by an explicit `/rename`; NULL/empty otherwise, and in the checked data
no thread had been renamed), `title` (an auto-derived summary of the first
message -- not used here; the contract's fallback is the first *user* message
itself, read straight from the rollout, same convention as Claude Code's
untitled sessions), `source` (matches `session_meta.payload.source` closely
enough to have been a useful cross-check, but the rollout itself stays the
source of truth for `child`).
"""
import os
import sqlite3
from typing import Dict, List

DB_FILENAME = 'state_5.sqlite'


def lookup_names(home: str, session_ids: List[str]) -> Dict[str, str]:
    """`{thread_id: name}` for every id in `session_ids` that has a non-empty
    `/rename`d name. Read-only; returns `{}` on any failure (including "no such
    database", which is the common case if Codex has never been run)."""
    if not session_ids:
        return {}
    path = os.path.join(home, DB_FILENAME)
    if not os.path.exists(path):
        return {}
    try:
        conn = sqlite3.connect('file:%s?mode=ro' % path, uri=True, timeout=1.0)
    except sqlite3.Error:
        return {}
    try:
        conn.row_factory = sqlite3.Row
        placeholders = ','.join('?' for _ in session_ids)
        query = 'SELECT id, name FROM threads WHERE id IN (%s)' % placeholders
        out: Dict[str, str] = {}
        for row in conn.execute(query, session_ids):
            name = row['name']
            if name:
                out[row['id']] = name
        return out
    except sqlite3.Error:
        return {}
    finally:
        conn.close()

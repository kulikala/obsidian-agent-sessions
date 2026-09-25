"""Read-only lookup of Codex thread names/titles from Codex's own sqlite database.

Never writes, never holds a lock open: `sqlite3.connect` is given a `mode=ro` URI,
so a concurrently-running `codex` process can keep writing to the (WAL-mode)
database without this ever blocking it or being blocked by it. Any failure --
missing file, locked/corrupt database, unexpected schema -- returns `{}` rather
than raising; a name lookup is a nice-to-have, never something scan/live/detail
should fail over.

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
"""
import os
import sqlite3
from dataclasses import dataclass
from typing import Dict, List, Optional

DB_FILENAME = 'state_5.sqlite'


@dataclass
class ThreadInfo:
    name: Optional[str] = None    # an explicit /rename
    title: Optional[str] = None   # Codex's own auto-generated summary


def lookup_thread_info(home: str, session_ids: List[str]) -> Dict[str, ThreadInfo]:
    """`{thread_id: ThreadInfo}` for every id in `session_ids` that has a
    non-empty `name` and/or `title`. Read-only, one batched query; returns `{}`
    on any failure (including "no such database", the common case if Codex has
    never been run, and "no such column", in case a fixture or an unexpected
    schema lacks one of the two columns)."""
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
        query = 'SELECT id, name, title FROM threads WHERE id IN (%s)' % placeholders
        out: Dict[str, ThreadInfo] = {}
        for row in conn.execute(query, session_ids):
            name = row['name'] or None
            title = row['title'] or None
            if name or title:
                out[row['id']] = ThreadInfo(name=name, title=title)
        return out
    except sqlite3.Error:
        return {}
    finally:
        conn.close()

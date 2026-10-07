"""Read-only lookup of Codex's `/goal` per thread, from Codex's own `goals_1.sqlite`.

Codex keeps one goal per thread in the `thread_goals` table (`codex-rs/state`), in the same
folder as `state_5.sqlite` (`names.sqlite_home`): `thread_id`, `objective`, `status` (`active`,
`paused`, `blocked`, `usage_limited`, `budget_limited`, `complete`), `created_at_ms`,
`updated_at_ms`, plus token/time accounting. `/goal <objective>` inserts or replaces the row,
`/goal pause`/`resume` and the agent's `update_goal` tool change `status`, and `/goal clear`
deletes the row. The table is the only complete record: the rollout carries a
`thread_goal_updated` event when a goal is set, but neither the agent's own status changes nor a
clear.

Opened the same way as `names.lookup_thread_info` (`names._connect`: `mode=ro`, then
`immutable`, then a private copy), never written. Any failure returns `{}` -- the session then
simply shows no goal until the next scan.
"""
import os
import shutil
import sqlite3
from typing import Dict, List, Optional

from . import names as _names

DB_FILENAME = 'goals_1.sqlite'

# Statuses in which the goal is no longer being pursued, though Codex keeps it (`/goal resume`
# picks a paused, blocked or limited goal up again).
STOPPED_STATUSES = ('paused', 'blocked', 'usage_limited', 'budget_limited')


def goal_from_row(objective, status, created_at_ms, updated_at_ms) -> Optional[dict]:
    """One `thread_goals` row as a session goal -- the shape `sessions/scan.py`'s
    `apply_goal_status` gives a Claude Code goal: `{condition, met, reason, since, updated}`
    (+ `failed: True` for a stopped goal), times in epoch seconds, plus Codex's own `status`.
    None for a row without an objective or with a status this module does not know."""
    if not isinstance(objective, str) or not objective:
        return None
    if status != 'active' and status != 'complete' and status not in STOPPED_STATUSES:
        return None
    since = created_at_ms / 1000 if isinstance(created_at_ms, (int, float)) else None
    updated = updated_at_ms / 1000 if isinstance(updated_at_ms, (int, float)) else since
    goal = {'condition': objective, 'met': status == 'complete', 'reason': None,
            'since': since, 'updated': updated, 'status': status}
    if status in STOPPED_STATUSES:
        goal['failed'] = True
    return goal


def lookup_thread_goals(home: str, session_ids: List[str]) -> Dict[str, dict]:
    """`{thread_id: goal}` for every id in `session_ids` that has a goal (`goal_from_row`).
    Read-only, one batched query."""
    if not session_ids:
        return {}
    path = os.path.join(_names.sqlite_home(home), DB_FILENAME)
    if not os.path.exists(path):
        return {}
    conn, tmpdir = _names._connect(path)
    if conn is None:
        return {}
    try:
        placeholders = ','.join('?' for _ in session_ids)
        query = ('SELECT thread_id, objective, status, created_at_ms, updated_at_ms '
                 'FROM thread_goals WHERE thread_id IN (%s)' % placeholders)
        out: Dict[str, dict] = {}
        for thread_id, objective, status, created_at_ms, updated_at_ms in conn.execute(query, session_ids):
            goal = goal_from_row(objective, status, created_at_ms, updated_at_ms)
            if goal is not None:
                out[thread_id] = goal
        return out
    except sqlite3.Error:
        return {}
    finally:
        conn.close()
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)

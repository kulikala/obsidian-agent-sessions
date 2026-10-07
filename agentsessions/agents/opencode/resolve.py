"""Resolving a freshly-started daemon session to its real OpenCode session id.

OpenCode can't be told a session id at launch (`--session` only resumes an
existing one), so the plugin starts it under a daemon-assigned uuid and asks
here -- possibly repeatedly, the row appears when the TUI has started -- what
`ses_...` id it turned out to be. Same contract as `agents.codex.resolve`:
`(session_id, pseudo_path)` or `(None, None)`, never an exception.

Two strategies, in order:
1. **Status file**: the plugin's status file whose `pid` is `pid` or one of its
   descendants (the PTY child may be a wrapper around the real process) --
   exact. The plugin writes it when the session is created (at TUI launch).
2. **Database**: the top-level, interactive session whose `directory` is `cwd`
   (`paths.same_folder`), with `time_created >= since` (epoch seconds), that
   isn't in `already_linked`.
   The session row is created at TUI launch, before any message, so no user
   message is required. `opencode run` sessions (`db.is_non_interactive`) are
   skipped, and with more than one candidate nothing is returned: guessing
   could tie a tab to another tab's session. The caller polls again, by which
   time strategy 1 has the file.
"""
from typing import Optional, Set, Tuple

from ... import config, paths
from ..codex.resolve import _ps_tree, child_pids
from . import db as _db
from . import live as _live


def resolve(pid: int, since: float, cwd: str, already_linked: Optional[Set[str]] = None,
            path: Optional[str] = None, status_dir: Optional[str] = None,
            ) -> Tuple[Optional[str], Optional[str]]:
    already_linked = already_linked or set()
    d = _db.open_db(path)
    if d is None:
        return None, None
    try:
        # Only a session that exists in the database counts, for either strategy.
        if pid:
            tree = set(child_pids(pid, _ps_tree()))
            for sid, live in _live.read_status_files(status_dir or config.OPENCODE_STATUS_DIR).items():
                if live.pid in tree and sid not in already_linked \
                        and d.query('SELECT 1 FROM session WHERE id = ?', (sid,)):
                    return sid, _db.pseudo_path(sid)
        have = d.columns('session')
        # The folder is compared here, not in SQL: Windows spells one folder several ways.
        where = ['time_created >= ?']
        if 'parent_id' in have:
            where.append('parent_id IS NULL')
        rows = d.query('SELECT %s FROM session WHERE %s ORDER BY time_created DESC, id DESC'
                       % (d.select_columns('session', ('id', 'directory', 'permission')), ' AND '.join(where)),
                       (int(since * 1000),))
        candidates = [r['id'] for r in rows
                      if r['id'] not in already_linked and paths.same_folder(r['directory'] or '', cwd)
                      and not _db.is_non_interactive(r['permission'])]
        if len(candidates) == 1:
            return candidates[0], _db.pseudo_path(candidates[0])
        return None, None
    finally:
        d.close()


def new_session(pid: int, since: float, already_linked: Optional[Set[str]] = None,
                path: Optional[str] = None, status_dir: Optional[str] = None,
                ) -> Tuple[Optional[str], Optional[str]]:
    """`(session_id, pseudo_path)` of a session that OpenCode at `pid` (or a descendant) created at
    or after `since` and that no session is linked to yet, or `(None, None)`.

    This is what `/new` leaves behind in a tab that is already linked to a session: the same
    process creates the new session with its first message, and the plugin's status file for it
    carries the process's pid, so another OpenCode in the same folder is never taken for it. A
    session picked from `/sessions` was created before `since`; one `/fork` made holds copies of
    earlier messages, older than the session itself; neither counts, nor do sub-agent and
    `opencode run` sessions. With several, the newest wins."""
    already_linked = already_linked or set()
    tree = set(child_pids(pid, _ps_tree()))
    ids = [sid for sid, live in _live.read_status_files(status_dir or config.OPENCODE_STATUS_DIR).items()
           if live.pid in tree and sid not in already_linked]
    if not ids:
        return None, None
    d = _db.open_db(path)
    if d is None:
        return None, None
    try:
        best: Optional[Tuple[int, str]] = None
        for sid in ids:
            rows = d.query('SELECT %s FROM session WHERE id = ?'
                           % d.select_columns('session', ('time_created', 'parent_id', 'permission')), (sid,))
            if not rows:
                continue
            row = rows[0]
            created = row['time_created'] or 0
            if created < since * 1000 or row['parent_id'] or _db.is_non_interactive(row['permission']):
                continue
            first = d.query('SELECT MIN(time_created) AS t FROM message WHERE session_id = ?', (sid,))
            if first and first[0]['t'] is not None and first[0]['t'] < created:
                continue
            if best is None or created > best[0]:
                best = (created, sid)
        return (best[1], _db.pseudo_path(best[1])) if best else (None, None)
    finally:
        d.close()

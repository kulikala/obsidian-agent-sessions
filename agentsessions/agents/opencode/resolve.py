"""Resolving a freshly-started daemon session to its real OpenCode session id.

OpenCode can't be told a session id at launch (`--session` only resumes an
existing one), so the plugin starts it under a daemon-assigned uuid and asks
here -- possibly repeatedly, the row appears when the TUI has started -- what
`ses_...` id it turned out to be. Same contract as `agents.codex.resolve`:
`(session_id, pseudo_path)` or `(None, None)`, never an exception.

Two strategies, in order:
1. **Status file**: the plugin's status file whose `pid` is `pid` or one of its
   descendants (the PTY child may be a wrapper around the real process) --
   exact, but the file only exists after the first status event.
2. **Database**: the newest top-level session with `directory == cwd`,
   `time_created >= since` (epoch seconds) that isn't in `already_linked`.
   The session row is created at TUI launch, before any message, so no user
   message is required.
"""
from typing import Optional, Set, Tuple

from ... import config
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
        where = ['directory = ?', 'time_created >= ?']
        if 'parent_id' in have:
            where.append('parent_id IS NULL')
        rows = d.query('SELECT id FROM session WHERE %s ORDER BY time_created DESC, id DESC' % ' AND '.join(where),
                       (cwd, int(since * 1000)))
        for r in rows:
            if r['id'] not in already_linked:
                return r['id'], _db.pseudo_path(r['id'])
        return None, None
    finally:
        d.close()

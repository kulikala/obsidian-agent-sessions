"""Busy/idle/waiting detection for OpenCode sessions.

Primary source: the status files the OpenCode plugin (`plugin_js.py`, installed
by `agent-sessions setup --opencode`) writes to `config.OPENCODE_STATUS_DIR`,
one `<ses_id>.json` per session -- `{"status": "busy"|"idle"|"waiting",
"waiting_for": "permission"|"question"|"", "pid", "cwd", "updated_at"}`. The
plugin runs inside the `opencode` process, so `pid` is that process's; a file
whose pid is dead is stale (killed opencode) and is ignored and removed.

Fallback for a session with no usable file (plugin not installed): the
database. A session whose latest message is an assistant message with neither
`time.completed` nor `finish`, updated in the last `FALLBACK_WINDOW` seconds,
while some `opencode` process is running, is reported `busy` (its pid, when
exactly one process matches, else `0`). A crashed run leaves such a row behind
forever, hence both the recency window and the process check. This path cannot
see `waiting`.
"""
import json
import os
import time
from dataclasses import dataclass
from typing import Dict, List, Optional

from ... import config, procs
from ...sessions.model import Session
from . import db as _db

FALLBACK_WINDOW = 120.0
STATUSES = ('busy', 'idle', 'waiting')


@dataclass
class Live:
    session_id: str
    pid: int = 0
    status: str = ''       # 'busy' | 'idle' | 'waiting' | ''
    updated_at: float = 0.0
    waiting_for: str = ''

    @property
    def busy(self) -> bool:
        return self.status == 'busy'


def pid_alive(pid: int) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    return procs.pid_alive(pid)


def read_status_files(status_dir: Optional[str] = None) -> Dict[str, Live]:
    """`{ses_id: Live}` for every status file whose pid is alive. Files of dead
    processes are removed (best effort -- it is our own directory)."""
    status_dir = status_dir or config.OPENCODE_STATUS_DIR
    try:
        names = os.listdir(status_dir)
    except OSError:
        return {}
    out: Dict[str, Live] = {}
    for name in names:
        if not name.endswith('.json') or name.startswith('.'):
            continue
        sid = name[:-len('.json')]
        full = os.path.join(status_dir, name)
        try:
            with open(full, encoding='utf-8') as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(d, dict) or d.get('status') not in STATUSES:
            continue
        pid = d.get('pid')
        if not pid_alive(pid):
            try:
                os.unlink(full)
            except OSError:
                pass
            continue
        updated = d.get('updated_at')
        waiting_for = d.get('waiting_for')
        out[sid] = Live(session_id=sid, pid=pid, status=d['status'],
                        updated_at=float(updated) if isinstance(updated, (int, float)) else 0.0,
                        waiting_for=waiting_for if isinstance(waiting_for, str) else '')
    return out


def is_opencode_program(comm: str) -> bool:
    """Whether a process table's program name is OpenCode's: `opencode`, or `opencode.exe` on
    Windows (any case, as Windows compares names)."""
    name = os.path.basename(comm.strip().replace('\\', '/'))
    if procs.IS_WINDOWS:
        name = name.lower()
        if name.endswith('.exe'):
            name = name[:-len('.exe')]
    return name == 'opencode'


def _opencode_pids() -> List[int]:
    """Pids of running `opencode` processes (best effort, via the process table)."""
    table = procs.process_table('comm')
    return [pid for pid, comm in (table or {}).items() if is_opencode_program(comm)]


def _in_progress(d: '_db.Db', session_id: str) -> bool:
    """The session's latest message is an assistant message that has neither
    `time.completed` nor `finish`."""
    rows = d.query('SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1',
                   (session_id,))
    if not rows:
        return False
    data = _db.loads(rows[0]['data'])
    if data.get('role') != 'assistant':
        return False
    return not (data.get('time') or {}).get('completed') and not data.get('finish')


def _recent_sessions(d: '_db.Db', now: float) -> Dict[str, Session]:
    """The top-level sessions updated within `FALLBACK_WINDOW`, from one indexed
    query (id and time only) instead of a full scan of every listed session."""
    where = ['time_updated > ?']
    if 'parent_id' in d.columns('session'):
        where.append('parent_id IS NULL')
    rows = d.query('SELECT id, time_updated FROM session WHERE %s' % ' AND '.join(where),
                   (int((now - FALLBACK_WINDOW) * 1000),))
    return {r['id']: Session(id=r['id'], name=None, cwd='', mtime=(r['time_updated'] or 0) / 1000.0,
                             path=_db.pseudo_path(r['id']), agent='opencode') for r in rows}


def live_sessions(sessions: Optional[Dict[str, Session]] = None, status_dir: Optional[str] = None,
                  path: Optional[str] = None, now: Optional[float] = None) -> Dict[str, Live]:
    """`{ses_id: Live}`: the plugin's status files first, then the database
    fallback for sessions without one. `sessions` (from `agents.opencode.scan`)
    names the candidates; without it they come from a cheap recent-activity
    query, which is all `json live` needs."""
    out = read_status_files(status_dir)
    now = time.time() if now is None else now
    d = _db.open_db(path)
    if d is None:
        return out
    try:
        if sessions is None:
            sessions = _recent_sessions(d, now)
        recent = [s for sid, s in sessions.items()
                  if sid not in out and now - s.mtime <= FALLBACK_WINDOW]
        candidates = [s for s in recent if _in_progress(d, s.id)]
    finally:
        d.close()
    if not candidates:
        return out
    pids = _opencode_pids()
    if not pids:
        return out
    for s in candidates:
        out[s.id] = Live(session_id=s.id, pid=pids[0] if len(pids) == 1 else 0,
                         status='busy', updated_at=s.mtime)
    return out

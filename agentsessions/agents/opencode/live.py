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
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Dict, List, Optional

from ... import config
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
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True   # e.g. EPERM: it exists, just isn't ours
    return True


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


def _opencode_pids() -> List[int]:
    """Pids of running `opencode` processes (best effort, via `ps`)."""
    ps = shutil.which('ps') or 'ps'
    try:
        out = subprocess.run([ps, '-eo', 'pid=,comm='], stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=5).stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.SubprocessError):
        return []
    pids = []
    for line in out.splitlines():
        pid, _, comm = line.strip().partition(' ')
        if pid.isdigit() and os.path.basename(comm.strip()) == 'opencode':
            pids.append(int(pid))
    return pids


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


def live_sessions(sessions: Dict[str, Session], status_dir: Optional[str] = None,
                  path: Optional[str] = None, now: Optional[float] = None) -> Dict[str, Live]:
    """`{ses_id: Live}`: the plugin's status files first, then the database
    fallback for sessions (from `agents.opencode.scan`) without one."""
    out = read_status_files(status_dir)
    now = time.time() if now is None else now
    recent = [s for sid, s in sessions.items()
              if sid not in out and now - s.mtime <= FALLBACK_WINDOW]
    if not recent:
        return out
    d = _db.open_db(path)
    if d is None:
        return out
    try:
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

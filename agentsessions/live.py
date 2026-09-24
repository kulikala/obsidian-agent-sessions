"""Reads the ledger of running sessions (~/.claude/sessions/<pid>.json)."""
import glob
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Dict, Optional

from . import config, i18n

# Maps a session's raw `status` to the i18n key for its display label.
STATUS_LABEL_KEY = {
    'busy': 'status.busy',
    'shell': 'status.shell',
    'idle': 'status.idle',
    # The value claude itself writes while waiting on a dialog to be answered
    # (AskUserQuestion, a permission prompt, elicitation, etc). `waiting_for` carries the
    # reason.
    'waiting': 'status.waiting',
}


@dataclass
class Live:
    session_id: str
    pid: int
    status: str = ''            # 'busy' | 'shell' | 'idle' | 'waiting' | ''
    updated_at: float = 0.0     # epoch seconds
    entrypoint: str = ''
    kind: str = ''
    rc: bool = False            # under remote control (has a bridgeSessionId)?
    waiting_for: str = ''       # the reason, when status == 'waiting'; '' otherwise

    @property
    def label(self) -> str:
        return i18n.t(STATUS_LABEL_KEY.get(self.status, 'status.unknown'))

    @property
    def busy(self) -> bool:
        return self.status in ('busy', 'shell')


def _ps_path() -> str:
    """The `ps` executable: found via PATH, or `'ps'` if that fails (the caller catches
    the resulting `OSError`).

    `/bin/ps` is the common path on both macOS and Linux, but this doesn't hard-code it —
    it respects PATH instead (some minimal containers lack it, e.g. without procps).
    """
    return shutil.which('ps') or 'ps'


def _claude_pids() -> Optional[set]:
    """The set of pids currently running a claude process. `None` if `ps` isn't usable.

    The ledger can leave a stale entry behind after a session exits, so this checks not
    just whether a pid is alive but whether it's actually claude, to reject a pid that's
    since been reused by an unrelated process.
    `-eo pid=,args=` works on both GNU ps (procps-ng) and BSD ps (macOS).
    """
    try:
        out = subprocess.run([_ps_path(), '-eo', 'pid=,args='],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             timeout=5).stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.SubprocessError):
        return None
    pids = set()
    for line in out.splitlines():
        pid, _, cmd = line.strip().partition(' ')
        if pid.isdigit() and 'claude' in cmd.lower():
            pids.add(int(pid))
    return pids


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def live_sessions(sessions_dir: Optional[str] = None,
                  claude_pids: Optional[set] = None) -> Dict[str, Live]:
    """The currently running claude sessions, as `{session_id: Live}`.

    A stale, already-exited pid left behind in the ledger is filtered out using `ps`'s
    list of claude processes (or, if `ps` isn't usable, by checking the pid's liveness
    alone).
    """
    sessions_dir = sessions_dir if sessions_dir is not None else config.SESSIONS_DIR
    paths = sorted(glob.glob(os.path.join(sessions_dir, '*.json')))
    if not paths:
        return {}
    pids = _claude_pids() if claude_pids is None else claude_pids
    out: Dict[str, Live] = {}
    for p in paths:
        try:
            with open(p, encoding='utf-8') as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(d, dict):
            continue
        sid, pid = d.get('sessionId'), d.get('pid')
        if not isinstance(sid, str) or not isinstance(pid, int):
            continue
        if pids is not None:
            if pid not in pids:
                continue
        elif not _alive(pid):
            continue
        updated = d.get('statusUpdatedAt') or d.get('updatedAt') or d.get('startedAt') or 0
        live = Live(session_id=sid, pid=pid, status=d.get('status') or '',
                    updated_at=float(updated) / 1000.0,
                    entrypoint=d.get('entrypoint') or '', kind=d.get('kind') or '',
                    rc=bool(d.get('bridgeSessionId')),
                    waiting_for=d.get('waitingFor') or '')
        prev = out.get(sid)
        if prev is None or live.updated_at >= prev.updated_at:
            out[sid] = live
    return out

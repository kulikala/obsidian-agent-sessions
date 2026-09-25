"""Busy/idle/waiting detection for Codex sessions.

Codex, unlike Claude Code, doesn't write a status ledger file
(`~/.claude/sessions/<pid>.json`'s equivalent) -- so this reads the tail of the
rollout itself. Status rule (plan/段9-Codex対応.md): the most recent of
`task_started` / `task_complete` / `turn_aborted` / an approval-request event
decides the status -- `task_started` with nothing after it = busy, a
`task_complete`/`turn_aborted` = idle, an approval-request = waiting.

The approval-request event names in `WAITING_EVENTS` are from openai/codex's
codex-rs source (see plan/他エージェント対応-検討.md's `ExecApprovalRequest` /
`ApplyPatchApprovalRequest` / `RequestPermissions`); none of the 62 real local
rollout files (checked 2026-09-25) hit an approval gate, so this branch is
unverified against real data -- worth confirming the actual `event_msg.type`
string next time an approval-gated Codex session is available, rather than
trusting the source-derived name blind.

Process liveness is best-effort, via `ps`: Codex has no per-session pid file, so
a session's pid is inferred by matching a running `codex` process's cwd against
the session's own `cwd` (from `agents.codex.scan`), which can fail to match (a
different invocation style, a moved directory, `ps` unavailable) -- in which
case `pid` stays `0` but the status itself (read straight from the transcript,
not from `ps`) is unaffected.
"""
import json
import shutil
import subprocess
from dataclasses import dataclass
from typing import Dict, Optional

from ...sessions.model import Session
from ...sessions.scan import TAIL_CHUNK, TAIL_LIMIT, iter_tail_lines
from . import rollout

BUSY_EVENT = 'task_started'
IDLE_EVENTS = ('task_complete', 'turn_aborted')
WAITING_EVENTS = ('exec_approval_request', 'apply_patch_approval_request', 'request_permissions')
STATUS_EVENTS = frozenset((BUSY_EVENT,) + IDLE_EVENTS + WAITING_EVENTS)


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


def _status_from_tail(path: str) -> Optional[Live]:
    """The most recent status-relevant event at the tail of `path`, or `None` if
    none is found within `iter_tail_lines`'s scan window."""
    for line in iter_tail_lines(path, TAIL_CHUNK, TAIL_LIMIT):
        if b'"event_msg"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if not isinstance(d, dict) or d.get('type') != 'event_msg':
            continue
        payload = d.get('payload') or {}
        et = payload.get('type')
        if et not in STATUS_EVENTS:
            continue
        updated_at = rollout.parse_ts(d.get('timestamp')) or 0.0
        if et == BUSY_EVENT:
            return Live(session_id='', status='busy', updated_at=updated_at)
        if et in IDLE_EVENTS:
            return Live(session_id='', status='idle', updated_at=updated_at)
        return Live(session_id='', status='waiting', updated_at=updated_at, waiting_for=et)
    return None


def _codex_processes() -> Optional[list]:
    """`[(pid, args)]` for every running process whose command line mentions
    `codex`. `None` if `ps` isn't usable."""
    ps = shutil.which('ps') or 'ps'
    try:
        out = subprocess.run([ps, '-eo', 'pid=,args='], stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=5).stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.SubprocessError):
        return None
    procs = []
    for line in out.splitlines():
        pid, _, cmd = line.strip().partition(' ')
        if pid.isdigit() and 'codex' in cmd.lower():
            procs.append((int(pid), cmd))
    return procs


def live_sessions(sessions: Dict[str, Session]) -> Dict[str, Live]:
    """`{thread_id: Live}` for every session (from `agents.codex.scan.scan`)
    whose tail shows an in-progress or waiting turn. A session whose tail is
    `task_complete`/`turn_aborted` (idle, finished) is left out entirely -- same
    convention as Claude's `live_sessions`, which only lists what's currently or
    recently running, not every known session."""
    procs = _codex_processes()
    out: Dict[str, Live] = {}
    for sid, session in sessions.items():
        live = _status_from_tail(session.path)
        if live is None or live.status == 'idle':
            continue
        live.session_id = sid
        if procs and session.cwd:
            for pid, args in procs:
                if session.cwd in args:
                    live.pid = pid
                    break
        out[sid] = live
    return out

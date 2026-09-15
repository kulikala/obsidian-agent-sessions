"""起動中セッションの台帳（~/.claude/sessions/<pid>.json）を読む。"""
import glob
import json
import os
import subprocess
from dataclasses import dataclass
from typing import Dict, Optional

from . import config

STATUS_LABEL = {
    'busy': '実行中',
    'shell': 'コマンド実行中',
    'idle': '待機中',
}


@dataclass
class Live:
    session_id: str
    pid: int
    status: str = ''            # 'busy' | 'shell' | 'idle' | ''
    updated_at: float = 0.0     # epoch 秒
    entrypoint: str = ''
    kind: str = ''

    @property
    def label(self) -> str:
        return STATUS_LABEL.get(self.status, '起動中')

    @property
    def busy(self) -> bool:
        return self.status in ('busy', 'shell')


def _claude_pids() -> Optional[set]:
    """いま走っている claude プロセスの pid 集合。ps が使えなければ None。

    台帳は終了時に消えないことがあるので、pid の生存だけでなく
    「その pid が claude か」まで見て、pid の使い回しを弾く。
    """
    try:
        out = subprocess.run(['/bin/ps', '-axo', 'pid=,command='],
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
    """いま起動している claude の {session_id: Live}。

    台帳に残った終了済みの pid は、ps の claude プロセス一覧で弾く
    （ps が使えなければ pid の生存だけで判定する）。
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
                    entrypoint=d.get('entrypoint') or '', kind=d.get('kind') or '')
        prev = out.get(sid)
        if prev is None or live.updated_at >= prev.updated_at:
            out[sid] = live
    return out

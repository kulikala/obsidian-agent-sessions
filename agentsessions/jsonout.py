"""`json scan`・`json live`・`json detail`・`json usage` の出力を組み立てる
（D-6 §5・D-30）。"""

import glob
import os
import socket
import time
from typing import List, Optional

from . import cache, config, protocol, store
from .detail import read_detail_for
from .items import OTHER_LABEL_LEN
from .live import live_sessions
from .model import Session, folder_of, split_name
from .scan import list_transcripts, scan
from .usage import collect as collect_usage
from .usage import summarize as summarize_usage

DAEMON_TIMEOUT = 1.0


def _session_dict(s: Session) -> dict:
    if s.name:
        group, label = split_name(s.name)
    else:
        group = None
        label = s.first_prompt[:OTHER_LABEL_LEN] or s.id[:8]
    return {
        'id': s.id,
        'agent': 'claude',
        'name': s.name,
        'group': group,
        'label': label,
        'cwd': s.cwd,
        'folder': folder_of(s.cwd),
        'last_activity': s.mtime,
        'child': s.child,
        'transcript': s.path,
    }


def _store_dict() -> dict:
    # `config.STORE_PATH` はここで読む（`store.load` の既定引数は import 時に
    # 束縛されるため、実行時に差し替えたパスを拾わない）。
    st = store.load(path=config.STORE_PATH)
    return {
        'folded': st.folded,
        'archived': st.archived,
        'pendingRenames': st.pendingRenames,
        'sessions': st.sessions,
    }


def _find_transcripts(session_ids: List[str]) -> List[str]:
    paths = []
    for sid in session_ids:
        paths.extend(glob.glob(os.path.join(config.PROJECTS_DIR, '*', '%s.jsonl' % sid)))
    return paths


def scan_output(only: Optional[List[str]] = None) -> dict:
    # cache.load/save も同じ理由で config.CACHE_PATH を都度渡す。
    cache_path = config.CACHE_PATH
    c = cache.load(path=cache_path)
    if only:
        paths = _find_transcripts(only)
        for p in paths:
            c.pop(p, None)   # --only は再読が目的なので、既存のキャッシュ一致は無視する
        scanned = scan(paths, cache=c)
        cache.save(c, path=cache_path)
        wanted = set(only)
        sessions = [_session_dict(s) for s in scanned.values() if s.id in wanted]
    else:
        paths = list_transcripts(config.PROJECTS_DIR)
        scanned = scan(paths, cache=c)
        # 走査から消えた transcript のキャッシュは持ち越さない
        for p in list(c):
            if p not in paths:
                del c[p]
        cache.save(c, path=cache_path)
        sessions = [_session_dict(s) for s in scanned.values()]
    return {'sessions': sessions, 'store': _store_dict()}


def _recv_json(sock: socket.socket, decoder: protocol.Decoder, deadline: float) -> dict:
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('daemon did not respond in time')
        sock.settimeout(remaining)
        chunk = sock.recv(65536)
        if not chunk:
            raise ConnectionError('daemon closed the connection')
        for kind, payload in decoder.feed(chunk):
            if kind == protocol.FRAME_J:
                return protocol.decode_json(payload)


def daemon_sock_path() -> str:
    return os.environ.get('AGENT_SESSIONS_SOCK') or config.SOCK_PATH


def send_daemon_op(op: str, client: str = 'json', sock_path: Optional[str] = None,
                    **kw) -> Optional[dict]:
    """デーモンへ `hello` → `op` を送り、応答を返す。繋がらなければ `None`
    （デーモンは起動しない）。`json live` の `daemon` 判定とデーモン向けの
    単発の要求（`tui.py` の `forget` など）で使う。"""
    if sock_path is None:
        sock_path = daemon_sock_path()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(DAEMON_TIMEOUT)
        sock.connect(sock_path)
        decoder = protocol.Decoder()
        deadline = time.monotonic() + DAEMON_TIMEOUT

        sock.sendall(protocol.encode_json({'op': 'hello', 'client': client, 'seq': 1}))
        hello = _recv_json(sock, decoder, deadline)
        if not hello.get('ok'):
            return None

        req = {'op': op, 'seq': 2}
        req.update(kw)
        sock.sendall(protocol.encode_json(req))
        return _recv_json(sock, decoder, deadline)
    except (OSError, TimeoutError, ConnectionError, ValueError):
        return None
    finally:
        try:
            sock.close()
        except OSError:
            pass


def _daemon_list() -> dict:
    """デーモンの `list` を引く。動いていなければ（起動はせず）`running:false`。"""
    resp = send_daemon_op('list')
    if resp is None or not resp.get('ok'):
        return {'running': False, 'sessions': []}
    return {'running': True, 'sessions': resp.get('sessions', [])}


def live_output() -> dict:
    live_map = live_sessions()
    live = {
        sid: {
            'status': l.label,
            'pid': l.pid,
            'rc': l.rc,
            'updated_at': l.updated_at,
        }
        for sid, l in live_map.items()
    }
    return {'live': live, 'daemon': _daemon_list()}


def detail_output(session_id: str) -> dict:
    paths = _find_transcripts([session_id])
    d = read_detail_for(paths[0] if paths else None)
    return {'last_user': d.last_user, 'last_assistant': d.last_assistant, 'tools': d.tools,
            'last_command': d.last_command}


def usage_output(session_id: str, from_ts: Optional[float] = None,
                  to_ts: Optional[float] = None) -> dict:
    paths = _find_transcripts([session_id])
    turns = collect_usage(paths[0]) if paths else []
    return summarize_usage(turns, from_ts=from_ts, to_ts=to_ts)

"""Builds the output for `json scan`, `json live`, `json detail`, `json usage`, and
`json stats`."""

import glob
import os
import socket
import time
from typing import List, Optional

from .. import config
from ..daemon import protocol
from ..sessions import cache, store
from ..sessions.detail import read_detail_for
from ..sessions.live import live_sessions
from ..sessions.model import Session, folder_of, split_name
from ..sessions.scan import list_transcripts, scan
from ..tui.items import OTHER_LABEL_LEN
from ..usage import stats
from ..usage.turns import collect as collect_usage
from ..usage.turns import summarize as summarize_usage

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
    # Read `config.STORE_PATH` here, at call time — `store.load`'s default argument is
    # bound at import time, so it wouldn't pick up a path swapped in later (e.g. in tests).
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
    # Same reason as `_store_dict`: pass `config.CACHE_PATH` at call time.
    cache_path = config.CACHE_PATH
    c = cache.load(path=cache_path)
    if only:
        paths = _find_transcripts(only)
        for p in paths:
            c.pop(p, None)   # `--only` exists to force a re-read, so ignore any cache hit
        scanned = scan(paths, cache=c)
        cache.save(c, path=cache_path)
        wanted = set(only)
        sessions = [_session_dict(s) for s in scanned.values() if s.id in wanted]
    else:
        paths = list_transcripts(config.PROJECTS_DIR)
        scanned = scan(paths, cache=c)
        # Drop cache entries for transcripts that no longer show up in the scan.
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
    """Sends `hello` then `op` to the daemon and returns the response, or `None` if it
    can't connect (this never starts the daemon). Used both for `json live`'s `daemon`
    check and for one-off requests to the daemon (e.g. `tui.py`'s `forget`)."""
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
    """Fetches the daemon's `list`. `running: false` if it isn't up (this never starts it)."""
    resp = send_daemon_op('list')
    if resp is None or not resp.get('ok'):
        return {'running': False, 'sessions': []}
    return {'running': True, 'sessions': resp.get('sessions', [])}


def live_output() -> dict:
    live_map = live_sessions()
    live = {
        sid: {
            # The raw value claude itself writes ('busy' | 'shell' | 'idle' | 'waiting' | '').
            'status': l.status,
            # The display label for `status`, in the current UI language (see `i18n.py`).
            'status_label': l.label,
            'pid': l.pid,
            'rc': l.rc,
            'updated_at': l.updated_at,
            # The reason, only present when status == 'waiting' (claude writes this).
            **({'waiting_for': l.waiting_for} if l.waiting_for else {}),
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


def stats_output() -> dict:
    # Same reason as `_store_dict`: pass the config paths at call time.
    return stats.compute(now=time.time(), projects_dir=config.PROJECTS_DIR,
                          status_dir=config.STATUS_DIR, cache_path=config.STATS_CACHE_PATH)

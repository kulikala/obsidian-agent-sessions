"""`agent-sessions daemon [--detach] [--sock PATH] [--runtime-dir DIR] [--idle-exit SEC]`。
`agent-sessions daemon --running-count [--sock PATH]` / `--stop [--sock PATH]`（T-83。
`uninstall.sh` が使う——動いている PTY セッションが無いか確かめてから、デーモンへ
`shutdown` を送る）。

引数解析と起動だけを担う。本体は `daemon.py`。
"""

import argparse
import os
import socket
import sys
import time
from typing import Any, Dict, List, Optional

from . import config, protocol
from .daemon import DEFAULT_IDLE_EXIT, AlreadyRunning, Daemon

SOCK_ENV = 'AGENT_SESSIONS_SOCK'
RUNTIME_DIR_ENV = 'AGENT_SESSIONS_RUNTIME_DIR'
_CONTROL_TIMEOUT = 3.0
_STOP_WAIT = 15.0   # --stop が実際に止まるまで待つ上限（秒）


def _control_request(sock_path: str, op: str, **fields: Any) -> Optional[Dict[str, Any]]:
    """`hello` の後に `op` を 1 つ送り、応答を返す。

    デーモンが動いていない（ソケットに繋がらない）・応答が来ない・壊れているときは
    `None`（＝呼び出し側は「もう止まっている」として扱ってよい）。
    """
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(_CONTROL_TIMEOUT)
        sock.connect(sock_path)
        decoder = protocol.Decoder()
        seq = 0

        def _req(o: str, **kw: Any) -> Optional[Dict[str, Any]]:
            nonlocal seq
            seq += 1
            this_seq = seq
            obj: Dict[str, Any] = {'op': o, 'seq': this_seq}
            obj.update(kw)
            sock.sendall(protocol.encode_json(obj))
            while True:
                data = sock.recv(65536)
                if not data:
                    return None
                for kind, payload in decoder.feed(data):
                    if kind == protocol.FRAME_J:
                        resp = protocol.decode_json(payload)
                        if resp.get('seq') == this_seq:
                            return resp

        hello = _req('hello', client='cli')
        if not hello or not hello.get('ok'):
            return None
        return _req(op, **fields)
    except (OSError, ValueError):
        return None
    finally:
        sock.close()


def _is_reachable(sock_path: str) -> bool:
    """ソケットに繋がるか（`hello` は送らない、`--stop` の待ち合わせ専用の軽い確認）。"""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(0.5)
        sock.connect(sock_path)
        return True
    except OSError:
        return False
    finally:
        sock.close()


def _running_sessions(sock_path: str) -> List[Dict[str, Any]]:
    """動作中（`exited` が `None`）の PTY セッションの一覧。デーモンが動いていなければ空。"""
    resp = _control_request(sock_path, 'list')
    if not resp or not resp.get('ok'):
        return []
    sessions = resp.get('sessions')
    if not isinstance(sessions, list):
        return []
    return [s for s in sessions if isinstance(s, dict) and s.get('exited') is None]


def parse_args(argv: List[str]) -> argparse.Namespace:
    runtime_default = os.environ.get(RUNTIME_DIR_ENV) or config.RUNTIME_DIR
    parser = argparse.ArgumentParser(prog='agent-sessions daemon', description='PTY デーモン')
    parser.add_argument('--detach', action='store_true', help='setsid して pid を出力し戻る')
    parser.add_argument('--sock', default=None, help='ソケットのパス（既定 <runtime-dir>/daemon.sock）')
    parser.add_argument('--runtime-dir', default=runtime_default,
                        help='pid・log・exited.json の置き場（既定 %s）' % runtime_default)
    parser.add_argument('--idle-exit', type=float, default=DEFAULT_IDLE_EXIT,
                        help='動作中 0・接続 0 がこの秒数続いたら終了（既定 %d）' % DEFAULT_IDLE_EXIT)
    parser.add_argument('--running-count', action='store_true',
                        help='動作中の PTY セッション数を出して戻る（デーモンを起動しない。T-83）')
    parser.add_argument('--stop', action='store_true',
                        help='デーモンへ shutdown を送って戻る（動いていなければ何もしない。T-83）')
    ns = parser.parse_args(argv)
    if ns.sock is None:
        ns.sock = os.environ.get(SOCK_ENV) or os.path.join(ns.runtime_dir, 'daemon.sock')
    return ns


def _redirect_to_log(log_path: str) -> None:
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    log = os.open(log_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    os.dup2(log, 1)
    os.dup2(log, 2)
    os.close(log)


def main(args: List[str]) -> int:
    ns = parse_args(args)

    if ns.running_count:
        sys.stdout.write('%d\n' % len(_running_sessions(ns.sock)))
        return 0

    if ns.stop:
        _control_request(ns.sock, 'shutdown')  # 繋がらなければ、もう止まっている。
        # `shutdown` は応答してから終了するので、実際に止まって unix ソケットが
        # 応答しなくなるまで待つ（`uninstall.sh` が安全に symlink・runtime-dir を
        # 片付けられるように）。
        deadline = time.monotonic() + _STOP_WAIT
        while time.monotonic() < deadline and _is_reachable(ns.sock):
            time.sleep(0.05)
        return 0

    d = Daemon(sock_path=ns.sock, runtime_dir=ns.runtime_dir, idle_exit=ns.idle_exit,
               echo_stderr=not ns.detach)
    try:
        d.bind()
    except AlreadyRunning:
        sys.stderr.write('already running: %s\n' % d.pid_path)
        return 1
    except OSError as e:
        sys.stderr.write('cannot start daemon: %s (%s)\n' % (e, d.sock_path))
        return 1
    if ns.detach:
        sys.stdout.flush()
        sys.stderr.flush()
        pid = os.fork()
        if pid > 0:
            sys.stdout.write('%d\n' % pid)
            sys.stdout.flush()
            os._exit(0)
        os.setsid()
        _redirect_to_log(d.log_path)
    d.serve_forever()
    return 0

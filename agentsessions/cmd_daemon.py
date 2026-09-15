"""`agent-sessions daemon [--detach] [--sock PATH] [--runtime-dir DIR] [--idle-exit SEC]`。

引数解析と起動だけを担う。本体は `daemon.py`。
"""

import argparse
import os
import sys
from typing import List

from . import config
from .daemon import DEFAULT_IDLE_EXIT, AlreadyRunning, Daemon

SOCK_ENV = 'AGENT_SESSIONS_SOCK'
RUNTIME_DIR_ENV = 'AGENT_SESSIONS_RUNTIME_DIR'


def parse_args(argv: List[str]) -> argparse.Namespace:
    runtime_default = os.environ.get(RUNTIME_DIR_ENV) or config.RUNTIME_DIR
    parser = argparse.ArgumentParser(prog='agent-sessions daemon', description='PTY デーモン')
    parser.add_argument('--detach', action='store_true', help='setsid して pid を出力し戻る')
    parser.add_argument('--sock', default=None, help='ソケットのパス（既定 <runtime-dir>/daemon.sock）')
    parser.add_argument('--runtime-dir', default=runtime_default,
                        help='pid・log・exited.json の置き場（既定 %s）' % runtime_default)
    parser.add_argument('--idle-exit', type=float, default=DEFAULT_IDLE_EXIT,
                        help='動作中 0・接続 0 がこの秒数続いたら終了（既定 %d）' % DEFAULT_IDLE_EXIT)
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

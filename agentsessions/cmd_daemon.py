"""`agent-sessions daemon [--detach] [--sock PATH] [--runtime-dir DIR] [--idle-exit SEC]`.
`agent-sessions daemon --running-count [--sock PATH]` / `--stop [--sock PATH]`, which
`uninstall.sh` uses to check for live PTY sessions before it sends the daemon a
`shutdown`.

This only parses arguments and starts the daemon; the daemon itself lives in `daemon.py`.
"""

import argparse
import os
import socket
import sys
import time
from typing import Any, Dict, List, Optional

from . import config, i18n, protocol
from .daemon import DEFAULT_IDLE_EXIT, AlreadyRunning, Daemon

SOCK_ENV = 'AGENT_SESSIONS_SOCK'
RUNTIME_DIR_ENV = 'AGENT_SESSIONS_RUNTIME_DIR'
_CONTROL_TIMEOUT = 3.0
_STOP_WAIT = 15.0   # upper bound, in seconds, on how long --stop waits for a real stop


def _control_request(sock_path: str, op: str, **fields: Any) -> Optional[Dict[str, Any]]:
    """Sends `hello` followed by one `op`, and returns the response.

    `None` if the daemon isn't up (can't connect to the socket), doesn't respond, or
    sends something malformed — the caller may treat that as "already stopped".
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
    """Whether the socket is connectable (no `hello` sent — a lightweight check used only
    while `--stop` waits for the daemon to actually go down)."""
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
    """The list of running (`exited` is `None`) PTY sessions. Empty if the daemon isn't up."""
    resp = _control_request(sock_path, 'list')
    if not resp or not resp.get('ok'):
        return []
    sessions = resp.get('sessions')
    if not isinstance(sessions, list):
        return []
    return [s for s in sessions if isinstance(s, dict) and s.get('exited') is None]


def parse_args(argv: List[str]) -> argparse.Namespace:
    runtime_default = os.environ.get(RUNTIME_DIR_ENV) or config.RUNTIME_DIR
    parser = argparse.ArgumentParser(prog='agent-sessions daemon', description='PTY daemon')
    parser.add_argument('--detach', action='store_true', help='setsid, print the pid, and return')
    parser.add_argument('--sock', default=None, help='socket path (default <runtime-dir>/daemon.sock)')
    parser.add_argument('--runtime-dir', default=runtime_default,
                        help='where the pid, log, and exited.json live (default %s)' % runtime_default)
    parser.add_argument('--idle-exit', type=float, default=DEFAULT_IDLE_EXIT,
                        help='exit after this many seconds with 0 running and 0 connections '
                             '(default %d)' % DEFAULT_IDLE_EXIT)
    parser.add_argument('--running-count', action='store_true',
                        help='print the number of running PTY sessions and return '
                             '(never starts the daemon)')
    parser.add_argument('--stop', action='store_true',
                        help='send the daemon a shutdown and return (a no-op if it is not running)')
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
        _control_request(ns.sock, 'shutdown')  # if it's unreachable, it's already stopped
        # `shutdown` responds and then exits, so wait for the Unix socket to actually
        # stop responding (so `uninstall.sh` can safely remove symlinks / the runtime
        # dir afterward).
        deadline = time.monotonic() + _STOP_WAIT
        while time.monotonic() < deadline and _is_reachable(ns.sock):
            time.sleep(0.05)
        return 0

    d = Daemon(sock_path=ns.sock, runtime_dir=ns.runtime_dir, idle_exit=ns.idle_exit,
               echo_stderr=not ns.detach)
    try:
        d.bind()
    except AlreadyRunning:
        sys.stderr.write(i18n.t('cmd.already_running', path=d.pid_path) + '\n')
        return 1
    except OSError as e:
        sys.stderr.write(i18n.t('cmd.cannot_start_daemon', error=e, path=d.sock_path) + '\n')
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

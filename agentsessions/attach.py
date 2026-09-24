"""Attaching to a session from a terminal.

Connects to the daemon with `hello` then `attach` (sending the current terminal size),
and multiplexes the raw-mode terminal (`tty.setraw`) with the socket via `select`.
stdin goes out as `D` (input to the PTY). `D` and `R` are written straight to stdout as
raw bytes (`replayed` is otherwise ignored). `SIGWINCH` sends a `resize`. `Ctrl+\\`
(0x1c) on stdin isn't forwarded to the PTY — it sends `detach`, restores the terminal,
and returns 0. An `exit` event restores the terminal and returns with that exit code
(this never sends `forget` — that's the TUI's job).
"""

import os
import select
import signal
import socket
import sys
import termios
import tty
from typing import Optional

from . import i18n, protocol

DETACH_BYTE = 0x1c   # Ctrl+\
CONNECT_TIMEOUT = 5.0
READ_SIZE = 65536


def handle_frame(kind: bytes, payload: bytes, out_fd: int) -> Optional[int]:
    """Handles one frame received from the socket.

    `D` and `R` are written raw to `out_fd`. Any other `J` frame, including `replayed`,
    is ignored. Returns the exit code only for an `exit` event (`None` otherwise).
    """
    if kind in (protocol.FRAME_D, protocol.FRAME_R):
        if payload:
            os.write(out_fd, payload)
        return None
    if kind == protocol.FRAME_J:
        obj = protocol.decode_json(payload)
        if obj.get('ev') == 'exit':
            code = obj.get('code')
            return code if isinstance(code, int) and not isinstance(code, bool) else -1
    return None


def _terminal_size():
    try:
        size = os.get_terminal_size(sys.stdout.fileno())
    except OSError:
        return 80, 24
    if size.columns < 1 or size.lines < 1:
        return 80, 24
    return size.columns, size.lines


class _Client:
    """One connection while attached. `request` stashes other frames until its own
    response arrives."""

    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.decoder = protocol.Decoder()
        self._seq = 0
        self.pending = []   # (kind, payload) that arrived while waiting on a request

    def request(self, op: str, **extra) -> dict:
        self._seq += 1
        seq = self._seq
        obj = {'op': op, 'seq': seq}
        obj.update(extra)
        self.sock.sendall(protocol.encode_json(obj))
        while True:
            data = self.sock.recv(READ_SIZE)
            if not data:
                raise ConnectionError('daemon closed the connection')
            # Don't return the moment the response is found: keep working through the
            # rest of this feed() batch first, so a later frame in the same recv (`R`,
            # `replayed`, etc) isn't dropped.
            result = None
            for kind, payload in self.decoder.feed(data):
                if result is None and kind == protocol.FRAME_J:
                    obj2 = protocol.decode_json(payload)
                    if obj2.get('seq') == seq:
                        result = obj2
                        continue
                self.pending.append((kind, payload))
            if result is not None:
                return result

    def notify(self, op: str, **extra) -> None:
        self._seq += 1
        obj = {'op': op, 'seq': self._seq}
        obj.update(extra)
        self.sock.sendall(protocol.encode_json(obj))

    def write(self, data: bytes) -> None:
        self.sock.sendall(protocol.encode(protocol.FRAME_D, data))


def run(sid: str, sock_path: str) -> int:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(CONNECT_TIMEOUT)
        sock.connect(sock_path)
        client = _Client(sock)
        hello = client.request('hello', client='tui')
        if not hello.get('ok'):
            sys.stderr.write(i18n.t('attach.hello_failed') + '\n')
            return 1
        cols, rows = _terminal_size()
        resp = client.request('attach', id=sid, cols=cols, rows=rows)
    except (OSError, ConnectionError, ValueError) as e:
        sys.stderr.write(i18n.t('attach.failed', error=e) + '\n')
        sock.close()
        return 1
    if not resp.get('ok'):
        sys.stderr.write(i18n.t('attach.failed', error=resp.get('error', 'failed')) + '\n')
        sock.close()
        return 1

    sock.setblocking(False)
    stdin_fd = sys.stdin.fileno()
    out_fd = sys.stdout.fileno()
    decoder = client.decoder

    try:
        old_attrs = termios.tcgetattr(stdin_fd)
    except termios.error:
        old_attrs = None

    winch_r, winch_w = os.pipe()
    os.set_blocking(winch_r, False)
    os.set_blocking(winch_w, False)

    def _on_winch(signum, frame):
        try:
            os.write(winch_w, b'\x00')
        except OSError:
            pass

    old_handler = signal.signal(signal.SIGWINCH, _on_winch)

    exit_code = None    # the `exit` event's exit code (returns once it arrives)
    error = None        # an abnormal disconnect etc (returns as an error once set)
    try:
        if old_attrs is not None:
            tty.setraw(stdin_fd)

        # Handle any frames (`R`, `replayed`, etc) that arrived while waiting for
        # `attach`'s response, before entering the main loop.
        pending, client.pending = client.pending, []
        for kind, payload in pending:
            code = handle_frame(kind, payload, out_fd)
            if code is not None:
                exit_code = code

        while exit_code is None and error is None:
            rlist, _, _ = select.select([stdin_fd, sock.fileno(), winch_r], [], [])
            if winch_r in rlist:
                try:
                    while os.read(winch_r, 4096):
                        pass
                except (BlockingIOError, OSError):
                    pass
                cols, rows = _terminal_size()
                client.notify('resize', cols=cols, rows=rows)
            if sock.fileno() in rlist:
                try:
                    chunk = sock.recv(READ_SIZE)
                except (BlockingIOError, InterruptedError):
                    chunk = None
                if chunk == b'':
                    error = i18n.t('attach.connection_lost')
                elif chunk:
                    for kind, payload in decoder.feed(chunk):
                        code = handle_frame(kind, payload, out_fd)
                        if code is not None:
                            exit_code = code
                            break
                if exit_code is not None or error is not None:
                    break
            if stdin_fd in rlist:
                data = os.read(stdin_fd, READ_SIZE)
                if not data:
                    break
                if DETACH_BYTE in data:
                    idx = data.index(DETACH_BYTE)
                    if idx:
                        client.write(data[:idx])
                    client.notify('detach')
                    break
                client.write(data)
    finally:
        signal.signal(signal.SIGWINCH, old_handler)
        os.close(winch_r)
        os.close(winch_w)
        if old_attrs is not None:
            termios.tcsetattr(stdin_fd, termios.TCSADRAIN, old_attrs)
        sock.close()

    if error is not None:
        sys.stderr.write(i18n.t('attach.failed', error=error) + '\n')
        return 1
    if exit_code is not None:
        sys.stdout.write(i18n.t('attach.session_ended', code=exit_code) + '\n')
        return exit_code
    return 0

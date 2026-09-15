"""端末からの attach（D-6 §5）。

`hello` → `attach`（現在の端末サイズ）でデーモンへつなぎ、`tty.setraw` した端末と
ソケットを `select` で多重化する。stdin → `D`（PTY への入力）。`D`・`R` はそのまま
stdout へ生で書く（`replayed` は無視）。`SIGWINCH` で `resize` を送る。`Ctrl+\\`
（0x1c）が stdin に来たら PTY へは流さず `detach` を送って端末を戻し 0 で戻る。
`exit` イベントが来たら端末を戻し、終了コードを出して戻る（`forget` は送らない
——TUI 側の仕事）。
"""

import os
import select
import signal
import socket
import sys
import termios
import tty
from typing import Optional

from . import protocol

DETACH_BYTE = 0x1c   # Ctrl+\
CONNECT_TIMEOUT = 5.0
READ_SIZE = 65536


def handle_frame(kind: bytes, payload: bytes, out_fd: int) -> Optional[int]:
    """ソケットから届いた 1 フレームを処理する。

    `D`・`R` は `out_fd` へ生で書く。`replayed` を含むそれ以外の `J` は無視する。
    `exit` イベントだけ、その終了コードを返す（それ以外は `None`）。
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
    """attach 中の 1 接続。`request` は応答が来るまで他のフレームを溜めて待つ。"""

    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.decoder = protocol.Decoder()
        self._seq = 0
        self.pending = []   # request 待ちの間に届いた (kind, payload)

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
            for kind, payload in self.decoder.feed(data):
                if kind == protocol.FRAME_J and protocol.decode_json(payload).get('seq') == seq:
                    return protocol.decode_json(payload)
                self.pending.append((kind, payload))

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
            sys.stderr.write('agent-sessions attach: hello に失敗しました\n')
            return 1
        cols, rows = _terminal_size()
        resp = client.request('attach', id=sid, cols=cols, rows=rows)
    except (OSError, ConnectionError, ValueError) as e:
        sys.stderr.write('agent-sessions attach: %s\n' % e)
        sock.close()
        return 1
    if not resp.get('ok'):
        sys.stderr.write('agent-sessions attach: %s\n' % resp.get('error', 'failed'))
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

    exit_code = None    # `exit` イベントの終了コード（届いたら戻る）
    error = None        # 異常切断など。届いたらエラーとして戻る
    try:
        if old_attrs is not None:
            tty.setraw(stdin_fd)

        # `attach` の応答を待つ間に届いていたフレーム（`R`・`replayed` など）を先に処理する。
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
                    error = 'デーモンとの接続が切れました'
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
        sys.stderr.write('agent-sessions attach: %s\n' % error)
        return 1
    if exit_code is not None:
        sys.stdout.write('セッションは終了しました（code %s）\n' % exit_code)
        return exit_code
    return 0

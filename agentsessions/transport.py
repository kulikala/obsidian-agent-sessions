"""Local stream sockets between the daemon, the CLI and the plugin, on every platform.

On Unix an endpoint is a Unix domain socket at a path (`daemon.sock`, `plugin.sock`), private to
the user through its mode (0600) and its directory (0700).

Windows has no `AF_UNIX` in Python's standard library, so there the same path names a small JSON
file instead, `{"port": N, "token": "<hex>"}`: the listener is a TCP socket on 127.0.0.1, and since
any local user could connect to that, a client must send the token, followed by a newline, before
anything else. The listener side checks it with `TokenGate`. The file lives in the user's runtime
directory, which only that user can read.
"""

import hmac
import json
import os
import secrets
import socket
import sys
from typing import Optional, Tuple

IS_WINDOWS = sys.platform == 'win32'
TOKEN_BYTES = 16
_TOKEN_LINE = TOKEN_BYTES * 2 + 1   # hex digits + '\n'


def read_endpoint(path: str) -> Tuple[int, str]:
    """`(port, token)` from a Windows endpoint file. Raises `OSError` if it's missing or malformed."""
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except ValueError as e:
        raise OSError('bad endpoint file %s: %s' % (path, e))
    if not isinstance(data, dict):
        raise OSError('bad endpoint file %s' % path)
    port, token = data.get('port'), data.get('token')
    if not isinstance(port, int) or isinstance(port, bool) or not isinstance(token, str) or not token:
        raise OSError('bad endpoint file %s' % path)
    return port, token


def _write_endpoint(path: str, port: int, token: str) -> None:
    tmp = '%s.%d.tmp' % (path, os.getpid())
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'port': port, 'token': token, 'pid': os.getpid()}, f)
    os.replace(tmp, path)


def listen(path: str, backlog: int = 16) -> Tuple[socket.socket, Optional[str]]:
    """A non-blocking listening socket for `path`, and the token clients must present (`None` on
    Unix, where the socket file's permissions do that job)."""
    if not IS_WINDOWS:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old_umask = os.umask(0o077)
        try:
            listener.bind(path)
        except BaseException:
            listener.close()
            raise
        finally:
            os.umask(old_umask)
        os.chmod(path, 0o600)
        listener.listen(backlog)
        listener.setblocking(False)
        return listener, None
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind(('127.0.0.1', 0))
        listener.listen(backlog)
        listener.setblocking(False)
        token = secrets.token_hex(TOKEN_BYTES)
        _write_endpoint(path, listener.getsockname()[1], token)
    except BaseException:
        listener.close()
        raise
    return listener, token


def remove(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def connect(path: str, timeout: Optional[float] = None) -> socket.socket:
    """A connected, blocking socket to the endpoint at `path` (token already sent on Windows).
    Raises `OSError` if nothing is listening."""
    if not IS_WINDOWS:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(timeout)
            sock.connect(path)
        except BaseException:
            sock.close()
            raise
        return sock
    port, token = read_endpoint(path)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        sock.connect(('127.0.0.1', port))
        sock.sendall((token + '\n').encode('ascii'))
    except BaseException:
        sock.close()
        raise
    return sock


class TokenGate:
    """Listener-side check of the token line a Windows client sends first. `feed` returns
    `(state, rest)`: state is True once the token matched (rest = bytes after it), False on a
    mismatch (close the connection), None while more bytes are needed."""

    def __init__(self, token: Optional[str]) -> None:
        self._token = token
        self._buf = b''
        self.passed = token is None

    def feed(self, data: bytes) -> Tuple[Optional[bool], bytes]:
        if self.passed:
            return True, data
        self._buf += data
        if len(self._buf) < _TOKEN_LINE:
            return None, b''
        line, rest = self._buf[:_TOKEN_LINE], self._buf[_TOKEN_LINE:]
        self._buf = b''
        assert self._token is not None
        if hmac.compare_digest(line, (self._token + '\n').encode('ascii')):
            self.passed = True
            return True, rest
        return False, b''

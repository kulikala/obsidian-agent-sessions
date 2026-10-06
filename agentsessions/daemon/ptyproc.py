"""A child process on a pseudo terminal, behind one small interface for the daemon's loop.

`spawn()` returns a `PosixPty` (a `pty.fork()` child and its master fd) on Unix and a
`conpty.ConPty` on Windows. Both offer:

- `pid`, `fileno()` — something `select` can wait on for output,
- `read(n)` (raises `BlockingIOError` when nothing is waiting, `b''` at EOF),
- `write(data)` -> bytes taken (may raise `BlockingIOError`),
- `set_size(cols, rows)`,
- `terminate()` (the gentle stop), `kill()` (the forced one), `signal(sig)` (Unix only),
- `poll()` -> the exit code once the child is gone, else `None`,
- `take_stopped()`, `canonical()`, `resume()` — job control (Unix only; see below),
- `close()` (the daemon's end of the terminal), `release()` (all remaining handles).
"""

import errno
import os
import signal
import sys
from typing import Dict, List, Optional

IS_WINDOWS = sys.platform == 'win32'

if not IS_WINDOWS:
    import fcntl
    import pty
    import struct
    import termios


def _set_winsize(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


class PosixPty:
    def __init__(self, argv: List[str], env: Dict[str, str], cwd: str, cols: int, rows: int) -> None:
        pid, master = pty.fork()
        if pid == 0:
            try:
                try:
                    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
                except (ValueError, OSError):
                    pass
                _set_winsize(0, cols, rows)
                os.chdir(cwd)
                os.execvpe(argv[0], argv, env)
            except BaseException as e:  # noqa: BLE001 — no matter what happens, the child must exec or _exit
                try:
                    os.write(2, ('agent-sessions daemon: %s\r\n' % e).encode('utf-8', 'replace'))
                except OSError:
                    pass
            os._exit(127)
        os.set_blocking(master, False)
        self.pid = pid
        self._fd: Optional[int] = master
        self._code: Optional[int] = None
        self._stopped = False

    def fileno(self) -> int:
        assert self._fd is not None
        return self._fd

    def read(self, size: int) -> bytes:
        assert self._fd is not None
        try:
            return os.read(self._fd, size)
        except OSError as e:
            if e.errno == errno.EIO:   # Linux: the slave side is gone
                return b''
            raise

    def write(self, data: bytes) -> int:
        assert self._fd is not None
        return os.write(self._fd, data)

    def set_size(self, cols: int, rows: int) -> None:
        if self._fd is not None:
            _set_winsize(self._fd, cols, rows)

    def signal(self, sig: int) -> None:
        try:
            os.killpg(self.pid, sig)
        except ProcessLookupError:
            pass

    def terminate(self) -> None:
        self.signal(signal.SIGTERM)

    def kill(self) -> None:
        self.signal(signal.SIGKILL)

    def poll(self) -> Optional[int]:
        if self._code is not None:
            return self._code
        try:
            pid, status = os.waitpid(self.pid, os.WNOHANG | os.WUNTRACED)
        except ChildProcessError:
            self._code = -1
            return self._code
        if pid == 0:
            return None
        if os.WIFSTOPPED(status):
            self._stopped = True
            return None
        self._code = os.waitstatus_to_exitcode(status)
        return self._code

    # Job control. The child leads its own session (`pty.fork` calls `setsid`) and there is no shell
    # to `fg` it, so a suspend has to be undone here: `take_stopped()` says whether `poll()` saw the
    # child stopped (`SIGSTOP`, or a `SIGTSTP` that did stop it) since the last call; `canonical()`
    # whether the terminal is back in cooked mode, which is how an agent that suspends itself on
    # Ctrl+Z looks while it waits for `SIGCONT` (its own `SIGTSTP` to an orphaned process group is
    # discarded by the kernel, so it never actually stops); `resume()` sends that `SIGCONT`.

    def take_stopped(self) -> bool:
        if self._code is None:
            self.poll()
        stopped, self._stopped = self._stopped, False
        return stopped

    def canonical(self) -> bool:
        if self._fd is None:
            return False
        try:
            return bool(termios.tcgetattr(self._fd)[3] & termios.ICANON)
        except (termios.error, OSError):
            return False

    def resume(self) -> None:
        self.signal(signal.SIGCONT)

    def close(self) -> None:
        if self._fd is None:
            return
        try:
            os.close(self._fd)
        except OSError:
            pass
        self._fd = None

    def release(self) -> None:
        self.close()


def spawn(argv: List[str], env: Dict[str, str], cwd: str, cols: int, rows: int):
    if IS_WINDOWS:
        from .conpty import ConPty
        return ConPty(argv, env, cwd, cols, rows)
    return PosixPty(argv, env, cwd, cols, rows)

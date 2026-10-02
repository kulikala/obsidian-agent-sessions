"""PTY daemon.

A single-threaded `select` loop waits on the listening socket's connections and
every session's terminal together. There is no blocking I/O (both
sockets and terminals are non-blocking; output is flushed from each
connection's own queue whenever that connection becomes writable).

The listening socket and the terminals are platform-specific and live behind
`transport` (a Unix socket, or loopback TCP plus a token on Windows) and
`ptyproc` (a `pty.fork()` child, or a ConPTY child whose output arrives on a
socket pair on Windows, since Windows' `select` takes sockets only).

- Session: started with `ptyproc.spawn()`; output is buffered as a `deque` of
  chunks (1 MiB total). The same `D` frame is fanned out to every attached
  connection, and input is accepted from any of them.
- Size: the minimum cols and minimum rows across all currently attached
  connections, recomputed on `resize`, `detach`, and disconnect.
- Exit: detected via EOF/`EIO` on the master, or via `SIGCHLD` (delivered
  through a self-pipe; Unix only) followed by the terminal's `poll()`. An exited session is
  kept around until `forget` is called.
- Lifetime: the daemon exits once there are zero running sessions and zero
  connections for `idle_exit` seconds. On exit (idle timeout, `shutdown`,
  or `SIGTERM`), only the records of already-exited sessions are written to
  `exited.json`.
"""

import json
import os
import select
import signal
import socket
import sys
import threading
import time
from collections import deque
from typing import Any, Callable, Deque, Dict, List, Optional, Set

from . import protocol, ptyproc
from .. import config, transport

IS_WINDOWS = sys.platform == 'win32'
if IS_WINDOWS:
    import msvcrt
else:
    import fcntl

# `signal.SIGKILL` doesn't exist on Windows; requests still name it.
SIGKILL = getattr(signal, 'SIGKILL', 9)

VERSION = 1
BUFFER_LIMIT = 1024 * 1024          # Per-session output buffer
SEND_LIMIT = 4 * 1024 * 1024        # Per-connection send queue; exceeding it drops the connection
REPLAY_CHUNK = 64 * 1024            # Max size of a single `R` frame
READ_SIZE = 64 * 1024
KILL_GRACE = 10.0                   # Time from `SIGTERM` to `SIGKILL`
DEFAULT_IDLE_EXIT = 600
NUDGE_DELAY = 0.05                  # Delay before restoring row count after shrinking it by 1 post-replay
FINISH_REAP_WAIT = 0.5              # Max time to wait, at shutdown, for killed children to be reaped


class AlreadyRunning(Exception):
    """Raised when the `flock` on `daemon.pid` can't be acquired (another daemon is already running)."""


class BadRequest(Exception):
    """Raised when a request is malformed. The reply is `{"ok":false,"error":"bad-request"}`."""


def _signal_from(value: Any) -> int:
    if isinstance(value, bool):
        raise BadRequest('signal')
    if isinstance(value, int):
        return value
    if not isinstance(value, str) or not value:
        raise BadRequest('signal')
    name = value.upper()
    if not name.startswith('SIG'):
        name = 'SIG' + name
    if name == 'SIGKILL':
        return SIGKILL
    try:
        return int(getattr(signal, name))
    except (AttributeError, TypeError, ValueError):
        raise BadRequest('signal')


def _int_field(req: Dict[str, Any], key: str, default: Optional[int] = None) -> int:
    value = req.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise BadRequest(key)
    return value


def _str_field(req: Dict[str, Any], key: str) -> str:
    value = req.get(key)
    if not isinstance(value, str) or not value:
        raise BadRequest(key)
    return value


class Session:
    def __init__(self, id: str, agent: str, cwd: str, pid: Optional[int],
                 term: Any, started_at: Optional[float]) -> None:
        self.id = id
        self.agent = agent
        self.cwd = cwd
        self.pid = pid
        self.term = term                  # the `ptyproc` child; None for a record loaded from exited.json
        self.master_open = term is not None
        self.started_at = started_at
        self.clients: Set['Conn'] = set()
        self.chunks: Deque[bytes] = deque()
        self.buffered = 0
        self.inq = bytearray()            # Input queued before it's written to the PTY
        self.exited: Optional[int] = None
        self.exited_at: Optional[float] = None
        self.eof_at: Optional[float] = None    # Master hit EOF but hasn't been reaped yet
        self.kill_at: Optional[float] = None   # Time to send `SIGKILL`, after `SIGTERM` was sent
        self.nudge_at: Optional[float] = None  # Time to restore the row count
        self.cols = 0
        self.rows = 0

    @property
    def running(self) -> bool:
        return self.exited is None

    def append_output(self, data: bytes) -> None:
        self.chunks.append(data)
        self.buffered += len(data)
        while self.buffered > BUFFER_LIMIT and self.chunks:
            self.buffered -= len(self.chunks.popleft())

    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'agent': self.agent,
            'cwd': self.cwd,
            'pid': self.pid,
            'startedAt': self.started_at,
            'clients': len(self.clients),
            'exited': self.exited,
            'exitedAt': self.exited_at,
        }


class Conn:
    def __init__(self, sock: socket.socket, token: Optional[str] = None) -> None:
        self.sock = sock
        self.gate = transport.TokenGate(token)
        self.decoder = protocol.Decoder()
        self.out = bytearray()
        self.attached: Optional[Session] = None
        self.client: Optional[str] = None
        self.cols = 80
        self.rows = 24

    def fileno(self) -> int:
        return self.sock.fileno()


class Daemon:
    def __init__(self, sock_path: str = config.SOCK_PATH, runtime_dir: str = config.RUNTIME_DIR,
                 idle_exit: float = DEFAULT_IDLE_EXIT, echo_stderr: bool = True) -> None:
        self.sock_path = sock_path
        self.runtime_dir = runtime_dir
        self.pid_path = os.path.join(runtime_dir, 'daemon.pid')
        self.log_path = os.path.join(runtime_dir, 'daemon.log')
        self.exited_path = os.path.join(runtime_dir, 'exited.json')
        self.idle_exit = idle_exit
        self.echo_stderr = echo_stderr
        self.sessions: Dict[str, Session] = {}
        self.conns: Dict[int, Conn] = {}
        self._listener: Optional[socket.socket] = None
        self._token: Optional[str] = None
        self._pid_fd: Optional[int] = None
        self._wake_r: Optional[socket.socket] = None
        self._wake_w: Optional[socket.socket] = None
        self._stop: Optional[str] = None
        self._idle_since: Optional[float] = None
        self._ops: Dict[str, Callable[[Conn, int, Dict[str, Any]], None]] = {
            'hello': self._op_hello,
            'list': self._op_list,
            'start': self._op_start,
            'attach': self._op_attach,
            'detach': self._op_detach,
            'resize': self._op_resize,
            'kill': self._op_kill,
            'forget': self._op_forget,
            'shutdown': self._op_shutdown,
        }

    # ---- Startup and shutdown ----------------------------------------------

    def bind(self) -> None:
        """Sets up the runtime directory, the pid lock, `exited.json`, and
        the socket.

        Raises `AlreadyRunning` if the lock can't be acquired.
        """
        os.makedirs(self.runtime_dir, mode=0o700, exist_ok=True)
        os.chmod(self.runtime_dir, 0o700)
        fd = os.open(self.pid_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            if IS_WINDOWS:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            raise AlreadyRunning(self.pid_path)
        self._pid_fd = fd
        try:
            self._load_exited()
            self._listener, self._token = transport.listen(self.sock_path)
        except BaseException:
            os.close(fd)
            self._pid_fd = None
            raise
        # A socket pair rather than a pipe: Windows' `select` only takes sockets.
        self._wake_r, self._wake_w = socket.socketpair()
        self._wake_r.setblocking(False)
        self._wake_w.setblocking(False)

    def close_unstarted(self) -> None:
        """Undoes `bind()` without serving (Windows `--detach` hands the work to a new process)."""
        self._finish_handles()

    def _write_pid(self) -> None:
        assert self._pid_fd is not None
        os.lseek(self._pid_fd, 0, os.SEEK_SET)
        os.write(self._pid_fd, ('%d\n' % os.getpid()).encode('ascii'))
        os.ftruncate(self._pid_fd, os.lseek(self._pid_fd, 0, os.SEEK_CUR))

    def _wake(self, tag: bytes) -> None:
        try:
            if self._wake_w is not None:
                self._wake_w.send(tag)
        except OSError:
            pass

    def _install_signals(self) -> None:
        # Signal handlers can only be installed on the main thread. When the
        # daemon runs on a worker thread instead (as in tests), each tick's
        # `waitpid(WNOHANG)` call picks up exits.
        if threading.current_thread() is not threading.main_thread():
            return
        signal.signal(signal.SIGTERM, lambda *_: self._wake(b'T'))
        signal.signal(signal.SIGINT, lambda *_: self._wake(b'T'))
        if not IS_WINDOWS:
            signal.signal(signal.SIGCHLD, lambda *_: self._wake(b'C'))
            signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    def stop(self, reason: str = 'stop') -> None:
        """Requests shutdown from another thread."""
        self._stop = reason
        self._wake(b'S')

    def serve_forever(self) -> None:
        if self._listener is None:
            self.bind()
        self._write_pid()
        self._install_signals()
        self._log('start pid=%d sock=%s' % (os.getpid(), self.sock_path))
        self._housekeeping(time.time())   # Start the idle timer from the moment the daemon comes up
        try:
            while self._stop is None:
                self._tick()
        finally:
            self._finish()

    def _finish(self) -> None:
        self._log('stop (%s)' % (self._stop or 'error'))
        self._save_exited()
        running = [s for s in self.sessions.values() if s.running and s.term is not None]
        for s in running:
            self._killpg(s, signal.SIGTERM)
        for s in list(self.sessions.values()):
            self._close_master(s)
        deadline = time.time() + FINISH_REAP_WAIT
        while running and time.time() < deadline:
            running = [s for s in running if not self._reap(s, notify=False)]
            if running:
                time.sleep(0.02)
        for conn in list(self.conns.values()):
            self._flush(conn)
            self._close_conn(conn)
        for s in self.sessions.values():
            if s.term is not None and not s.running:
                s.term.release()
        self._finish_handles()

    def _finish_handles(self) -> None:
        if self._listener is not None:
            self._listener.close()
            self._listener = None
        transport.remove(self.sock_path)
        for sock in (self._wake_r, self._wake_w):
            if sock is not None:
                sock.close()
        self._wake_r = self._wake_w = None
        if self._pid_fd is not None:
            if IS_WINDOWS:
                # A locked, open file can't be deleted on Windows: unlock and close first.
                try:
                    os.lseek(self._pid_fd, 0, os.SEEK_SET)
                    msvcrt.locking(self._pid_fd, msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
                os.close(self._pid_fd)
                try:
                    os.unlink(self.pid_path)
                except OSError:
                    pass
            else:
                try:
                    os.unlink(self.pid_path)
                except OSError:
                    pass
                os.close(self._pid_fd)
            self._pid_fd = None

    # ---- exited.json ----------------------------------------------------

    def _load_exited(self) -> None:
        try:
            with open(self.exited_path, 'rb') as f:
                raw = f.read()
        except FileNotFoundError:
            return
        except OSError as e:
            self._log('exited.json: %s' % e)
            return
        records = None
        try:
            data = json.loads(raw.decode('utf-8'))
            if isinstance(data, dict) and all(
                    isinstance(k, str) and isinstance(v, dict) for k, v in data.items()):
                records = data
        except ValueError:
            pass
        if records is None:
            broken = self.exited_path + '.broken-' + time.strftime('%Y%m%d%H%M%S')
            try:
                os.replace(self.exited_path, broken)
            except OSError:
                pass
            self._log('exited.json is broken; moved to %s' % broken)
            return
        for id, rec in records.items():
            s = Session(id, str(rec.get('agent') or ''), str(rec.get('cwd') or ''),
                        rec.get('pid'), None, rec.get('startedAt'))
            code = rec.get('code')
            s.exited = code if isinstance(code, int) and not isinstance(code, bool) else -1
            s.exited_at = rec.get('exitedAt')
            self.sessions[id] = s

    def _save_exited(self) -> None:
        records = {}
        for s in self.sessions.values():
            if s.running:
                continue
            records[s.id] = {
                'code': s.exited, 'exitedAt': s.exited_at,
                'agent': s.agent, 'cwd': s.cwd, 'pid': s.pid, 'startedAt': s.started_at,
            }
        tmp = self.exited_path + '.tmp'
        try:
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(records, f, ensure_ascii=False)
            os.replace(tmp, self.exited_path)
        except OSError as e:
            self._log('exited.json: %s' % e)

    # ---- Logging ------------------------------------------------------------

    def _log(self, msg: str) -> None:
        line = '%s %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg)
        try:
            with open(self.log_path, 'a', encoding='utf-8') as f:
                f.write(line)
        except OSError:
            pass
        if self.echo_stderr:
            try:
                sys.stderr.write(line)
                sys.stderr.flush()
            except (OSError, ValueError):
                pass

    # ---- select loop --------------------------------------------------------

    def _next_timeout(self, now: float) -> float:
        timeout = 1.0
        for s in self.sessions.values():
            if not s.running:
                continue
            if s.eof_at is not None:
                timeout = min(timeout, 0.1)
            for at in (s.kill_at, s.nudge_at):
                if at is not None:
                    timeout = min(timeout, at - now)
        if self._idle_since is not None:
            timeout = min(timeout, self._idle_since + self.idle_exit - now)
        return max(0.0, timeout)

    def _tick(self) -> None:
        now = time.time()
        assert self._listener is not None
        assert self._wake_r is not None
        wake_fd = self._wake_r.fileno()
        rlist: List[int] = [self._listener.fileno(), wake_fd]
        wlist: List[int] = []
        masters: Dict[int, Session] = {}
        for conn in self.conns.values():
            rlist.append(conn.fileno())
            if conn.out:
                wlist.append(conn.fileno())
        for s in self.sessions.values():
            if not s.master_open:
                continue
            fd = s.term.fileno()
            masters[fd] = s
            rlist.append(fd)
            if s.inq:
                wlist.append(fd)
        timeout = self._next_timeout(now)
        if IS_WINDOWS and not wlist:
            # Windows' select can't be woken by a terminal's exit (that arrives on a thread),
            # so poll for it every so often.
            timeout = min(timeout, 0.25)
        rr, ww, _ = select.select(rlist, wlist, [], timeout)
        for fd in ww:
            if fd in self.conns:
                self._flush(self.conns[fd])
            elif fd in masters:
                self._write_master(masters[fd])
        for fd in rr:
            if fd == self._listener.fileno():
                self._accept()
            elif fd == wake_fd:
                self._drain_wake()
            elif fd in self.conns:
                self._read_conn(self.conns[fd])
            elif fd in masters and masters[fd].master_open:
                self._read_master(masters[fd])
        self._housekeeping(time.time())

    def _drain_wake(self) -> None:
        assert self._wake_r is not None
        try:
            while True:
                data = self._wake_r.recv(4096)
                if not data:
                    break
                if b'T' in data and self._stop is None:
                    self._stop = 'sigterm'
        except OSError:
            pass

    def _housekeeping(self, now: float) -> None:
        for s in list(self.sessions.values()):
            if not s.running:
                continue
            if s.term is not None:
                self._reap(s)
            if not s.running:
                continue
            if s.kill_at is not None and now >= s.kill_at:
                s.kill_at = None
                self._killpg(s, SIGKILL)
            if s.nudge_at is not None and now >= s.nudge_at:
                s.nudge_at = None
                if s.master_open and s.cols and s.rows:
                    self._winsize(s, s.cols, s.rows)
        running = any(s.running for s in self.sessions.values())
        if running or self.conns:
            self._idle_since = None
        elif self._idle_since is None:
            self._idle_since = now
        elif now - self._idle_since >= self.idle_exit and self._stop is None:
            self._stop = 'idle'

    # ---- Connections --------------------------------------------------------

    def _accept(self) -> None:
        assert self._listener is not None
        try:
            sock, _ = self._listener.accept()
        except OSError:
            return
        sock.setblocking(False)
        self.conns[sock.fileno()] = Conn(sock, self._token)

    def _close_conn(self, conn: Conn) -> None:
        fd = conn.fileno()
        self._detach(conn)
        self.conns.pop(fd, None)
        try:
            conn.sock.close()
        except OSError:
            pass

    def _read_conn(self, conn: Conn) -> None:
        try:
            data = conn.sock.recv(READ_SIZE)
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            data = b''
        if not data:
            self._close_conn(conn)
            return
        if not conn.gate.passed:
            ok, data = conn.gate.feed(data)
            if ok is False:
                self._log('connection with a bad token; closed')
                self._close_conn(conn)
                return
            if not ok or not data:
                return
        for kind, payload in conn.decoder.feed(data):
            if conn.fileno() not in self.conns:
                break
            if kind == protocol.FRAME_D:
                self._input(conn, payload)
            elif kind == protocol.FRAME_J:
                self._handle_json(conn, payload)

    def _send(self, conn: Conn, frame: bytes) -> None:
        if conn.fileno() not in self.conns:
            return
        conn.out.extend(frame)
        if len(conn.out) > SEND_LIMIT:
            self._log('send queue over limit; dropping connection')
            self._close_conn(conn)
            return
        self._flush(conn)

    def _send_json(self, conn: Conn, obj: Dict[str, Any]) -> None:
        self._send(conn, protocol.encode_json(obj))

    def _flush(self, conn: Conn) -> None:
        while conn.out:
            try:
                n = conn.sock.send(bytes(conn.out[:READ_SIZE]))
            except (BlockingIOError, InterruptedError):
                return
            except OSError:
                self._close_conn(conn)
                return
            del conn.out[:n]

    def _broadcast(self, session: Session, frame: bytes) -> None:
        for conn in list(session.clients):
            self._send(conn, frame)

    # ---- Requests -------------------------------------------------------------

    def _handle_json(self, conn: Conn, payload: bytes) -> None:
        try:
            req = protocol.decode_json(payload)
        except ValueError:
            req = None
        if not isinstance(req, dict):
            self._send_json(conn, {'ok': False, 'error': 'bad-request'})
            return
        seq = req.get('seq')
        if isinstance(seq, bool) or not isinstance(seq, int):
            self._send_json(conn, {'ok': False, 'error': 'bad-request'})
            return
        handler = self._ops.get(req.get('op'))
        if handler is None:
            self._reply(conn, seq, {'ok': False, 'error': 'unknown-op'})
            return
        try:
            handler(conn, seq, req)
        except BadRequest:
            self._reply(conn, seq, {'ok': False, 'error': 'bad-request'})

    def _reply(self, conn: Conn, seq: int, obj: Dict[str, Any]) -> None:
        obj = dict(obj)
        obj['seq'] = seq
        self._send_json(conn, obj)

    def _session_of(self, req: Dict[str, Any]) -> Optional[Session]:
        return self.sessions.get(_str_field(req, 'id'))

    def _op_hello(self, conn: Conn, seq: int, req: Dict[str, Any]) -> None:
        client = req.get('client')
        conn.client = client if isinstance(client, str) else None
        self._reply(conn, seq, {'ok': True, 'version': VERSION, 'pid': os.getpid()})

    def _op_list(self, conn: Conn, seq: int, req: Dict[str, Any]) -> None:
        self._reply(conn, seq, {'ok': True, 'sessions': [s.to_dict() for s in self.sessions.values()]})

    def _op_start(self, conn: Conn, seq: int, req: Dict[str, Any]) -> None:
        id = _str_field(req, 'id')
        agent = _str_field(req, 'agent')
        cwd = _str_field(req, 'cwd')
        argv = req.get('argv')
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
            raise BadRequest('argv')
        env_in = req.get('env', {})
        if env_in is None:
            env_in = {}
        if not isinstance(env_in, dict):
            raise BadRequest('env')
        cols = _int_field(req, 'cols', 80)
        rows = _int_field(req, 'rows', 24)
        if id in self.sessions:
            self._reply(conn, seq, {'ok': False, 'error': 'exists'})
            return
        env = {str(k): str(v) for k, v in env_in.items()}
        env['TERM'] = 'xterm-256color'
        env['COLORTERM'] = 'truecolor'
        env['AGENT_SESSIONS_ID'] = id
        try:
            term = ptyproc.spawn(argv, env, cwd, cols, rows)
        except OSError as e:
            # Unix reports a bad command from the child (exit 127); Windows can only fail here.
            self._log('start %s failed: %s' % (id, e))
            self._reply(conn, seq, {'ok': False, 'error': 'spawn-failed', 'message': str(e)})
            return
        s = Session(id, agent, cwd, term.pid, term, time.time())
        self.sessions[id] = s
        self._winsize(s, cols, rows)
        self._log('start %s pid=%d argv=%r cwd=%s' % (id, term.pid, argv, cwd))
        self._reply(conn, seq, {'ok': True})

    def _op_attach(self, conn: Conn, seq: int, req: Dict[str, Any]) -> None:
        s = self._session_of(req)
        if s is None:
            self._reply(conn, seq, {'ok': False, 'error': 'no-session'})
            return
        cols = _int_field(req, 'cols', conn.cols)
        rows = _int_field(req, 'rows', conn.rows)
        if conn.attached is not None and conn.attached is not s:
            self._detach(conn)
        conn.cols, conn.rows = cols, rows
        conn.attached = s
        s.clients.add(conn)
        size_before = (s.cols, s.rows)
        self._apply_size(s)
        size_changed = (s.cols, s.rows) != size_before
        self._reply(conn, seq, {'ok': True, 'exited': s.exited})
        pending = bytearray()
        for chunk in s.chunks:
            pending.extend(chunk)
            if len(pending) >= REPLAY_CHUNK:
                self._send(conn, protocol.encode(protocol.FRAME_R, bytes(pending)))
                pending = bytearray()
        if pending:
            self._send(conn, protocol.encode(protocol.FRAME_R, bytes(pending)))
        self._send_json(conn, {'ev': 'replayed'})
        if not s.running:
            self._send_json(conn, {'ev': 'exit', 'id': s.id, 'code': s.exited})
            return
        # Only when attach changes the size do we shrink the row count by 1
        # after replay and then restore it — this forces a SIGWINCH so the
        # bottom of the screen gets redrawn. If the size is unchanged, no
        # SIGWINCH is emitted: Claude Code redraws the whole screen on
        # SIGWINCH, which would wipe out the screen we just replayed.
        if size_changed and s.master_open and s.rows > 1:
            try:
                s.term.set_size(s.cols, s.rows - 1)
            except OSError:
                pass
            s.nudge_at = time.time() + NUDGE_DELAY

    def _op_detach(self, conn: Conn, seq: int, req: Dict[str, Any]) -> None:
        self._detach(conn)
        self._reply(conn, seq, {'ok': True})

    def _op_resize(self, conn: Conn, seq: int, req: Dict[str, Any]) -> None:
        conn.cols = _int_field(req, 'cols', conn.cols)
        conn.rows = _int_field(req, 'rows', conn.rows)
        if conn.attached is not None:
            self._apply_size(conn.attached)
        self._reply(conn, seq, {'ok': True})

    def _op_kill(self, conn: Conn, seq: int, req: Dict[str, Any]) -> None:
        s = self._session_of(req)
        sig = _signal_from(req.get('signal', 'TERM'))
        if s is None:
            self._reply(conn, seq, {'ok': False, 'error': 'no-session'})
            return
        if s.running and s.term is not None:
            self._killpg(s, sig)
            if sig == signal.SIGTERM and s.kill_at is None:
                s.kill_at = time.time() + KILL_GRACE
        self._reply(conn, seq, {'ok': True})

    def _op_forget(self, conn: Conn, seq: int, req: Dict[str, Any]) -> None:
        s = self._session_of(req)
        if s is None:
            self._reply(conn, seq, {'ok': False, 'error': 'no-session'})
            return
        if s.running:
            self._reply(conn, seq, {'ok': False, 'error': 'running'})
            return
        for c in list(s.clients):
            self._detach(c)
        del self.sessions[s.id]
        self._log('forget %s' % s.id)
        self._reply(conn, seq, {'ok': True})

    def _op_shutdown(self, conn: Conn, seq: int, req: Dict[str, Any]) -> None:
        self._reply(conn, seq, {'ok': True})
        if self._stop is None:
            self._stop = 'shutdown'

    # ---- Attach and sizing ----------------------------------------------------

    def _detach(self, conn: Conn) -> None:
        s = conn.attached
        if s is None:
            return
        conn.attached = None
        s.clients.discard(conn)
        self._apply_size(s)

    def _apply_size(self, s: Session) -> None:
        if not s.clients:
            return
        cols = min(c.cols for c in s.clients)
        rows = min(c.rows for c in s.clients)
        if (cols, rows) != (s.cols, s.rows) or s.nudge_at is not None:
            s.nudge_at = None
            self._winsize(s, cols, rows)

    def _winsize(self, s: Session, cols: int, rows: int) -> None:
        s.cols, s.rows = cols, rows
        if not s.master_open:
            return
        try:
            s.term.set_size(cols, rows)
        except OSError:
            pass

    # ---- PTY ------------------------------------------------------------------

    def _input(self, conn: Conn, data: bytes) -> None:
        s = conn.attached
        if s is None or not s.master_open:
            return
        s.inq.extend(data)
        self._write_master(s)

    def _write_master(self, s: Session) -> None:
        while s.inq and s.master_open:
            try:
                n = s.term.write(bytes(s.inq[:READ_SIZE]))
            except (BlockingIOError, InterruptedError):
                return
            except OSError:
                s.inq.clear()
                return
            del s.inq[:n]

    def _read_master(self, s: Session) -> None:
        if not s.master_open:
            return
        try:
            data = s.term.read(READ_SIZE)
        except (BlockingIOError, InterruptedError):
            return
        except OSError as e:
            self._log('read %s: %s' % (s.id, e))
            data = b''
        if not data:
            self._close_master(s)
            if s.eof_at is None:
                s.eof_at = time.time()
            self._reap(s)
            return
        s.append_output(data)
        self._broadcast(s, protocol.encode(protocol.FRAME_D, data))

    def _drain_master(self, s: Session) -> None:
        """Drains any output still left on the master after an exit has
        already been detected."""
        while s.master_open:
            try:
                data = s.term.read(READ_SIZE)
            except (BlockingIOError, InterruptedError, OSError):
                break
            if not data:
                break
            s.append_output(data)
            self._broadcast(s, protocol.encode(protocol.FRAME_D, data))

    def _close_master(self, s: Session) -> None:
        if not s.master_open:
            return
        s.term.close()
        s.master_open = False
        s.inq.clear()

    def _killpg(self, s: Session, sig: int) -> None:
        if s.term is None:
            return
        try:
            if sig == signal.SIGTERM:
                s.term.terminate()
            elif sig == SIGKILL:
                s.term.kill()
            elif not IS_WINDOWS:
                s.term.signal(sig)
        except OSError as e:
            self._log('kill %s: %s' % (s.id, e))

    def _reap(self, s: Session, notify: bool = True) -> bool:
        """Polls the child. If it has exited, performs exit cleanup and returns True."""
        if not s.running or s.term is None:
            return True
        try:
            code = s.term.poll()
        except OSError:
            code = -1
        if code is None:
            return False
        self._drain_master(s)
        self._close_master(s)
        s.term.release()
        s.exited = code
        s.exited_at = time.time()
        s.kill_at = None
        s.nudge_at = None
        s.eof_at = None
        self._log('exit %s code=%s' % (s.id, code))
        if notify:
            self._broadcast(s, protocol.encode_json({'ev': 'exit', 'id': s.id, 'code': code}))
        return True

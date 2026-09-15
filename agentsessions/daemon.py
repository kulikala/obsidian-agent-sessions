"""PTY デーモン（D-4 §4.1・D-5 §4.2）。

1 スレッドの `select` ループで Unix ソケットの接続と各セッションの PTY master を
まとめて待つ。ブロッキング I/O は無い（ソケット・master とも非ブロッキング、
送信は接続ごとのキューを書込み可のときに流す）。

- セッション：`pty.fork()` で起動し、出力を `deque` のチャンク列（合計 1 MiB）に
  貯める。attach した接続へは同じ `D` を配り、入力はどの接続からでも受ける。
- サイズ：attach 中の全接続の最小 cols・最小 rows。`resize`・`detach`・切断で再計算。
- 終了：master の EOF／`EIO`、または `SIGCHLD`（self-pipe）→ `waitpid(WNOHANG)`。
  終了済みは `forget` されるまで保持する。
- 寿命：動作中 0 かつ接続 0 が `idle_exit` 秒続いたら終了。終了時（アイドル・
  `shutdown`・`SIGTERM`）は既に終了済みの記録だけを `exited.json` に書く。
"""

import argparse
import errno
import fcntl
import json
import os
import pty
import select
import signal
import socket
import struct
import sys
import termios
import threading
import time
from collections import deque
from typing import Any, Callable, Deque, Dict, List, Optional, Set

from . import config, protocol

VERSION = 1
BUFFER_LIMIT = 1024 * 1024          # セッション毎の出力バッファ
SEND_LIMIT = 4 * 1024 * 1024        # 接続毎の送信キュー。超えたら切る
REPLAY_CHUNK = 64 * 1024            # `R` フレーム 1 つの上限
READ_SIZE = 64 * 1024
KILL_GRACE = 10.0                   # `SIGTERM` から `SIGKILL` まで
DEFAULT_IDLE_EXIT = 600
NUDGE_DELAY = 0.05                  # 再生後に行数を 1 減らしてから戻すまで
FINISH_REAP_WAIT = 0.5              # 終了時、kill した子を回収するまで待つ上限

SOCK_ENV = 'AGENT_SESSIONS_SOCK'
RUNTIME_DIR_ENV = 'AGENT_SESSIONS_RUNTIME_DIR'


class AlreadyRunning(Exception):
    """`daemon.pid` の `flock` が取れない（別のデーモンが動いている）。"""


class BadRequest(Exception):
    """要求の形が違う。応答は `{"ok":false,"error":"bad-request"}`。"""


def _set_winsize(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


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
                 master_fd: Optional[int], started_at: Optional[float]) -> None:
        self.id = id
        self.agent = agent
        self.cwd = cwd
        self.pid = pid
        self.master_fd = master_fd
        self.started_at = started_at
        self.clients: Set['Conn'] = set()
        self.chunks: Deque[bytes] = deque()
        self.buffered = 0
        self.inq = bytearray()            # PTY へ書く前の入力
        self.exited: Optional[int] = None
        self.exited_at: Optional[float] = None
        self.eof_at: Optional[float] = None    # master が EOF になったが未回収
        self.kill_at: Optional[float] = None   # `SIGTERM` 後、`SIGKILL` を送る時刻
        self.nudge_at: Optional[float] = None  # 行数を戻す時刻
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
    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
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
        self._pid_fd: Optional[int] = None
        self._wake_r = -1
        self._wake_w = -1
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

    # ---- 起動と終了 -------------------------------------------------------

    def bind(self) -> None:
        """実行時ディレクトリ・pid のロック・`exited.json`・ソケットを用意する。

        ロックが取れなければ `AlreadyRunning`。
        """
        os.makedirs(self.runtime_dir, mode=0o700, exist_ok=True)
        os.chmod(self.runtime_dir, 0o700)
        fd = os.open(self.pid_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            raise AlreadyRunning(self.pid_path)
        self._pid_fd = fd
        try:
            self._load_exited()
            self._listener = self._listen()
        except BaseException:
            os.close(fd)
            self._pid_fd = None
            raise
        self._wake_r, self._wake_w = os.pipe()
        os.set_blocking(self._wake_r, False)
        os.set_blocking(self._wake_w, False)

    def _listen(self) -> socket.socket:
        try:
            os.unlink(self.sock_path)
        except FileNotFoundError:
            pass
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old_umask = os.umask(0o077)
        try:
            listener.bind(self.sock_path)
        except BaseException:
            listener.close()
            raise
        finally:
            os.umask(old_umask)
        os.chmod(self.sock_path, 0o600)
        listener.listen(16)
        listener.setblocking(False)
        return listener

    def _write_pid(self) -> None:
        assert self._pid_fd is not None
        os.ftruncate(self._pid_fd, 0)
        os.lseek(self._pid_fd, 0, os.SEEK_SET)
        os.write(self._pid_fd, ('%d\n' % os.getpid()).encode('ascii'))

    def _wake(self, tag: bytes) -> None:
        try:
            os.write(self._wake_w, tag)
        except OSError:
            pass

    def _install_signals(self) -> None:
        # シグナルハンドラはメインスレッドでしか置けない。スレッドで動かすとき
        # （テスト）は毎周の `waitpid(WNOHANG)` が終了を拾う。
        if threading.current_thread() is not threading.main_thread():
            return
        signal.signal(signal.SIGCHLD, lambda *_: self._wake(b'C'))
        signal.signal(signal.SIGTERM, lambda *_: self._wake(b'T'))
        signal.signal(signal.SIGINT, lambda *_: self._wake(b'T'))
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    def stop(self, reason: str = 'stop') -> None:
        """別スレッドから終了を頼む。"""
        self._stop = reason
        self._wake(b'S')

    def serve_forever(self) -> None:
        if self._listener is None:
            self.bind()
        self._write_pid()
        self._install_signals()
        self._log('start pid=%d sock=%s' % (os.getpid(), self.sock_path))
        try:
            while self._stop is None:
                self._tick()
        finally:
            self._finish()

    def _finish(self) -> None:
        self._log('stop (%s)' % (self._stop or 'error'))
        self._save_exited()
        running = [s for s in self.sessions.values() if s.running and s.pid is not None]
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
        if self._listener is not None:
            self._listener.close()
            self._listener = None
        try:
            os.unlink(self.sock_path)
        except OSError:
            pass
        for fd in (self._wake_r, self._wake_w):
            if fd >= 0:
                os.close(fd)
        self._wake_r = self._wake_w = -1
        if self._pid_fd is not None:
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

    # ---- ログ -------------------------------------------------------------

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

    # ---- select ループ ------------------------------------------------------

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
        rlist: List[int] = [self._listener.fileno(), self._wake_r]
        wlist: List[int] = []
        masters: Dict[int, Session] = {}
        for conn in self.conns.values():
            rlist.append(conn.fileno())
            if conn.out:
                wlist.append(conn.fileno())
        for s in self.sessions.values():
            if s.master_fd is None:
                continue
            masters[s.master_fd] = s
            rlist.append(s.master_fd)
            if s.inq:
                wlist.append(s.master_fd)
        rr, ww, _ = select.select(rlist, wlist, [], self._next_timeout(now))
        for fd in ww:
            if fd in self.conns:
                self._flush(self.conns[fd])
            elif fd in masters:
                self._write_master(masters[fd])
        for fd in rr:
            if fd == self._listener.fileno():
                self._accept()
            elif fd == self._wake_r:
                self._drain_wake()
            elif fd in self.conns:
                self._read_conn(self.conns[fd])
            elif fd in masters and masters[fd].master_fd == fd:
                self._read_master(masters[fd])
        self._housekeeping(time.time())

    def _drain_wake(self) -> None:
        try:
            while True:
                data = os.read(self._wake_r, 4096)
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
            if s.pid is not None:
                self._reap(s)
            if not s.running:
                continue
            if s.kill_at is not None and now >= s.kill_at:
                s.kill_at = None
                self._killpg(s, signal.SIGKILL)
            if s.nudge_at is not None and now >= s.nudge_at:
                s.nudge_at = None
                if s.master_fd is not None and s.cols and s.rows:
                    self._winsize(s, s.cols, s.rows)
        running = any(s.running for s in self.sessions.values())
        if running or self.conns:
            self._idle_since = None
        elif self._idle_since is None:
            self._idle_since = now
        elif now - self._idle_since >= self.idle_exit and self._stop is None:
            self._stop = 'idle'

    # ---- 接続 -------------------------------------------------------------

    def _accept(self) -> None:
        assert self._listener is not None
        try:
            sock, _ = self._listener.accept()
        except OSError:
            return
        sock.setblocking(False)
        self.conns[sock.fileno()] = Conn(sock)

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

    # ---- 要求 -------------------------------------------------------------

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
            except BaseException as e:  # noqa: BLE001 — 子は何があっても exec か _exit
                try:
                    os.write(2, ('agent-sessions daemon: %s\r\n' % e).encode('utf-8', 'replace'))
                except OSError:
                    pass
            os._exit(127)
        os.set_blocking(master, False)
        s = Session(id, agent, cwd, pid, master, time.time())
        self.sessions[id] = s
        self._winsize(s, cols, rows)
        self._log('start %s pid=%d argv=%r cwd=%s' % (id, pid, argv, cwd))
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
        self._apply_size(s)
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
        # 再生の後、行数を 1 減らしてから戻す（SIGWINCH で画面下部を描き直させる）。
        if s.master_fd is not None and s.rows > 1:
            try:
                _set_winsize(s.master_fd, s.cols, s.rows - 1)
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
        if s.running and s.pid is not None:
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

    # ---- attach・サイズ ------------------------------------------------------

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
        if s.master_fd is None:
            return
        try:
            _set_winsize(s.master_fd, cols, rows)
        except OSError:
            pass

    # ---- PTY --------------------------------------------------------------

    def _input(self, conn: Conn, data: bytes) -> None:
        s = conn.attached
        if s is None or s.master_fd is None:
            return
        s.inq.extend(data)
        self._write_master(s)

    def _write_master(self, s: Session) -> None:
        while s.inq and s.master_fd is not None:
            try:
                n = os.write(s.master_fd, bytes(s.inq[:READ_SIZE]))
            except (BlockingIOError, InterruptedError):
                return
            except OSError:
                s.inq.clear()
                return
            del s.inq[:n]

    def _read_master(self, s: Session) -> None:
        if s.master_fd is None:
            return
        try:
            data = os.read(s.master_fd, READ_SIZE)
        except (BlockingIOError, InterruptedError):
            return
        except OSError as e:
            if e.errno == errno.EIO:
                data = b''
            else:
                self._log('read %s: %s' % (s.id, e))
                data = b''
        if not data:
            self._close_master(s)
            if s.eof_at is None:
                s.eof_at = time.time()
            if s.pid is not None:
                self._reap(s)
            return
        s.append_output(data)
        self._broadcast(s, protocol.encode(protocol.FRAME_D, data))

    def _drain_master(self, s: Session) -> None:
        """終了を先に検知したとき、master に残る出力を読み切る。"""
        while s.master_fd is not None:
            try:
                data = os.read(s.master_fd, READ_SIZE)
            except (BlockingIOError, InterruptedError, OSError):
                break
            if not data:
                break
            s.append_output(data)
            self._broadcast(s, protocol.encode(protocol.FRAME_D, data))

    def _close_master(self, s: Session) -> None:
        if s.master_fd is None:
            return
        try:
            os.close(s.master_fd)
        except OSError:
            pass
        s.master_fd = None
        s.inq.clear()

    def _killpg(self, s: Session, sig: int) -> None:
        if s.pid is None:
            return
        try:
            os.killpg(s.pid, sig)
        except ProcessLookupError:
            pass
        except OSError as e:
            self._log('kill %s: %s' % (s.id, e))

    def _reap(self, s: Session, notify: bool = True) -> bool:
        """`waitpid(WNOHANG)`。回収できたら終了の後始末をして True。"""
        if not s.running or s.pid is None:
            return True
        try:
            pid, status = os.waitpid(s.pid, os.WNOHANG)
        except ChildProcessError:
            pid, status = s.pid, None
        if pid == 0:
            return False
        code = -1 if status is None else os.waitstatus_to_exitcode(status)
        self._drain_master(s)
        self._close_master(s)
        s.exited = code
        s.exited_at = time.time()
        s.kill_at = None
        s.nudge_at = None
        s.eof_at = None
        self._log('exit %s code=%s' % (s.id, code))
        if notify:
            self._broadcast(s, protocol.encode_json({'ev': 'exit', 'id': s.id, 'code': code}))
        return True


# ---- CLI ------------------------------------------------------------------


def _parse_args(argv: List[str]) -> argparse.Namespace:
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


def main(argv: List[str]) -> int:
    ns = _parse_args(argv)
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

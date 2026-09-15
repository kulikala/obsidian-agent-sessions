import json
import os
import shutil
import socket
import stat
import tempfile
import threading
import time
import unittest

from agentsessions import daemon, protocol

TIMEOUT = 5.0
KIB = 1024
MIB = 1024 * KIB


class Client:
    """テスト用の同期クライアント。応答以外のフレームは `events` に貯める。"""

    def __init__(self, sock_path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(TIMEOUT)
        self.sock.connect(sock_path)
        self.decoder = protocol.Decoder()
        self.events = []
        self.seq = 0

    def close(self):
        self.sock.close()

    def send_raw(self, frame):
        self.sock.sendall(frame)

    def send_json(self, obj):
        self.send_raw(protocol.encode_json(obj))

    def write(self, data):
        self.send_raw(protocol.encode(protocol.FRAME_D, data))

    def frame(self):
        """次のフレームを 1 つ返す（`events` に貯まっていればそれから）。"""
        while not self.events:
            data = self.sock.recv(65536)
            if not data:
                raise EOFError('closed')
            self.events.extend(self.decoder.feed(data))
        return self.events.pop(0)

    def request(self, op, **args):
        self.seq += 1
        seq = self.seq
        self.send_json(dict(op=op, seq=seq, **args))
        deadline = time.monotonic() + TIMEOUT
        stash = []
        while time.monotonic() < deadline:
            kind, payload = self.frame()
            if kind == protocol.FRAME_J:
                obj = protocol.decode_json(payload)
                if obj.get('seq') == seq:
                    self.events[:0] = stash
                    return obj
            stash.append((kind, payload))
        raise TimeoutError('no reply for %s' % op)

    def wait_event(self, ev):
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            kind, payload = self.frame()
            if kind == protocol.FRAME_J:
                obj = protocol.decode_json(payload)
                if obj.get('ev') == ev:
                    return obj
        raise TimeoutError('no event %s' % ev)

    def read_output(self, until, kinds=(protocol.FRAME_D,)):
        """`D`（既定）を `until(bytes)` が真になるまで集める。"""
        got = bytearray()
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            if until(bytes(got)):
                return bytes(got)
            kind, payload = self.frame()
            if kind in kinds:
                got.extend(payload)
        raise TimeoutError('output: %r' % bytes(got[:200]))

    def collect(self, seconds):
        """`seconds` のあいだに届いた `D` を集める（届かなくても例外にしない）。"""
        got = bytearray()
        deadline = time.monotonic() + seconds
        self.sock.settimeout(0.05)
        try:
            while time.monotonic() < deadline:
                try:
                    kind, payload = self.frame()
                except socket.timeout:
                    continue
                if kind == protocol.FRAME_D:
                    got.extend(payload)
        finally:
            self.sock.settimeout(TIMEOUT)
        return bytes(got)

    def replay(self):
        """attach の直後の `R`… → `replayed` を集めて再生バイト列を返す。"""
        got = bytearray()
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            kind, payload = self.frame()
            if kind == protocol.FRAME_R:
                got.extend(payload)
            elif kind == protocol.FRAME_J and protocol.decode_json(payload).get('ev') == 'replayed':
                return bytes(got)
        raise TimeoutError('no replayed')


class DaemonHarness:
    def __init__(self, runtime_dir, idle_exit=600):
        self.runtime_dir = runtime_dir
        self.sock_path = os.path.join(runtime_dir, 'daemon.sock')
        self.daemon = daemon.Daemon(sock_path=self.sock_path, runtime_dir=runtime_dir,
                                    idle_exit=idle_exit, echo_stderr=False)
        self.daemon.bind()
        self.thread = threading.Thread(target=self.daemon.serve_forever, daemon=True)
        self.thread.start()
        self.clients = []

    def client(self):
        c = Client(self.sock_path)
        self.clients.append(c)
        return c

    def stop(self):
        for c in self.clients:
            c.close()
        self.clients = []
        if self.thread.is_alive():
            self.daemon.stop()
            self.thread.join(TIMEOUT)

    def shutdown_via_op(self):
        c = self.client()
        res = c.request('shutdown')
        self.thread.join(TIMEOUT)
        return res


class DaemonTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix='agsd-')
        self.h = DaemonHarness(self.tmpdir)

    def tearDown(self):
        self.h.stop()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def start_cat(self, c, id='s1', cols=80, rows=24):
        res = c.request('start', id=id, agent='test', cwd=self.tmpdir, argv=['/bin/cat'],
                        env={'PATH': '/usr/bin:/bin'}, cols=cols, rows=rows)
        self.assertTrue(res['ok'], res)
        return res

    def wait_exited(self, c, id):
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            rows = c.request('list')['sessions']
            for s in rows:
                if s['id'] == id and s['exited'] is not None:
                    return s
            time.sleep(0.02)
        raise TimeoutError('not exited')


class TestBasics(DaemonTestCase):
    def test_socket_and_runtime_dir_permissions(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.tmpdir).st_mode), 0o700)
        st = os.stat(self.h.sock_path)
        self.assertTrue(stat.S_ISSOCK(st.st_mode))
        self.assertEqual(stat.S_IMODE(st.st_mode), 0o600)
        with open(os.path.join(self.tmpdir, 'daemon.pid')) as f:
            self.assertEqual(int(f.read().strip()), os.getpid())

    def test_hello_and_empty_list(self):
        c = self.h.client()
        res = c.request('hello', client='plugin')
        self.assertEqual(res, {'ok': True, 'seq': 1, 'version': 1, 'pid': os.getpid()})
        self.assertEqual(c.request('list')['sessions'], [])

    def test_bad_request_and_unknown_op(self):
        c = self.h.client()
        c.send_json({'op': 'list'})
        kind, payload = c.frame()
        self.assertEqual(protocol.decode_json(payload), {'ok': False, 'error': 'bad-request'})
        c.send_raw(protocol.encode(protocol.FRAME_J, b'{not json'))
        kind, payload = c.frame()
        self.assertEqual(protocol.decode_json(payload), {'ok': False, 'error': 'bad-request'})
        res = c.request('nope')
        self.assertEqual(res, {'ok': False, 'seq': 1, 'error': 'unknown-op'})
        res = c.request('start', id='x')
        self.assertEqual(res['error'], 'bad-request')

    def test_second_daemon_on_same_runtime_dir_is_rejected(self):
        other = daemon.Daemon(sock_path=os.path.join(self.tmpdir, 'other.sock'),
                              runtime_dir=self.tmpdir, echo_stderr=False)
        with self.assertRaises(daemon.AlreadyRunning):
            other.bind()

    def test_shutdown_op_stops_the_loop_and_removes_socket(self):
        res = self.h.shutdown_via_op()
        self.assertTrue(res['ok'])
        self.assertFalse(self.h.thread.is_alive())
        self.assertFalse(os.path.exists(self.h.sock_path))
        self.assertFalse(os.path.exists(os.path.join(self.tmpdir, 'daemon.pid')))
        self.assertTrue(os.path.exists(os.path.join(self.tmpdir, 'daemon.log')))


class TestSessions(DaemonTestCase):
    def test_start_attach_echo(self):
        c = self.h.client()
        self.start_cat(c)
        res = c.request('attach', id='s1', cols=80, rows=24)
        self.assertEqual(res, {'ok': True, 'seq': 2, 'exited': None})
        self.assertEqual(c.replay(), b'')
        c.write(b'hello\n')
        out = c.read_output(lambda b: b.count(b'hello') >= 2)   # tty のエコー + cat
        self.assertIn(b'hello', out)
        rows = c.request('list')['sessions']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['id'], 's1')
        self.assertEqual(rows[0]['agent'], 'test')
        self.assertEqual(rows[0]['cwd'], self.tmpdir)
        self.assertEqual(rows[0]['clients'], 1)
        self.assertIsNone(rows[0]['exited'])
        self.assertIsInstance(rows[0]['pid'], int)
        self.assertIsInstance(rows[0]['startedAt'], float)

    def test_start_twice_is_exists(self):
        c = self.h.client()
        self.start_cat(c)
        res = c.request('start', id='s1', agent='test', cwd=self.tmpdir, argv=['/bin/cat'],
                        env={}, cols=80, rows=24)
        self.assertEqual(res, {'ok': False, 'seq': 2, 'error': 'exists'})

    def test_attach_unknown_is_no_session(self):
        c = self.h.client()
        res = c.request('attach', id='zzz', cols=80, rows=24)
        self.assertEqual(res, {'ok': False, 'seq': 1, 'error': 'no-session'})

    def test_env_is_augmented(self):
        c = self.h.client()
        res = c.request('start', id='e', agent='test', cwd=self.tmpdir,
                        argv=['/bin/sh', '-c', 'echo "$TERM/$COLORTERM/$AGENT_SESSIONS_ID/$FOO"'],
                        env={'PATH': '/usr/bin:/bin', 'FOO': 'bar'}, cols=80, rows=24)
        self.assertTrue(res['ok'])
        c.request('attach', id='e', cols=80, rows=24)
        out = c.replay()
        out += c.read_output(lambda b: b'bar' in out + b)
        self.assertIn(b'xterm-256color/truecolor/e/bar', out)

    def test_two_clients_get_min_size(self):
        a = self.h.client()
        b = self.h.client()
        res = a.request('start', id='sz', agent='test', cwd=self.tmpdir,
                        argv=['/bin/sh', '-c', 'read _; stty size; sleep 5'],
                        env={'PATH': '/usr/bin:/bin'}, cols=120, rows=40)
        self.assertTrue(res['ok'])
        a.request('attach', id='sz', cols=100, rows=30)
        a.replay()
        b.request('attach', id='sz', cols=70, rows=45)
        b.replay()
        time.sleep(0.2)   # 再生後の「1 行減らして戻す」が終わるのを待つ
        a.write(b'\n')
        out = a.read_output(lambda o: b'70' in o)
        self.assertIn(b'30 70', out)
        self.assertEqual(a.request('list')['sessions'][0]['clients'], 2)
        # b が外れると a のサイズに戻る（resize でも同じ経路）
        b.request('detach')
        self.assertEqual(a.request('list')['sessions'][0]['clients'], 1)
        self.assertEqual(self.h.daemon.sessions['sz'].cols, 100)
        self.assertEqual(self.h.daemon.sessions['sz'].rows, 30)
        a.request('resize', cols=90, rows=20)
        self.assertEqual((self.h.daemon.sessions['sz'].cols, self.h.daemon.sessions['sz'].rows), (90, 20))
        a.request('kill', id='sz')

    def test_attach_with_same_size_sends_no_sigwinch(self):
        a = self.h.client()
        res = a.request('start', id='w', agent='test', cwd=self.tmpdir,
                        argv=['/bin/sh', '-c', 'trap "echo WINCH" WINCH; while :; do sleep 0.1; done'],
                        env={'PATH': '/usr/bin:/bin'}, cols=80, rows=24)
        self.assertTrue(res['ok'])
        time.sleep(0.2)   # trap が置かれるのを待つ
        a.request('attach', id='w', cols=80, rows=24)
        a.replay()
        self.assertNotIn(b'WINCH', a.collect(0.4))
        a.request('detach')
        a.request('attach', id='w', cols=80, rows=24)   # 同じサイズで再 attach
        a.replay()
        self.assertNotIn(b'WINCH', a.collect(0.4))
        b = self.h.client()
        b.request('attach', id='w', cols=80, rows=20)   # サイズが変わる attach では再描画する
        b.replay()
        self.assertIn(b'WINCH', a.collect(0.6))
        self.assertEqual((self.h.daemon.sessions['w'].cols, self.h.daemon.sessions['w'].rows), (80, 20))
        a.request('kill', id='w')

    def test_detach_then_reattach_replays(self):
        c = self.h.client()
        self.start_cat(c)
        c.request('attach', id='s1', cols=80, rows=24)
        c.replay()
        c.write(b'replay-me\n')
        c.read_output(lambda b: b.count(b'replay-me') >= 2)
        self.assertTrue(c.request('detach')['ok'])
        self.assertEqual(c.request('list')['sessions'][0]['clients'], 0)
        res = c.request('attach', id='s1', cols=80, rows=24)
        self.assertEqual(res['exited'], None)
        replayed = c.replay()
        self.assertGreaterEqual(replayed.count(b'replay-me'), 2)

    def test_kill_sends_exit_and_forget_removes(self):
        c = self.h.client()
        self.start_cat(c)
        c.request('attach', id='s1', cols=80, rows=24)
        c.replay()
        self.assertTrue(c.request('kill', id='s1')['ok'])
        ev = c.wait_event('exit')
        self.assertEqual(ev['id'], 's1')
        self.assertIsInstance(ev['code'], int)
        row = c.request('list')['sessions'][0]
        self.assertEqual(row['exited'], ev['code'])
        self.assertIsInstance(row['exitedAt'], float)
        # 終了済みへの attach：再生 → replayed → exit
        res = c.request('attach', id='s1', cols=80, rows=24)
        self.assertEqual(res['exited'], ev['code'])
        c.replay()
        self.assertEqual(c.wait_event('exit')['code'], ev['code'])
        self.assertTrue(c.request('forget', id='s1')['ok'])
        self.assertEqual(c.request('list')['sessions'], [])
        self.assertEqual(c.request('forget', id='s1')['error'], 'no-session')

    def test_forget_running_is_error(self):
        c = self.h.client()
        self.start_cat(c)
        self.assertEqual(c.request('forget', id='s1'), {'ok': False, 'seq': 2, 'error': 'running'})

    def test_natural_exit_is_detected(self):
        c = self.h.client()
        res = c.request('start', id='x', agent='test', cwd=self.tmpdir,
                        argv=['/bin/sh', '-c', 'exit 3'], env={'PATH': '/usr/bin:/bin'},
                        cols=80, rows=24)
        self.assertTrue(res['ok'])
        self.assertEqual(self.wait_exited(c, 'x')['exited'], 3)

    def test_closing_connection_detaches(self):
        a = self.h.client()
        b = self.h.client()
        self.start_cat(a)
        a.request('attach', id='s1', cols=80, rows=24)
        a.replay()
        b.request('attach', id='s1', cols=80, rows=24)
        b.replay()
        self.assertEqual(a.request('list')['sessions'][0]['clients'], 2)
        b.close()
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            if a.request('list')['sessions'][0]['clients'] == 1:
                break
            time.sleep(0.02)
        self.assertEqual(a.request('list')['sessions'][0]['clients'], 1)
        self.assertEqual(len(self.h.daemon.conns), 1)

    def test_output_buffer_is_capped_at_1mib(self):
        c = self.h.client()
        res = c.request('start', id='big', agent='test', cwd=self.tmpdir,
                        argv=['/bin/sh', '-c', 'dd if=/dev/zero bs=65536 count=32 2>/dev/null'],
                        env={'PATH': '/usr/bin:/bin'}, cols=80, rows=24)
        self.assertTrue(res['ok'])
        self.wait_exited(c, 'big')
        c.request('attach', id='big', cols=80, rows=24)
        replayed = c.replay()
        self.assertLessEqual(len(replayed), MIB)
        self.assertGreater(len(replayed), MIB - 2 * 64 * KIB)
        self.assertEqual(self.h.daemon.sessions['big'].buffered, len(replayed))
        c.wait_event('exit')


class TestExitedFile(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix='agsd-')
        self.path = os.path.join(self.tmpdir, 'exited.json')

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_exited_sessions_survive_restart(self):
        h = DaemonHarness(self.tmpdir)
        try:
            c = h.client()
            c.request('start', id='gone', agent='test', cwd=self.tmpdir,
                      argv=['/bin/sh', '-c', 'exit 7'], env={'PATH': '/usr/bin:/bin'},
                      cols=80, rows=24)
            c.request('start', id='alive', agent='test', cwd=self.tmpdir, argv=['/bin/cat'],
                      env={'PATH': '/usr/bin:/bin'}, cols=80, rows=24)
            deadline = time.monotonic() + TIMEOUT
            while time.monotonic() < deadline:
                rows = {s['id']: s for s in c.request('list')['sessions']}
                if rows['gone']['exited'] is not None:
                    break
                time.sleep(0.02)
            self.assertEqual(rows['gone']['exited'], 7)
            h.shutdown_via_op()
        finally:
            h.stop()
        with open(self.path, encoding='utf-8') as f:
            saved = json.load(f)
        self.assertEqual(list(saved), ['gone'])      # 終了に伴って kill した alive は書かない
        self.assertEqual(saved['gone']['code'], 7)
        self.assertIsInstance(saved['gone']['exitedAt'], float)

        h2 = DaemonHarness(self.tmpdir)
        try:
            c = h2.client()
            rows = c.request('list')['sessions']
            self.assertEqual([(r['id'], r['exited']) for r in rows], [('gone', 7)])
            res = c.request('attach', id='gone', cols=80, rows=24)
            self.assertEqual(res['exited'], 7)
            self.assertEqual(c.replay(), b'')          # バッファは持ち越さない
            self.assertEqual(c.wait_event('exit')['code'], 7)
            self.assertTrue(c.request('forget', id='gone')['ok'])
            h2.shutdown_via_op()
        finally:
            h2.stop()
        with open(self.path, encoding='utf-8') as f:
            self.assertEqual(json.load(f), {})

    def test_broken_exited_file_is_moved_aside(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write('{broken')
        h = DaemonHarness(self.tmpdir)
        try:
            c = h.client()
            self.assertEqual(c.request('list')['sessions'], [])
        finally:
            h.stop()
        broken = [n for n in os.listdir(self.tmpdir) if n.startswith('exited.json.broken-')]
        self.assertEqual(len(broken), 1)
        with open(os.path.join(self.tmpdir, broken[0]), encoding='utf-8') as f:
            self.assertEqual(f.read(), '{broken')


class TestIdleExit(unittest.TestCase):
    def test_idle_exit(self):
        tmpdir = tempfile.mkdtemp(prefix='agsd-')
        try:
            h = DaemonHarness(tmpdir, idle_exit=0.3)
            try:
                c = h.client()
                self.assertTrue(c.request('hello', client='tui')['ok'])
                c.close()
                h.clients = []
                h.thread.join(TIMEOUT)
                self.assertFalse(h.thread.is_alive())
                self.assertTrue(os.path.exists(os.path.join(tmpdir, 'exited.json')))
            finally:
                h.stop()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()

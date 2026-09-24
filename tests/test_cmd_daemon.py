"""`agent-sessions daemon --running-count` / `--stop`（T-83。`uninstall.sh` が使う）。"""
import io
import os
import shutil
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout

from agentsessions import cmd_daemon, daemon

TIMEOUT = 5.0


class DaemonHarness:
    def __init__(self, runtime_dir):
        self.sock_path = os.path.join(runtime_dir, 'daemon.sock')
        self.daemon = daemon.Daemon(sock_path=self.sock_path, runtime_dir=runtime_dir,
                                    idle_exit=600, echo_stderr=False)
        self.daemon.bind()
        self.thread = threading.Thread(target=self.daemon.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        if self.thread.is_alive():
            self.daemon.stop()
            self.thread.join(TIMEOUT)


class CmdDaemonTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix='agsd-cmd-')

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _run(self, argv):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = cmd_daemon.main(argv)
        return rc, out.getvalue()


class TestNoDaemonRunning(CmdDaemonTestCase):
    def test_running_count_is_zero_when_nothing_is_listening(self):
        sock_path = os.path.join(self.tmpdir, 'daemon.sock')  # 何も bind していない
        rc, out = self._run(['--running-count', '--sock', sock_path])
        self.assertEqual(rc, 0)
        self.assertEqual(out, '0\n')

    def test_stop_is_a_no_op_when_nothing_is_listening(self):
        sock_path = os.path.join(self.tmpdir, 'daemon.sock')
        rc, out = self._run(['--stop', '--sock', sock_path])
        self.assertEqual(rc, 0)


class TestWithRunningDaemon(CmdDaemonTestCase):
    def setUp(self):
        super().setUp()
        self.harness = DaemonHarness(self.tmpdir)

    def tearDown(self):
        self.harness.stop()
        super().tearDown()

    def test_running_count_is_zero_with_no_sessions(self):
        rc, out = self._run(['--running-count', '--sock', self.harness.sock_path])
        self.assertEqual(rc, 0)
        self.assertEqual(out, '0\n')

    def test_running_count_reflects_active_and_exited_sessions(self):
        import socket

        from agentsessions import protocol
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(TIMEOUT)
        sock.connect(self.harness.sock_path)
        dec = protocol.Decoder()

        def req(op, seq, **kw):
            obj = {'op': op, 'seq': seq}
            obj.update(kw)
            sock.sendall(protocol.encode_json(obj))
            while True:
                data = sock.recv(65536)
                for kind, payload in dec.feed(data):
                    if kind == protocol.FRAME_J:
                        r = protocol.decode_json(payload)
                        if r.get('seq') == seq:
                            return r

        req('hello', 1, client='test')
        req('start', 2, id='s1', agent='test', cwd=self.tmpdir, argv=['/bin/cat'],
            env={'PATH': '/usr/bin:/bin'}, cols=80, rows=24)

        rc, out = self._run(['--running-count', '--sock', self.harness.sock_path])
        self.assertEqual(rc, 0)
        self.assertEqual(out, '1\n')

        req('kill', 3, id='s1', signal='KILL')
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            rows = req('list', 4, )['sessions']
            if any(s['id'] == 's1' and s['exited'] is not None for s in rows):
                break
            time.sleep(0.02)

        rc, out = self._run(['--running-count', '--sock', self.harness.sock_path])
        self.assertEqual(rc, 0)
        self.assertEqual(out, '0\n')  # 終了済みは数えない
        sock.close()

    def test_stop_shuts_the_daemon_down(self):
        rc, _ = self._run(['--stop', '--sock', self.harness.sock_path])
        self.assertEqual(rc, 0)
        self.harness.thread.join(TIMEOUT)
        self.assertFalse(self.harness.thread.is_alive())


if __name__ == '__main__':
    unittest.main()

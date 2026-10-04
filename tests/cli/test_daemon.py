"""Tests for `agent-sessions daemon --running-count` / `--stop`, used by `uninstall.sh`."""
import io
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

from agentsessions.cli import daemon as cmd_daemon
from agentsessions.daemon import server as daemon

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

    def _release_bound_daemons(self):
        """Releases the listener of every Daemon that `main()` binds but never serves.

        `os.fork` and `os._exit` are mocked in the detach tests, so the parent process that
        would normally exit right after the fork carries on and keeps the socket open."""
        bound = []
        real = cmd_daemon.Daemon

        def make(*args, **kwargs):
            d = real(*args, **kwargs)
            bound.append(d)
            return d

        patcher = mock.patch.object(cmd_daemon, 'Daemon', side_effect=make)
        patcher.start()
        self.addCleanup(lambda: [d.close_unstarted() for d in bound])
        self.addCleanup(patcher.stop)

    def _run(self, argv):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = cmd_daemon.main(argv)
        return rc, out.getvalue()


class TestNoDaemonRunning(CmdDaemonTestCase):
    def test_running_count_is_zero_when_nothing_is_listening(self):
        sock_path = os.path.join(self.tmpdir, 'daemon.sock')  # nothing is bound to it
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

        from agentsessions.daemon import protocol
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(sock.close)
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
        self.assertEqual(out, '0\n')  # exited sessions aren't counted

    def test_stop_shuts_the_daemon_down(self):
        rc, _ = self._run(['--stop', '--sock', self.harness.sock_path])
        self.assertEqual(rc, 0)
        self.harness.thread.join(TIMEOUT)
        self.assertFalse(self.harness.thread.is_alive())


class TestScopeDetach(CmdDaemonTestCase):
    def test_can_use_scope_needs_systemd_run_and_a_runtime_dir(self):
        env = {'XDG_RUNTIME_DIR': '/run/user/1000'}
        self.assertTrue(cmd_daemon.can_use_scope(env, '/usr/bin/systemd-run'))
        self.assertFalse(cmd_daemon.can_use_scope(env, None))
        self.assertFalse(cmd_daemon.can_use_scope({}, '/usr/bin/systemd-run'))
        self.assertFalse(cmd_daemon.can_use_scope({'XDG_RUNTIME_DIR': ''}, '/usr/bin/systemd-run'))

    def test_detach_scope_builds_the_systemd_run_command_and_returns_the_pid(self):
        proc = mock.Mock(pid=4321)
        proc.wait.side_effect = subprocess.TimeoutExpired('systemd-run', 1)
        log = os.path.join(self.tmpdir, 'daemon.log')
        with mock.patch.object(cmd_daemon.subprocess, 'Popen', return_value=proc) as popen:
            pid = cmd_daemon._detach_scope('/usr/bin/systemd-run', ['--detach', '--idle-exit', '5'], log)
        self.assertEqual(pid, 4321)
        argv = popen.call_args[0][0]
        self.assertEqual(argv[:6], ['/usr/bin/systemd-run', '--user', '--scope', '--collect', '--quiet', '--unit'])
        self.assertTrue(argv[6].startswith('agent-sessions-daemon-'))
        self.assertEqual(argv[7], sys.executable)
        self.assertEqual(argv[-3:], ['daemon', '--idle-exit', '5'])
        self.assertNotIn('--detach', argv)

    def test_detach_scope_gives_up_when_systemd_run_exits_early(self):
        proc = mock.Mock(pid=4321)
        proc.wait.return_value = 1
        log = os.path.join(self.tmpdir, 'daemon.log')
        with mock.patch.object(cmd_daemon.subprocess, 'Popen', return_value=proc):
            self.assertIsNone(cmd_daemon._detach_scope('/usr/bin/systemd-run', [], log))
        with mock.patch.object(cmd_daemon.subprocess, 'Popen', side_effect=OSError):
            self.assertIsNone(cmd_daemon._detach_scope('/usr/bin/systemd-run', [], log))

    def test_main_falls_back_to_fork_when_the_scope_fails(self):
        self._release_bound_daemons()
        args = ['--detach', '--runtime-dir', self.tmpdir, '--sock', os.path.join(self.tmpdir, 's.sock')]
        with mock.patch.object(cmd_daemon.sys, 'platform', 'linux'), \
                mock.patch.object(cmd_daemon.shutil, 'which', return_value='/usr/bin/systemd-run'), \
                mock.patch.dict(os.environ, {'XDG_RUNTIME_DIR': '/run/user/1'}), \
                mock.patch.object(cmd_daemon, '_detach_scope', return_value=None) as scope, \
                mock.patch.object(cmd_daemon.os, 'fork', return_value=777) as fork, \
                mock.patch.object(cmd_daemon.os, '_exit', side_effect=SystemExit), \
                self.assertRaises(SystemExit), redirect_stdout(io.StringIO()) as out:
            cmd_daemon.main(args)
        scope.assert_called_once()
        fork.assert_called_once()
        self.assertEqual(out.getvalue(), '777\n')

    def test_main_skips_the_scope_off_linux(self):
        self._release_bound_daemons()
        args = ['--detach', '--runtime-dir', self.tmpdir, '--sock', os.path.join(self.tmpdir, 's.sock')]
        with mock.patch.object(cmd_daemon.sys, 'platform', 'darwin'), \
                mock.patch.object(cmd_daemon, '_detach_scope') as scope, \
                mock.patch.object(cmd_daemon.os, 'fork', return_value=777), \
                mock.patch.object(cmd_daemon.os, '_exit', side_effect=SystemExit), \
                self.assertRaises(SystemExit), redirect_stdout(io.StringIO()):
            cmd_daemon.main(args)
        scope.assert_not_called()


if __name__ == '__main__':
    unittest.main()

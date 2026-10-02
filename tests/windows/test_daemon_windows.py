"""The daemon on native Windows: ConPTY children, the loopback transport, process checks.

Runs only on Windows (CI's windows-latest job); everywhere else the module is skipped.
"""
import os
import socket
import sys
import tempfile
import threading
import time
import unittest

from agentsessions import procs, transport
from agentsessions.daemon import protocol

ON_WINDOWS = sys.platform == 'win32'


@unittest.skipUnless(ON_WINDOWS, 'Windows only')
class WindowsDaemonTest(unittest.TestCase):
    def setUp(self) -> None:
        from agentsessions.daemon.server import Daemon
        self.dir = tempfile.mkdtemp()
        self.sock_path = os.path.join(self.dir, 'daemon.sock')
        self.daemon = Daemon(sock_path=self.sock_path, runtime_dir=self.dir, idle_exit=60, echo_stderr=False)
        self.daemon.bind()
        self.thread = threading.Thread(target=self.daemon.serve_forever, daemon=True)
        self.thread.start()
        self.sock = transport.connect(self.sock_path, 5)
        self.decoder = protocol.Decoder()
        self.seq = 0
        self.output = bytearray()
        self.events = []

    def tearDown(self) -> None:
        self.sock.close()
        self.daemon.stop()
        self.thread.join(10)

    def request(self, op, **fields):
        self.seq += 1
        obj = {'op': op, 'seq': self.seq}
        obj.update(fields)
        self.sock.sendall(protocol.encode_json(obj))
        deadline = time.time() + 10
        while time.time() < deadline:
            for kind, payload in self.decoder.feed(self.sock.recv(65536)):
                if kind == protocol.FRAME_J:
                    msg = protocol.decode_json(payload)
                    if msg.get('seq') == self.seq:
                        return msg
                    self.events.append(msg)
                else:
                    self.output.extend(payload)
        self.fail('no reply to %s' % op)

    def pump_until(self, predicate, timeout=15.0) -> None:
        deadline = time.time() + timeout
        self.sock.settimeout(0.2)
        try:
            while time.time() < deadline and not predicate():
                try:
                    data = self.sock.recv(65536)
                except socket.timeout:
                    continue
                if not data:
                    break
                for kind, payload in self.decoder.feed(data):
                    if kind == protocol.FRAME_J:
                        self.events.append(protocol.decode_json(payload))
                    else:
                        self.output.extend(payload)
        finally:
            self.sock.settimeout(10)

    def exit_code(self):
        for ev in self.events:
            if ev.get('ev') == 'exit':
                return ev.get('code')
        return None

    def start(self, argv):
        self.assertTrue(self.request('hello', client='test')['ok'])
        env = dict(os.environ)
        resp = self.request('start', id='w1', agent='claude', cwd=self.dir, argv=argv, env=env, cols=80, rows=24)
        self.assertTrue(resp['ok'], resp)
        self.assertTrue(self.request('attach', id='w1', cols=80, rows=24)['ok'])

    def test_output_and_exit_code(self) -> None:
        self.start(['cmd.exe', '/d', '/c', 'echo hello-%AGENT_SESSIONS_ID% & exit 7'])
        self.pump_until(lambda: self.exit_code() is not None)
        self.assertIn(b'hello-w1', bytes(self.output))
        self.assertEqual(self.exit_code(), 7)

    def test_input_resize_and_kill(self) -> None:
        self.start(['cmd.exe', '/d'])
        self.pump_until(lambda: b'>' in bytes(self.output))
        self.assertTrue(self.request('resize', cols=60, rows=20)['ok'])
        self.sock.sendall(protocol.encode(protocol.FRAME_D, 'echo typed-日本語\r'.encode('utf-8')))
        self.pump_until(lambda: 'typed-日本語'.encode('utf-8') in bytes(self.output))
        self.assertIn('typed-日本語'.encode('utf-8'), bytes(self.output))
        self.assertTrue(self.request('kill', id='w1', signal='KILL')['ok'])
        self.pump_until(lambda: self.exit_code() is not None)
        self.assertIsNotNone(self.exit_code())

    def test_a_wrong_token_is_dropped(self) -> None:
        port, _ = transport.read_endpoint(self.sock_path)
        bad = socket.create_connection(('127.0.0.1', port), timeout=5)
        try:
            bad.sendall(b'0' * 32 + b'\n' + protocol.encode_json({'op': 'hello', 'seq': 1}))
            self.assertEqual(bad.recv(100), b'')
        finally:
            bad.close()

    def test_a_bad_command_is_reported(self) -> None:
        self.assertTrue(self.request('hello', client='test')['ok'])
        resp = self.request('start', id='w2', agent='claude', cwd=self.dir, argv=['no-such-program-xyz'],
                            env=dict(os.environ), cols=80, rows=24)
        self.assertFalse(resp['ok'])
        self.assertEqual(resp['error'], 'spawn-failed')


@unittest.skipUnless(ON_WINDOWS, 'Windows only')
class WindowsProcsTest(unittest.TestCase):
    def test_pid_alive_never_kills(self) -> None:
        self.assertTrue(procs.pid_alive(os.getpid()))
        self.assertTrue(procs.pid_alive(os.getpid()))   # still here: no os.kill(pid, 0)
        self.assertFalse(procs.pid_alive(0))

    def test_process_table_lists_this_python(self) -> None:
        table = procs.process_table()
        self.assertIsNotNone(table)
        self.assertIn('python', table[os.getpid()].lower())

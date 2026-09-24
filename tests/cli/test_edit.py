import os
import shutil
import socket
import tempfile
import threading
import unittest
from unittest import mock

from agentsessions import cmd_edit, protocol

TIMEOUT = 5.0


class FakeServer:
    """A fake server that accepts exactly one connection and returns whatever
    `respond(req) -> Optional[dict]` returns.

    If `respond` returns `None`, the connection is closed without sending a response (EOF).
    """

    def __init__(self, respond):
        self.dir = tempfile.mkdtemp(prefix='agent-sessions-edit-test-')
        self.sock_path = os.path.join(self.dir, 'plugin.sock')
        self.respond = respond
        self.received = None
        self._listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._listener.settimeout(TIMEOUT)
        self._listener.bind(self.sock_path)
        self._listener.listen(1)
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        try:
            conn, _ = self._listener.accept()
        except OSError:
            return
        conn.settimeout(TIMEOUT)
        try:
            decoder = protocol.Decoder()
            while self.received is None:
                data = conn.recv(65536)
                if not data:
                    return
                for kind, payload in decoder.feed(data):
                    if kind == protocol.FRAME_J:
                        self.received = protocol.decode_json(payload)
                        break
            resp = self.respond(self.received)
            if resp is not None:
                conn.sendall(protocol.encode_json(resp))
        except OSError:
            pass
        finally:
            conn.close()

    def close(self):
        self._listener.close()
        self._thread.join(timeout=TIMEOUT)
        shutil.rmtree(self.dir, ignore_errors=True)


class EditTest(unittest.TestCase):
    def setUp(self):
        self._env_patch = mock.patch.dict(os.environ, {}, clear=False)
        self._env_patch.start()
        self.addCleanup(self._env_patch.stop)
        self.file = os.path.join(tempfile.gettempdir(), 'agent-sessions-edit-test.md')

    def _run(self, sock_path):
        os.environ[cmd_edit.SOCK_ENV] = sock_path
        return cmd_edit.main([self.file])

    def test_ok_returns_zero(self):
        server = FakeServer(lambda req: {'ok': True, 'seq': req['seq']})
        self.addCleanup(server.close)
        with mock.patch('os.execvp') as execvp:
            code = self._run(server.sock_path)
        self.assertEqual(code, 0)
        execvp.assert_not_called()
        self.assertEqual(server.received['op'], 'edit')
        self.assertEqual(server.received['file'], self.file)

    def test_cancel_returns_one_without_opening_editor(self):
        server = FakeServer(lambda req: {'ok': False, 'error': 'cancel', 'seq': req['seq']})
        self.addCleanup(server.close)
        with mock.patch('os.execvp') as execvp:
            code = self._run(server.sock_path)
        self.assertEqual(code, 1)
        execvp.assert_not_called()

    def test_no_tab_falls_back_to_editor(self):
        server = FakeServer(lambda req: {'ok': False, 'error': 'no-tab', 'seq': req['seq']})
        self.addCleanup(server.close)
        with mock.patch('os.execvp') as execvp:
            code = self._run(server.sock_path)
        self.assertEqual(code, 1)
        execvp.assert_called_once_with('vi', ['vi', self.file])

    def test_busy_falls_back_to_editor(self):
        server = FakeServer(lambda req: {'ok': False, 'error': 'busy', 'seq': req['seq']})
        self.addCleanup(server.close)
        os.environ['AGENT_SESSIONS_FALLBACK_EDITOR'] = '/bin/cat'
        with mock.patch('os.execvp') as execvp:
            code = self._run(server.sock_path)
        self.assertEqual(code, 1)
        execvp.assert_called_once_with('/bin/cat', ['/bin/cat', self.file])

    def test_no_socket_falls_back_to_editor(self):
        missing = os.path.join(tempfile.gettempdir(), 'agent-sessions-no-such.sock')
        with mock.patch('os.execvp') as execvp:
            code = self._run(missing)
        self.assertEqual(code, 1)
        execvp.assert_called_once_with('vi', ['vi', self.file])

    def test_eof_falls_back_to_editor(self):
        server = FakeServer(lambda req: None)   # closes without sending a response
        self.addCleanup(server.close)
        with mock.patch('os.execvp') as execvp:
            code = self._run(server.sock_path)
        self.assertEqual(code, 1)
        execvp.assert_called_once_with('vi', ['vi', self.file])


if __name__ == '__main__':
    unittest.main()

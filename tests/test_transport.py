import os
import socket
import tempfile
import threading
import unittest
from unittest import mock

from agentsessions import transport


class TokenGateTest(unittest.TestCase):
    TOKEN = '0123456789abcdef0123456789abcdef'

    def test_no_token_passes_everything(self) -> None:
        self.assertEqual(transport.TokenGate(None).feed(b'x'), (True, b'x'))

    def test_waits_for_the_line_then_hands_over_the_rest(self) -> None:
        gate = transport.TokenGate(self.TOKEN)
        self.assertEqual(gate.feed(self.TOKEN[:5].encode()), (None, b''))
        self.assertEqual(gate.feed((self.TOKEN[5:] + '\nJxyz').encode()), (True, b'Jxyz'))
        self.assertTrue(gate.passed)

    def test_rejects_a_wrong_token(self) -> None:
        self.assertEqual(transport.TokenGate(self.TOKEN).feed(b'f' * 32 + b'\n'), (False, b''))


class WindowsEndpointTest(unittest.TestCase):
    """The Windows code path (TCP + endpoint file + token), exercised on any OS."""

    def test_listen_connect_round_trip(self) -> None:
        path = os.path.join(tempfile.mkdtemp(), 'daemon.sock')
        with mock.patch.object(transport, 'IS_WINDOWS', True):
            listener, token = transport.listen(path)
            self.assertIsNotNone(token)
            port, saved = transport.read_endpoint(path)
            self.assertEqual(saved, token)
            got = []

            def serve() -> None:
                listener.setblocking(True)
                conn, _ = listener.accept()
                data = b''
                while len(data) < 33 + 2:
                    data += conn.recv(100)
                got.append(data)
                conn.close()

            t = threading.Thread(target=serve)
            t.start()
            client = transport.connect(path, 5)
            client.sendall(b'hi')
            t.join(5)
            client.close()
            listener.close()
            transport.remove(path)
        self.assertEqual(got[0], (token + '\n').encode() + b'hi')
        self.assertFalse(os.path.exists(path))

    def test_read_endpoint_rejects_malformed_files(self) -> None:
        path = os.path.join(tempfile.mkdtemp(), 'e.json')
        with open(path, 'w') as f:
            f.write('{"port": "x"}')
        with self.assertRaises(OSError):
            transport.read_endpoint(path)


if __name__ == '__main__':
    unittest.main()

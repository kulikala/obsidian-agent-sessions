import os
import unittest

from agentsessions import attach, protocol


class HandleFrameTest(unittest.TestCase):
    def setUp(self):
        self.read_fd, self.write_fd = os.pipe()
        self.addCleanup(os.close, self.read_fd)
        self.addCleanup(os.close, self.write_fd)

    def _read_all(self):
        os.set_blocking(self.read_fd, False)
        got = bytearray()
        try:
            while True:
                chunk = os.read(self.read_fd, 65536)
                if not chunk:
                    break
                got.extend(chunk)
        except BlockingIOError:
            pass
        return bytes(got)

    def test_d_frame_is_written_raw(self):
        code = attach.handle_frame(protocol.FRAME_D, b'hi\r\n', self.write_fd)
        self.assertIsNone(code)
        self.assertEqual(self._read_all(), b'hi\r\n')

    def test_r_frame_is_written_raw(self):
        code = attach.handle_frame(protocol.FRAME_R, b'replayed output', self.write_fd)
        self.assertIsNone(code)
        self.assertEqual(self._read_all(), b'replayed output')

    def test_empty_payload_writes_nothing(self):
        code = attach.handle_frame(protocol.FRAME_D, b'', self.write_fd)
        self.assertIsNone(code)
        self.assertEqual(self._read_all(), b'')

    def test_replayed_event_is_ignored(self):
        payload = protocol.encode_json({'ev': 'replayed'})[5:]
        code = attach.handle_frame(protocol.FRAME_J, payload, self.write_fd)
        self.assertIsNone(code)
        self.assertEqual(self._read_all(), b'')

    def test_other_json_is_ignored(self):
        payload = protocol.encode_json({'ok': True, 'seq': 3})[5:]
        code = attach.handle_frame(protocol.FRAME_J, payload, self.write_fd)
        self.assertIsNone(code)

    def test_exit_event_returns_code(self):
        payload = protocol.encode_json({'ev': 'exit', 'id': 'abc', 'code': 0})[5:]
        code = attach.handle_frame(protocol.FRAME_J, payload, self.write_fd)
        self.assertEqual(code, 0)

    def test_exit_event_returns_nonzero_code(self):
        payload = protocol.encode_json({'ev': 'exit', 'id': 'abc', 'code': 137})[5:]
        code = attach.handle_frame(protocol.FRAME_J, payload, self.write_fd)
        self.assertEqual(code, 137)

    def test_exit_event_without_int_code_falls_back(self):
        payload = protocol.encode_json({'ev': 'exit', 'id': 'abc', 'code': None})[5:]
        code = attach.handle_frame(protocol.FRAME_J, payload, self.write_fd)
        self.assertEqual(code, -1)


class _FakeSocket:
    """A fake socket for `_Client.request`. `recv` returns the given chunks in order."""

    def __init__(self, chunks):
        self._chunks = list(chunks)
        self.sent = []

    def sendall(self, data):
        self.sent.append(data)

    def recv(self, n):
        if not self._chunks:
            return b''
        return self._chunks.pop(0)


class ClientRequestTest(unittest.TestCase):
    def test_keeps_frames_after_response_in_same_recv(self):
        """The daemon sends `R` and `replayed` frames right after the `attach` response.
        Even when they arrive bundled into the same recv/feed call, only the response
        should be extracted and the remaining frames must be queued in `pending`."""
        response = protocol.encode_json({'ok': True, 'seq': 1, 'exited': None})
        replay = protocol.encode(protocol.FRAME_R, b'hello')
        replayed_ev = protocol.encode_json({'ev': 'replayed'})
        packet = response + replay + replayed_ev   # arrives bundled in a single recv

        client = attach._Client(_FakeSocket([packet]))
        result = client.request('attach', id='x', cols=80, rows=24)

        self.assertEqual(result, {'ok': True, 'seq': 1, 'exited': None})
        self.assertEqual(client.pending, [
            (protocol.FRAME_R, b'hello'),
            (protocol.FRAME_J, protocol.encode_json({'ev': 'replayed'})[5:]),
        ])

    def test_frames_before_response_are_also_kept(self):
        response = protocol.encode_json({'ok': True, 'seq': 1})
        stray = protocol.encode(protocol.FRAME_D, b'stray')
        packet = stray + response

        client = attach._Client(_FakeSocket([packet]))
        result = client.request('hello', client='tui')

        self.assertEqual(result, {'ok': True, 'seq': 1})
        self.assertEqual(client.pending, [(protocol.FRAME_D, b'stray')])

    def test_response_split_across_recv_calls(self):
        first = protocol.encode_json({'ev': 'noise'})
        response = protocol.encode_json({'ok': True, 'seq': 1})

        client = attach._Client(_FakeSocket([first, response]))
        result = client.request('hello', client='tui')

        self.assertEqual(result, {'ok': True, 'seq': 1})
        self.assertEqual(client.pending, [(protocol.FRAME_J, protocol.encode_json({'ev': 'noise'})[5:])])

    def test_closed_connection_raises(self):
        client = attach._Client(_FakeSocket([]))
        with self.assertRaises(ConnectionError):
            client.request('hello', client='tui')


if __name__ == '__main__':
    unittest.main()

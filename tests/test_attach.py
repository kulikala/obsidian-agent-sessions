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


if __name__ == '__main__':
    unittest.main()

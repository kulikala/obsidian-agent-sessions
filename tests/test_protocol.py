import unittest

from agentsessions import protocol


class TestEncodeDecode(unittest.TestCase):
    def test_round_trip(self):
        frame = protocol.encode(protocol.FRAME_D, b'hello')
        dec = protocol.Decoder()
        self.assertEqual(dec.feed(frame), [(protocol.FRAME_D, b'hello')])

    def test_zero_length_payload(self):
        frame = protocol.encode(protocol.FRAME_R, b'')
        dec = protocol.Decoder()
        self.assertEqual(dec.feed(frame), [(protocol.FRAME_R, b'')])

    def test_encode_json_round_trip(self):
        obj = {'op': 'hello', 'client': 'plugin'}
        frame = protocol.encode_json(obj)
        dec = protocol.Decoder()
        [(kind, payload)] = dec.feed(frame)
        self.assertEqual(kind, protocol.FRAME_J)
        self.assertEqual(protocol.decode_json(payload), obj)

    def test_encode_rejects_multi_byte_kind(self):
        with self.assertRaises(ValueError):
            protocol.encode(b'JJ', b'x')

    def test_header_layout_is_1_byte_type_then_u32_be_length(self):
        frame = protocol.encode(protocol.FRAME_J, b'abc')
        self.assertEqual(frame[0:1], protocol.FRAME_J)
        self.assertEqual(frame[1:5], b'\x00\x00\x00\x03')
        self.assertEqual(frame[5:], b'abc')


class TestDecoderFeed(unittest.TestCase):
    def test_feed_one_byte_at_a_time(self):
        frame = protocol.encode(protocol.FRAME_D, b'0123456789')
        dec = protocol.Decoder()
        got = []
        for i in range(len(frame)):
            got.extend(dec.feed(frame[i:i + 1]))
        self.assertEqual(got, [(protocol.FRAME_D, b'0123456789')])

    def test_incomplete_frame_carries_over_to_next_feed(self):
        frame = protocol.encode(protocol.FRAME_D, b'payload')
        dec = protocol.Decoder()
        # ヘッダーの途中で切る
        self.assertEqual(dec.feed(frame[:3]), [])
        # ペイロードの途中で切る
        self.assertEqual(dec.feed(frame[3:8]), [])
        self.assertEqual(dec.feed(frame[8:]), [(protocol.FRAME_D, b'payload')])

    def test_multiple_frames_concatenated_in_one_feed(self):
        frames = (protocol.encode(protocol.FRAME_J, b'{}')
                  + protocol.encode(protocol.FRAME_D, b'xy')
                  + protocol.encode(protocol.FRAME_R, b''))
        dec = protocol.Decoder()
        got = dec.feed(frames)
        self.assertEqual(got, [
            (protocol.FRAME_J, b'{}'),
            (protocol.FRAME_D, b'xy'),
            (protocol.FRAME_R, b''),
        ])

    def test_complete_frame_plus_trailing_partial_frame(self):
        full = protocol.encode(protocol.FRAME_D, b'first')
        partial = protocol.encode(protocol.FRAME_D, b'second')[:4]
        dec = protocol.Decoder()
        got = dec.feed(full + partial)
        self.assertEqual(got, [(protocol.FRAME_D, b'first')])
        rest = protocol.encode(protocol.FRAME_D, b'second')[4:]
        self.assertEqual(dec.feed(rest), [(protocol.FRAME_D, b'second')])


if __name__ == '__main__':
    unittest.main()

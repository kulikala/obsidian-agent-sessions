"""Wire frame format for the daemon socket.

+------+----------------+---------+
| type | length (u32 BE)| payload |
| 1 B  | 4 B            | n B     |
+------+----------------+---------+
"""

import json
import struct
from typing import Any, List, Tuple

FRAME_J = b'J'   # JSON (UTF-8). Requests, responses, and events
FRAME_D = b'D'   # Raw bytes (PTY input/output)
FRAME_R = b'R'   # Buffer replayed right after attach

_HEADER_LEN = 5   # 1 B (type) + 4 B (length, u32 BE)


def encode(kind: bytes, payload: bytes) -> bytes:
    if len(kind) != 1:
        raise ValueError('kind must be exactly 1 byte: %r' % kind)
    return kind + struct.pack('>I', len(payload)) + payload


def encode_json(obj: Any) -> bytes:
    return encode(FRAME_J, json.dumps(obj, ensure_ascii=False).encode('utf-8'))


def decode_json(payload: bytes) -> dict:
    return json.loads(payload.decode('utf-8'))


class Decoder:
    """Extracts only complete frames from the incoming byte stream.

    A frame that arrives truncated is carried over in the internal buffer,
    and the rest is picked up on the next `feed` call.
    """

    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, data: bytes) -> List[Tuple[bytes, bytes]]:
        self._buf.extend(data)
        out: List[Tuple[bytes, bytes]] = []
        while len(self._buf) >= _HEADER_LEN:
            length = struct.unpack('>I', self._buf[1:_HEADER_LEN])[0]
            end = _HEADER_LEN + length
            if len(self._buf) < end:
                break
            kind = bytes(self._buf[0:1])
            payload = bytes(self._buf[_HEADER_LEN:end])
            del self._buf[:end]
            out.append((kind, payload))
        return out

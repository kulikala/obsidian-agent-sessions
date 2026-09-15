"""デーモンのソケットのフレーム（D-4 §4.1）。

+------+----------------+---------+
| type | length (u32 BE)| payload |
| 1 B  | 4 B            | n B     |
+------+----------------+---------+
"""

import json
import struct
from typing import Any, List, Tuple

FRAME_J = b'J'   # JSON（UTF-8）。要求と応答・イベント
FRAME_D = b'D'   # 生バイト（PTY の入出力）
FRAME_R = b'R'   # attach 直後に再生するバッファ

_HEADER_LEN = 5   # 1 B（type） + 4 B（length, u32 BE）


def encode(kind: bytes, payload: bytes) -> bytes:
    if len(kind) != 1:
        raise ValueError('kind must be exactly 1 byte: %r' % kind)
    return kind + struct.pack('>I', len(payload)) + payload


def encode_json(obj: Any) -> bytes:
    return encode(FRAME_J, json.dumps(obj, ensure_ascii=False).encode('utf-8'))


def decode_json(payload: bytes) -> dict:
    return json.loads(payload.decode('utf-8'))


class Decoder:
    """受信バイト列から完全なフレームだけを切り出す。

    途中で切れたフレームは内部のバッファに持ち越し、次の `feed` で続きを待つ。
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

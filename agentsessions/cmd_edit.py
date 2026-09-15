"""`agent-sessions edit FILE`（D-20）。

プラグインの `~/.agents/sessions/plugin.sock` へ `edit` を発注する。
`{"ok":true}` で 0。`{"ok":false,"error":"cancel"}` は **1 で終わる**（`vi` は
開かない。Claude Code は元の内容を使う）。`error` が `no-tab`／`busy`、接続で
きない、応答を待つ間に相手が消えた（EOF・`ECONNRESET`）ときは、従来の
エディタへ倒す（`$AGENT_SESSIONS_FALLBACK_EDITOR`、無ければ `vi` を
`execvp`）。応答はタイムアウト無しで待つ。`SIGINT`／`SIGTERM` は `cancel` を
送って 1 で終わる。
"""

import os
import signal
import socket
import sys
from typing import List

from . import config, protocol

READ_SIZE = 65536
SOCK_ENV = 'AGENT_SESSIONS_PLUGIN_SOCK'


def _fallback(file: str) -> None:
    editor = os.environ.get('AGENT_SESSIONS_FALLBACK_EDITOR') or 'vi'
    os.execvp(editor, [editor, file])


def main(args: List[str]) -> int:
    if not args:
        sys.stderr.write('usage: agent-sessions edit FILE\n')
        return 2
    file = os.path.abspath(args[0])
    sock_path = os.environ.get(SOCK_ENV) or config.PLUGIN_SOCK_PATH

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(sock_path)
    except OSError:
        # プラグインが動いていない・ソケットが無い。従来のエディタへ倒す。
        sock.close()
        _fallback(file)
        return 1   # 本来 execvp から戻らない。モックした場合の保険。

    def _cancel(signum, frame):
        try:
            sock.sendall(protocol.encode_json({'op': 'cancel', 'seq': 2}))
        except OSError:
            pass
        sock.close()
        sys.exit(1)

    old_int = signal.signal(signal.SIGINT, _cancel)
    old_term = signal.signal(signal.SIGTERM, _cancel)
    try:
        req = {
            'op': 'edit',
            'seq': 1,
            'file': file,
            'session': os.environ.get('AGENT_SESSIONS_ID', ''),
            'cwd': os.getcwd(),
        }
        sock.sendall(protocol.encode_json(req))
        decoder = protocol.Decoder()
        resp = None
        while resp is None:
            data = sock.recv(READ_SIZE)
            if not data:
                # 接続が確立した後に相手が消えた（Obsidian のクラッシュ等）。
                sock.close()
                _fallback(file)
                return 1
            frames = decoder.feed(data)
            if frames:
                _, payload = frames[0]
                resp = protocol.decode_json(payload)
    except OSError:
        sock.close()
        _fallback(file)
        return 1
    finally:
        signal.signal(signal.SIGINT, old_int)
        signal.signal(signal.SIGTERM, old_term)

    sock.close()
    if resp.get('ok'):
        return 0
    if resp.get('error') == 'cancel':
        return 1
    # `no-tab`／`busy`、その他未知のエラー：従来のエディタへ倒す。
    _fallback(file)
    return 1

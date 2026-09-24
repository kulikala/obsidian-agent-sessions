"""`agent-sessions edit FILE`.

Sends an `edit` request to the plugin's `~/.agents/sessions/plugin.sock`. Returns 0 for
`{"ok":true}`. `{"ok":false,"error":"cancel"}` **returns 1** (doesn't open `vi`; Claude
Code keeps using the original content). Falls back to the ordinary editor
(`$AGENT_SESSIONS_FALLBACK_EDITOR`, or `vi` via `execvp` if unset) when `error` is
`no-tab`/`busy`, the socket can't be reached, or the other end disappears while waiting
for a response (EOF, `ECONNRESET`). Waits for the response with no timeout. `SIGINT`/
`SIGTERM` send `cancel` and return 1.
"""

import os
import signal
import socket
import sys
from typing import List

from .. import config, i18n
from ..daemon import protocol

READ_SIZE = 65536
SOCK_ENV = 'AGENT_SESSIONS_PLUGIN_SOCK'


def _fallback(file: str) -> None:
    editor = os.environ.get('AGENT_SESSIONS_FALLBACK_EDITOR') or 'vi'
    os.execvp(editor, [editor, file])


def main(args: List[str]) -> int:
    if not args:
        sys.stderr.write(i18n.t('cmd.edit_usage') + '\n')
        return 2
    file = os.path.abspath(args[0])
    sock_path = os.environ.get(SOCK_ENV) or config.PLUGIN_SOCK_PATH

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(sock_path)
    except OSError:
        # The plugin isn't running, or the socket doesn't exist. Fall back to the
        # ordinary editor.
        sock.close()
        _fallback(file)
        return 1   # execvp doesn't normally return; this is a safety net for when it's mocked.

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
                # The other end disappeared after the connection was established
                # (e.g. Obsidian crashed).
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
    # `no-tab`/`busy`, or anything else unrecognized: fall back to the ordinary editor.
    _fallback(file)
    return 1

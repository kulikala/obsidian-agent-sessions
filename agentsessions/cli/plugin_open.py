"""Asking the Obsidian plugin for something over `plugin.sock` (`plugin/src/backend/edit-server.ts`).

`request` sends one frame and returns the reply, or `None` when no plugin answers (Obsidian is not
running, or the plugin is older). The callers are `suggest-name --apply` (`rename`) and `new`/`resume`
(`open`).
"""
import os
from typing import Any, Dict, Optional

from .. import config, transport
from ..daemon import protocol

SOCK_ENV = 'AGENT_SESSIONS_PLUGIN_SOCK'
READ_SIZE = 65536
TIMEOUT = 10.0


def request(payload: Dict[str, Any], sock_path: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Sends one request to the plugin and returns its reply, or None when no plugin answers."""
    path = sock_path or os.environ.get(SOCK_ENV) or config.PLUGIN_SOCK_PATH
    try:
        sock = transport.connect(path)
    except OSError:
        return None
    try:
        sock.settimeout(TIMEOUT)
        sock.sendall(protocol.encode_json(payload))
        decoder = protocol.Decoder()
        while True:
            data = sock.recv(READ_SIZE)
            if not data:
                return None
            frames = decoder.feed(data)
            if frames:
                return protocol.decode_json(frames[0][1])
    except OSError:
        return None
    finally:
        sock.close()


def open_in_obsidian(session: str, agent: str, cwd: str, daemon: Optional[str] = None,
                     name: Optional[str] = None, sock_path: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Asks the plugin to open a tab for a session that already runs in the daemon, or None when no
    plugin answers."""
    payload: Dict[str, Any] = {'op': 'open', 'seq': 1, 'session': session, 'agent': agent, 'cwd': cwd}
    if daemon:
        payload['daemon'] = daemon
    if name:
        payload['name'] = name
    return request(payload, sock_path)

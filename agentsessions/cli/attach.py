"""`agent-sessions attach ID [--sock PATH]`.

This only parses arguments; the real work happens in `daemon/client.py`.
"""

import argparse
import os
from typing import List

from .. import config
from ..daemon.client import run

SOCK_ENV = 'AGENT_SESSIONS_SOCK'


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog='agent-sessions attach',
        description='Puts the terminal into raw mode and connects to the daemon\'s PTY')
    parser.add_argument('id', help='session ID')
    parser.add_argument('--sock', default=None,
                        help='socket path (default %s; the %s environment variable '
                        'takes priority if set)' % (config.SOCK_PATH, SOCK_ENV))
    return parser.parse_args(argv)


def main(args: List[str]) -> int:
    ns = parse_args(args)
    sock_path = ns.sock or os.environ.get(SOCK_ENV) or config.SOCK_PATH
    return run(ns.id, sock_path)

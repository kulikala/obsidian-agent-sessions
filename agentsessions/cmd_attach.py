"""`agent-sessions attach ID [--sock PATH]`。

引数解析だけを担う。本体は `attach.py`。
"""

import argparse
import os
from typing import List

from . import config
from .attach import run

SOCK_ENV = 'AGENT_SESSIONS_SOCK'


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog='agent-sessions attach', description='端末を raw mode にしてデーモンの PTY へ接続する')
    parser.add_argument('id', help='セッション ID')
    parser.add_argument('--sock', default=None,
                        help='ソケットのパス（既定 %s。環境変数 %s があればそちら）'
                        % (config.SOCK_PATH, SOCK_ENV))
    return parser.parse_args(argv)


def main(args: List[str]) -> int:
    ns = parse_args(args)
    sock_path = ns.sock or os.environ.get(SOCK_ENV) or config.SOCK_PATH
    return run(ns.id, sock_path)

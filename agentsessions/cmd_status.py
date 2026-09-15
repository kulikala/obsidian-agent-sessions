import sys
from typing import List

from . import hooks


def main(args: List[str]) -> int:
    """stdin の JSON を status/<session_id>.json に書き、1 行を stdout に出す。"""
    raw = sys.stdin.buffer.read()
    line = hooks.record_status(raw)
    sys.stdout.write(line + '\n')
    return 0

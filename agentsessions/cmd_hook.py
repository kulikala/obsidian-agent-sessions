import sys
from typing import List

from . import hooks


def main(args: List[str]) -> int:
    """stdin の JSON を events.log に追記する。フックを止めないため常に 0 を返す。"""
    try:
        raw = sys.stdin.buffer.read()
    except Exception:
        return 0
    hooks.record_hook(raw)
    return 0

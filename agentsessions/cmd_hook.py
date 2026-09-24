import sys
from typing import List

from . import hooks


def main(args: List[str]) -> int:
    """Appends stdin's JSON to events.log. Always returns 0, so this never blocks the hook."""
    try:
        raw = sys.stdin.buffer.read()
    except Exception:
        return 0
    hooks.record_hook(raw)
    return 0

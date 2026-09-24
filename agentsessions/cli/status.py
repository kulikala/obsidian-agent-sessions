import sys
from typing import List

from ..claude import hooks


def main(args: List[str]) -> int:
    """Writes stdin's JSON to status/<session_id>.json and prints one line to stdout."""
    raw = sys.stdin.buffer.read()
    line = hooks.record_status(raw)
    sys.stdout.write(line + '\n')
    return 0

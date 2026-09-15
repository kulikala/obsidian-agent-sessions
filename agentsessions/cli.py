import sys
from typing import List

# 中身は後のタスクで足す（daemon: T-4/T-5, json: T-6, attach: T-7, hook/status: T-6, setup: T-9）。
SUBCOMMANDS = ('daemon', 'json', 'attach', 'hook', 'status', 'setup')


def main(argv: List[str]) -> int:
    args = argv[1:]
    if not args:
        from .tui import main as tui_main
        return tui_main()
    cmd = args[0]
    if cmd in ('-h', '--help', 'help'):
        sys.stdout.write('usage: agent-sessions [%s]\n' % '|'.join(SUBCOMMANDS))
        return 0
    if cmd in SUBCOMMANDS:
        sys.stderr.write('未実装: %s\n' % cmd)
        return 2
    sys.stderr.write('unknown command: %s\n' % cmd)
    return 2

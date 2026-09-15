import importlib
import sys
from typing import List

# サブコマンドは agentsessions.cmd_<name> モジュールの main(args) -> int。
# モジュールが無いサブコマンドは「未実装」。
SUBCOMMANDS = ('daemon', 'json', 'attach', 'edit', 'hook', 'status', 'setup')


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
        try:
            mod = importlib.import_module('agentsessions.cmd_%s' % cmd)
        except ImportError:
            sys.stderr.write('未実装: %s\n' % cmd)
            return 2
        return mod.main(args[1:])
    sys.stderr.write('unknown command: %s\n' % cmd)
    return 2

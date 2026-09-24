import importlib
import sys
from typing import List

from . import i18n

# Each subcommand is `main(args) -> int` in an `agentsessions.cmd_<name>` module. A
# subcommand with no such module is "not implemented".
SUBCOMMANDS = ('daemon', 'json', 'attach', 'edit', 'hook', 'status', 'setup')


def main(argv: List[str]) -> int:
    args = argv[1:]
    if not args:
        from .tui import main as tui_main
        return tui_main()
    cmd = args[0]
    if cmd in ('-h', '--help', 'help'):
        sys.stdout.write(i18n.t('cli.usage', subcommands='|'.join(SUBCOMMANDS)) + '\n')
        return 0
    if cmd in SUBCOMMANDS:
        try:
            mod = importlib.import_module('agentsessions.cmd_%s' % cmd)
        except ImportError:
            sys.stderr.write(i18n.t('cli.not_implemented', cmd=cmd) + '\n')
            return 2
        return mod.main(args[1:])
    sys.stderr.write(i18n.t('cli.unknown_command', cmd=cmd) + '\n')
    return 2

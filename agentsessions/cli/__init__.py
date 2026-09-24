import importlib
import sys
from typing import List

from .. import i18n

# Each subcommand is `main(args) -> int` in an `agentsessions.cli.<module>` module. A
# subcommand with no such module is "not implemented". The module's own name only
# differs from the subcommand's for `json` (its module is `json_cmd`, so it doesn't
# shadow the standard library's `json`).
SUBCOMMANDS = ('daemon', 'json', 'attach', 'edit', 'hook', 'status', 'setup')
_MODULE_NAMES = {'json': 'json_cmd'}


def main(argv: List[str]) -> int:
    args = argv[1:]
    if not args:
        from ..tui.app import main as tui_main
        return tui_main()
    cmd = args[0]
    if cmd in ('-h', '--help', 'help'):
        sys.stdout.write(i18n.t('cli.usage', subcommands='|'.join(SUBCOMMANDS)) + '\n')
        return 0
    if cmd in SUBCOMMANDS:
        try:
            mod = importlib.import_module('agentsessions.cli.%s' % _MODULE_NAMES.get(cmd, cmd))
        except ImportError:
            sys.stderr.write(i18n.t('cli.not_implemented', cmd=cmd) + '\n')
            return 2
        return mod.main(args[1:])
    sys.stderr.write(i18n.t('cli.unknown_command', cmd=cmd) + '\n')
    return 2

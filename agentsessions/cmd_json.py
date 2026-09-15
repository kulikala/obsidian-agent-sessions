import json
import sys
from typing import List

from . import jsonout


def _print(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')


def main(args: List[str]) -> int:
    if not args:
        sys.stderr.write('usage: agent-sessions json scan|live|detail ...\n')
        return 2
    sub, rest = args[0], args[1:]

    if sub == 'scan':
        only = None
        if '--only' in rest:
            i = rest.index('--only')
            only = rest[i + 1:]
            if not only:
                sys.stderr.write('--only には ID が要ります\n')
                return 2
        _print(jsonout.scan_output(only=only))
        return 0

    if sub == 'live':
        _print(jsonout.live_output())
        return 0

    if sub == 'detail':
        if not rest:
            sys.stderr.write('usage: agent-sessions json detail ID\n')
            return 2
        _print(jsonout.detail_output(rest[0]))
        return 0

    sys.stderr.write('unknown json subcommand: %s\n' % sub)
    return 2

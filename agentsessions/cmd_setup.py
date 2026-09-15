import sys
from typing import List

from . import setup


def main(args: List[str]) -> int:
    dry_run = '--dry-run' in args
    settings_path = setup.DEFAULT_SETTINGS_PATH
    if '--settings' in args:
        i = args.index('--settings')
        if i + 1 >= len(args):
            sys.stderr.write('--settings には値が要ります\n')
            return 1
        settings_path = args[i + 1]

    changes, _ = setup.run(settings_path, dry_run=dry_run)
    if changes:
        for c in changes:
            sys.stdout.write(c + '\n')
        if dry_run:
            sys.stdout.write('(--dry-run のため書き込んでいない)\n')
    else:
        sys.stdout.write('変更なし\n')
    return 0

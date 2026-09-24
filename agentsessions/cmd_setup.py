import sys
from typing import List

from . import keybindings, setup


def main(args: List[str]) -> int:
    dry_run = '--dry-run' in args
    remove = '--remove' in args

    settings_path = setup.DEFAULT_SETTINGS_PATH
    if '--settings' in args:
        i = args.index('--settings')
        if i + 1 >= len(args):
            sys.stderr.write('--settings には値が要ります\n')
            return 1
        settings_path = args[i + 1]

    keybindings_path = keybindings.DEFAULT_KEYBINDINGS_PATH
    if '--keybindings' in args:
        i = args.index('--keybindings')
        if i + 1 >= len(args):
            sys.stderr.write('--keybindings には値が要ります\n')
            return 1
        keybindings_path = args[i + 1]

    changes: List[str]
    if remove:
        # T-83：settings.json から自分の hooks・statusLine を、keybindings.json から
        # 自分の送信キー 2 鍵を取り除く（それぞれ他のツールの分はそのまま）。
        changes, _ = setup.run_remove(settings_path, dry_run=dry_run)
        kb_changed, kb_warning = keybindings.remove_enter_keys(keybindings_path, dry_run=dry_run)
        if kb_changed:
            changes.append('keybindings.json: enter・meta+enter を取り除いた')
        if kb_warning:
            changes.append('keybindings.json: %s' % kb_warning)
    else:
        changes, _ = setup.run(settings_path, dry_run=dry_run)

    if changes:
        for c in changes:
            sys.stdout.write(c + '\n')
        if dry_run:
            sys.stdout.write('(--dry-run のため書き込んでいない)\n')
    else:
        sys.stdout.write('変更なし\n')
    return 0

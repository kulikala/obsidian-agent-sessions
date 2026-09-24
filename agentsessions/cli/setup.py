import sys
from typing import List

from .. import i18n
from ..claude import keybindings
from ..claude import setup as claude_setup


def main(args: List[str]) -> int:
    dry_run = '--dry-run' in args
    remove = '--remove' in args

    settings_path = claude_setup.DEFAULT_SETTINGS_PATH
    if '--settings' in args:
        i = args.index('--settings')
        if i + 1 >= len(args):
            sys.stderr.write(i18n.t('cmd.needs_value', flag='--settings') + '\n')
            return 1
        settings_path = args[i + 1]

    keybindings_path = keybindings.DEFAULT_KEYBINDINGS_PATH
    if '--keybindings' in args:
        i = args.index('--keybindings')
        if i + 1 >= len(args):
            sys.stderr.write(i18n.t('cmd.needs_value', flag='--keybindings') + '\n')
            return 1
        keybindings_path = args[i + 1]

    changes: List[str]
    try:
        if remove:
            # Removes only our own hooks/statusLine from settings.json, and only our
            # own two submit-key entries from keybindings.json (leaving other tools'
            # entries alone either way).
            changes, _ = claude_setup.run_remove(settings_path, dry_run=dry_run)
            kb_changed, kb_warning = keybindings.remove_enter_keys(keybindings_path, dry_run=dry_run)
            if kb_changed:
                changes.append(i18n.t('setup.keybindings_removed'))
            if kb_warning:
                changes.append(kb_warning)  # already starts with "keybindings.json: "
        else:
            changes, _ = claude_setup.run(settings_path, dry_run=dry_run)
    except claude_setup.SettingsUnreadable as e:
        sys.stderr.write(i18n.t('cmd.settings_unreadable', path=settings_path, error=e) + '\n')
        return 1

    if changes:
        for c in changes:
            sys.stdout.write(c + '\n')
        if dry_run:
            sys.stdout.write(i18n.t('cmd.dry_run_note') + '\n')
    else:
        sys.stdout.write(i18n.t('cmd.no_changes') + '\n')
    return 0

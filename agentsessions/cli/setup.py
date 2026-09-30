import sys
from typing import List

from .. import i18n
from ..agents.opencode import setup as opencode_setup
from ..agents.opencode import tui_config as opencode_tui
from ..claude import keybindings
from ..claude import setup as claude_setup
from ..codex import config_toml


def main(args: List[str]) -> int:
    dry_run = '--dry-run' in args
    remove = '--remove' in args
    # `--opencode` installs only the OpenCode plugin: Claude Code's settings are
    # left alone, since OpenCode can be enabled without Claude Code.
    # `--remove-opencode` removes only that plugin file (OpenCode switched off in the plugin),
    # `--update-only` refreshes it when it exists and never creates it.
    remove_opencode = '--remove-opencode' in args and not remove
    opencode_only = '--opencode' in args and not remove and not remove_opencode
    update_only = '--update-only' in args

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

    launcher = claude_setup.DEFAULT_LAUNCHER
    if '--command' in args:
        i = args.index('--command')
        if i + 1 >= len(args):
            sys.stderr.write(i18n.t('cmd.needs_value', flag='--command') + '\n')
            return 1
        launcher = args[i + 1]

    config_toml_path = config_toml.DEFAULT_CONFIG_TOML_PATH
    if '--config-toml' in args:
        i = args.index('--config-toml')
        if i + 1 >= len(args):
            sys.stderr.write(i18n.t('cmd.needs_value', flag='--config-toml') + '\n')
            return 1
        config_toml_path = args[i + 1]

    opencode_path = opencode_setup.default_plugin_path()
    if '--opencode-plugin' in args:
        i = args.index('--opencode-plugin')
        if i + 1 >= len(args):
            sys.stderr.write(i18n.t('cmd.needs_value', flag='--opencode-plugin') + '\n')
            return 1
        opencode_path = args[i + 1]

    opencode_backup = opencode_tui.default_backup_path()
    if '--opencode-tui-backup' in args:
        i = args.index('--opencode-tui-backup')
        if i + 1 >= len(args):
            sys.stderr.write(i18n.t('cmd.needs_value', flag='--opencode-tui-backup') + '\n')
            return 1
        opencode_backup = args[i + 1]

    changes: List[str]
    # The last line `--opencode` / `--remove-opencode` print: `opencode-plugin: <status>`
    # (installed | updated | unchanged | foreign | absent | failed | removed), for a caller to read.
    opencode_status = None
    exit_code = 0
    try:
        if opencode_only:
            opencode_status, changes = opencode_setup.apply(opencode_path, dry_run=dry_run, update_only=update_only)
            if opencode_status == opencode_setup.FAILED:
                exit_code = 1
        elif remove_opencode:
            changes = opencode_setup.remove(opencode_path, dry_run=dry_run)
            opencode_status = 'removed' if changes else opencode_setup.ABSENT
            # ... and gives back the submit-key keybinds the plugin set in OpenCode's tui.json.
            changes.extend(opencode_tui.restore(opencode_backup, dry_run=dry_run))
        elif remove:
            # Removes only our own hooks/statusLine from settings.json, only our
            # own two submit-key entries from keybindings.json, and only our own
            # marked lines from Codex's config.toml (T-109) -- leaving other
            # tools'/the user's own entries alone in every case. Nothing writes
            # to config.toml on the non-remove side; the plugin (T-108) does
            # that, since the Python side doesn't manage a Codex installation
            # the way it manages a Claude Code one.
            changes, _ = claude_setup.run_remove(settings_path, dry_run=dry_run)
            kb_changed, kb_warning = keybindings.remove_managed_keys(keybindings_path, dry_run=dry_run)
            if kb_changed:
                changes.append(i18n.t('setup.keybindings_removed'))
            if kb_warning:
                changes.append(kb_warning)  # already starts with "keybindings.json: "
            _ct_changed, ct_message = config_toml.remove_managed_lines(config_toml_path, dry_run=dry_run)
            if ct_message:
                changes.append(ct_message)
            changes.extend(opencode_setup.remove(opencode_path, dry_run=dry_run))
            changes.extend(opencode_tui.restore(opencode_backup, dry_run=dry_run))
        else:
            changes, _ = claude_setup.run(settings_path, dry_run=dry_run, launcher=launcher)
    except claude_setup.SettingsUnreadable as e:
        sys.stderr.write(i18n.t('cmd.settings_unreadable', path=settings_path, error=e) + '\n')
        return 1

    if changes:
        # A failure goes to stderr, where a caller (the plugin) reads the reason from.
        out = sys.stderr if exit_code else sys.stdout
        for c in changes:
            out.write(c + '\n')
        if dry_run:
            sys.stdout.write(i18n.t('cmd.dry_run_note') + '\n')
    else:
        sys.stdout.write(i18n.t('cmd.no_changes') + '\n')
    if opencode_status:
        sys.stdout.write('opencode-plugin: %s\n' % opencode_status)
    return exit_code

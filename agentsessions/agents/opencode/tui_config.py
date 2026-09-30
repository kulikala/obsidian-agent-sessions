"""Undoing the plugin's edit of OpenCode's `tui.json`
(`$XDG_CONFIG_HOME/opencode/tui.json`, default `~/.config/opencode/`).

The plugin sets `keybinds.editor_open` there (the editor key) whenever OpenCode is
enabled, and `keybinds.input_submit` / `keybinds.input_newline` for a submit key
other than Enter (`plugin/src/terminal/opencode-tui.ts`). It records the user's
previous values in `~/.agents/sessions/opencode-tui-backup.json`:

    {"path": "<tui.json>", "input_submit": str|null, "input_newline": str|null,
     "editor_open": str|null,
     "managed": {"input_submit": str, "input_newline": str, "editor_open": str},
     "created_keybinds": bool, "created_file": bool}

It also lists the status line, a TUI plugin, in the file's `plugin` array
(`PLUGIN_SPEC`, resolved against the folder of tui.json; OpenCode loads TUI plugins from
that list only). That entry identifies itself, so the backup has no field for it: while
the backup exists the entry is ours, and `restore` removes it (and the `plugin` array
when that leaves it empty).

Only the keys in `managed` are held (the previous-value fields exist for those
alone); a backup from before the editor key holds the submit pair only.
`restore` puts the previous values back (deleting a key that did not exist
before), leaves any key whose value is no longer the one the plugin wrote, and
deletes the backup. A tui.json that is not plain JSON is left untouched and its
backup kept, so a later run can still restore it.
"""
import json
import os
from typing import List, Optional

from ... import config, i18n

BACKUP_FILENAME = 'opencode-tui-backup.json'
KEYS = ('input_submit', 'input_newline', 'editor_open')
PLUGIN_SPEC = './agent-sessions-tui.jsx'


def default_backup_path() -> str:
    return os.path.join(config.RUNTIME_DIR, BACKUP_FILENAME)


def _load_backup(path: str) -> Optional[dict]:
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if isinstance(data, dict) and isinstance(data.get('path'), str) and isinstance(data.get('managed'), dict):
        return data
    return None


def _indent(text: str):
    for line in text.splitlines():
        stripped = line.lstrip(' \t')
        if stripped.startswith('"') and stripped != line:
            lead = line[:len(line) - len(stripped)]
            return '\t' if lead.startswith('\t') else len(lead)
    return 2


def restore(backup_path: Optional[str] = None, dry_run: bool = False) -> List[str]:
    """Restores tui.json from the backup. Returns change descriptions (`[]` when there is
    nothing to do)."""
    backup_path = backup_path or default_backup_path()
    backup = _load_backup(backup_path)
    if backup is None:
        return []
    tui_path = backup['path']
    changes: List[str] = []
    try:
        with open(tui_path, encoding='utf-8') as f:
            text = f.read()
    except FileNotFoundError:
        text = None
    except OSError as e:
        return [i18n.t('setup.opencode_tui_failed', path=tui_path, error=e)]

    if text is not None:
        try:
            obj = json.loads(text) if text.strip() else {}
        except ValueError:
            return [i18n.t('setup.opencode_tui_not_json', path=tui_path)]
        kb = obj.get('keybinds') if isinstance(obj, dict) else None
        if not isinstance(obj, dict) or ('keybinds' in obj and not isinstance(kb, dict)):
            return [i18n.t('setup.opencode_tui_not_json', path=tui_path)]
        plugins = obj.get('plugin')
        if 'plugin' in obj and not isinstance(plugins, list):
            return [i18n.t('setup.opencode_tui_not_json', path=tui_path)]
        changed = False
        if plugins is not None:
            kept = [e for e in plugins if e != PLUGIN_SPEC and not (isinstance(e, list) and e[:1] == [PLUGIN_SPEC])]
            if len(kept) != len(plugins):
                changed = True
                if kept:
                    obj['plugin'] = kept
                else:
                    del obj['plugin']
        if kb is not None:
            for key in KEYS:
                if key not in backup['managed'] or kb.get(key) != backup['managed'][key]:
                    continue
                previous = backup.get(key)
                if previous is None:
                    kb.pop(key, None)
                else:
                    kb[key] = previous
                changed = True
            if not kb and backup.get('created_keybinds'):
                del obj['keybinds']
        if changed:
            changes.append(i18n.t('setup.opencode_tui_restored', path=tui_path))
            if not dry_run:
                try:
                    if not obj and backup.get('created_file'):
                        os.unlink(tui_path)
                    else:
                        out = json.dumps(obj, indent=_indent(text), ensure_ascii=False)
                        if '\r\n' in text:
                            out = out.replace('\n', '\r\n')
                        if not text or text.endswith('\n'):
                            out += '\r\n' if '\r\n' in text else '\n'
                        tmp = tui_path + '.tmp'
                        with open(tmp, 'w', encoding='utf-8', newline='') as f:
                            f.write(out)
                        os.replace(tmp, tui_path)
                except OSError as e:
                    return [i18n.t('setup.opencode_tui_failed', path=tui_path, error=e)]
    if not dry_run:
        try:
            os.unlink(backup_path)
        except OSError:
            pass
    return changes

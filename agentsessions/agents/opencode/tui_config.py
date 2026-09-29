"""Undoing the plugin's edit of OpenCode's `tui.json`
(`$XDG_CONFIG_HOME/opencode/tui.json`, default `~/.config/opencode/`).

With a submit key other than Enter the plugin sets `keybinds.input_submit` and
`keybinds.input_newline` there (`plugin/src/terminal/opencode-tui.ts`) and records
the user's previous values in `~/.agents/sessions/opencode-tui-backup.json`:

    {"path": "<tui.json>", "input_submit": str|null, "input_newline": str|null,
     "managed": {"input_submit": str, "input_newline": str},
     "created_keybinds": bool, "created_file": bool}

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
KEYS = ('input_submit', 'input_newline')


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
        changed = False
        if kb is not None:
            for key in KEYS:
                if kb.get(key) != backup['managed'].get(key):
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

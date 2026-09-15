"""`~/.claude/settings.json` の hooks・statusLine を整える（D-2, D-6 §5）。"""

import copy
import json
import os
import time
from typing import List, Optional, Tuple

DEFAULT_SETTINGS_PATH = os.path.expanduser('~/.claude/settings.json')

_OLD_HOOK_MARKERS = ('bin/cs" hook', 'bin/cs hook')
_NEW_HOOK_COMMAND = '"$HOME/bin/agent-sessions" hook'
_NEW_STATUS_LINE = {'type': 'command', 'command': '"$HOME/bin/agent-sessions" status'}
_HOOK_EVENTS = ('Stop', 'SessionEnd')


def _is_old_hook_command(command) -> bool:
    return isinstance(command, str) and any(m in command for m in _OLD_HOOK_MARKERS)


def _update_hook_event(hooks_obj: dict, event: str) -> List[str]:
    changes: List[str] = []
    entries = hooks_obj.get(event)
    if not isinstance(entries, list):
        entries = []
        hooks_obj[event] = entries
    already_current = False
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        for h in entry.get('hooks', []) if isinstance(entry.get('hooks'), list) else []:
            if not isinstance(h, dict):
                continue
            command = h.get('command')
            if _is_old_hook_command(command):
                changes.append('hooks.%s: %r → %r' % (event, command, _NEW_HOOK_COMMAND))
                h['command'] = _NEW_HOOK_COMMAND
                already_current = True
            elif command == _NEW_HOOK_COMMAND:
                already_current = True
    if not already_current:
        entries.append({'matcher': '.*', 'hooks': [{'type': 'command', 'command': _NEW_HOOK_COMMAND}]})
        changes.append('hooks.%s: 追加 %s' % (event, _NEW_HOOK_COMMAND))
    return changes


def _is_old_status_line(status_line) -> bool:
    if status_line is None:
        return True
    if not isinstance(status_line, dict):
        return True
    command = status_line.get('command')
    return not isinstance(command, str) or 'cs' in command


def _update_status_line(settings: dict) -> Optional[str]:
    current = settings.get('statusLine')
    if not _is_old_status_line(current):
        return None
    settings['statusLine'] = dict(_NEW_STATUS_LINE)
    return 'statusLine: %r → %r' % (current, _NEW_STATUS_LINE)


def compute_changes(settings: dict) -> List[str]:
    """`settings` をその場で書き換え、変更点の説明文のリストを返す。"""
    hooks_obj = settings.get('hooks')
    if not isinstance(hooks_obj, dict):
        hooks_obj = {}
        settings['hooks'] = hooks_obj
    changes: List[str] = []
    for event in _HOOK_EVENTS:
        changes.extend(_update_hook_event(hooks_obj, event))
    line_change = _update_status_line(settings)
    if line_change:
        changes.append(line_change)
    return changes


def run(settings_path: str = DEFAULT_SETTINGS_PATH, dry_run: bool = False) -> Tuple[List[str], dict]:
    """`settings_path` を読み、変更点を計算する。`dry_run` でなければ backup を残して書き込む。

    戻り値は (変更点の説明文のリスト, 新しい settings)。
    """
    existed = os.path.exists(settings_path)
    settings = {}
    if existed:
        with open(settings_path, 'r', encoding='utf-8') as f:
            try:
                loaded = json.load(f)
            except ValueError:
                loaded = {}
        if isinstance(loaded, dict):
            settings = loaded

    new_settings = copy.deepcopy(settings)
    changes = compute_changes(new_settings)

    if changes and not dry_run:
        if existed:
            backup_path = settings_path + '.bak-' + time.strftime('%Y%m%d%H%M%S')
            with open(backup_path, 'w', encoding='utf-8') as f:
                json.dump(settings, f, ensure_ascii=False, indent=2)
                f.write('\n')
        dirpath = os.path.dirname(settings_path) or '.'
        os.makedirs(dirpath, exist_ok=True)
        with open(settings_path, 'w', encoding='utf-8') as f:
            json.dump(new_settings, f, ensure_ascii=False, indent=2)
            f.write('\n')

    return changes, new_settings

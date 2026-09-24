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
# (event, matcher)。`SessionStart` は `compact`（`/compact`・自動の文脈圧縮の両方が
# この値。T-77 追補：compacted の印の「入る」）に絞る——`Stop`・`SessionEnd` は元々
# 個別のマッチャーを持たない催しなので `.*`。`UserPromptSubmit`（同追補：印の「出る」）も
# マッチャー非対応なので `.*`。
_HOOK_EVENTS = (
    ('Stop', '.*'),
    ('SessionEnd', '.*'),
    ('SessionStart', 'compact'),
    ('UserPromptSubmit', '.*'),
)


def _is_old_hook_command(command) -> bool:
    return isinstance(command, str) and any(m in command for m in _OLD_HOOK_MARKERS)


def _update_hook_event(hooks_obj: dict, event: str, matcher: str) -> List[str]:
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
            elif command == _NEW_HOOK_COMMAND and entry.get('matcher') == matcher:
                already_current = True
    if not already_current:
        entries.append({'matcher': matcher, 'hooks': [{'type': 'command', 'command': _NEW_HOOK_COMMAND}]})
        changes.append('hooks.%s: 追加 matcher=%s %s' % (event, matcher, _NEW_HOOK_COMMAND))
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
    for event, matcher in _HOOK_EVENTS:
        changes.extend(_update_hook_event(hooks_obj, event, matcher))
    line_change = _update_status_line(settings)
    if line_change:
        changes.append(line_change)
    return changes


def _remove_hook_event(hooks_obj: dict, event: str) -> List[str]:
    """`event` の entries から、自分の hook（`_NEW_HOOK_COMMAND`）だけを取り除く（T-83）。

    hooks が空になった entry は消す。entries が空になれば `hooks_obj` からそのキー自体を
    消す。他のツールが入れた hook・他の matcher の entry はそのまま残す。
    """
    changes: List[str] = []
    entries = hooks_obj.get(event)
    if not isinstance(entries, list):
        return changes
    new_entries: List[dict] = []
    removed = False
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get('hooks'), list):
            new_entries.append(entry)
            continue
        kept = [h for h in entry['hooks']
                if not (isinstance(h, dict) and h.get('command') == _NEW_HOOK_COMMAND)]
        if len(kept) != len(entry['hooks']):
            removed = True
        if kept:
            new_entry = dict(entry)
            new_entry['hooks'] = kept
            new_entries.append(new_entry)
        # kept が空なら entry ごと省く。
    if removed:
        changes.append('hooks.%s: %s を取り除いた' % (event, _NEW_HOOK_COMMAND))
    if new_entries:
        hooks_obj[event] = new_entries
    elif event in hooks_obj:
        del hooks_obj[event]
    return changes


def _remove_status_line(settings: dict) -> Optional[str]:
    current = settings.get('statusLine')
    if isinstance(current, dict) and current.get('command') == _NEW_STATUS_LINE['command']:
        del settings['statusLine']
        return 'statusLine: %r を取り除いた' % current
    return None


def compute_removal(settings: dict) -> List[str]:
    """`compute_changes` の逆（T-83）。`settings` をその場で書き換え、自分が入れた
    hooks・statusLine だけを取り除いた変更点の説明文のリストを返す。他のフック・
    他の statusLine には触れない。何も入っていなければ変更なし（冪等）。"""
    changes: List[str] = []
    hooks_obj = settings.get('hooks')
    if isinstance(hooks_obj, dict):
        for event, _matcher in _HOOK_EVENTS:
            changes.extend(_remove_hook_event(hooks_obj, event))
        if not hooks_obj and 'hooks' in settings:
            del settings['hooks']
    line_change = _remove_status_line(settings)
    if line_change:
        changes.append(line_change)
    return changes


def run_remove(settings_path: str = DEFAULT_SETTINGS_PATH, dry_run: bool = False) -> Tuple[List[str], dict]:
    """`run()` の逆（T-83）。`settings_path` を読み、自分が `run()` で入れた hooks・
    statusLine だけを取り除く。`settings_path` が無ければ何もしない（`([], {})`）。
    変更があれば `run()` と同じ形式で backup してから書く。"""
    if not os.path.exists(settings_path):
        return [], {}
    with open(settings_path, 'r', encoding='utf-8') as f:
        try:
            loaded = json.load(f)
        except ValueError:
            loaded = {}
    settings = loaded if isinstance(loaded, dict) else {}

    new_settings = copy.deepcopy(settings)
    changes = compute_removal(new_settings)

    if changes and not dry_run:
        backup_path = settings_path + '.bak-' + time.strftime('%Y%m%d%H%M%S')
        with open(backup_path, 'w', encoding='utf-8') as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
            f.write('\n')
        with open(settings_path, 'w', encoding='utf-8') as f:
            json.dump(new_settings, f, ensure_ascii=False, indent=2)
            f.write('\n')

    return changes, new_settings


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

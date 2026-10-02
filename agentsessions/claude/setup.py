"""Sets up (and tears down) the hooks and statusLine in `~/.claude/settings.json`."""

import copy
import json
import os
import re
import sys
import time
from typing import List, Optional, Tuple

from .. import i18n

DEFAULT_SETTINGS_PATH = os.path.expanduser('~/.claude/settings.json')


class SettingsUnreadable(RuntimeError):
    """Raised when `settings_path` exists but isn't valid JSON, or isn't a JSON object.

    `run()`/`run_remove()` never silently treat this as an empty settings file — doing
    so would mean writing a fresh, mostly-empty settings.json over whatever was really
    there, discarding it. The caller should report this and stop instead of writing
    anything."""

_OLD_HOOK_MARKERS = ('bin/cs" hook', 'bin/cs hook')
_OLD_STATUS_LINE_MARKERS = ('bin/cs" status', 'bin/cs status')
# Where the hooks and statusLine point unless `run()` is given a launcher: the `~/bin`
# link `install.sh` makes. The plugin passes the launcher it installed instead.
DEFAULT_LAUNCHER = '$HOME/bin/agent-sessions'
# Any command this tool ever wrote, whichever launcher path it named: `"<…>/agent-sessions" hook`
# (or `status`). Recognizing ours by shape rather than by one exact path is what lets a later
# `run()` with a different launcher move the entries over, and `run_remove()` take them out
# no matter which install wrote them.
# On Windows the launcher is `agent-sessions.cmd`, named unquoted (see `_command`).
_OUR_COMMAND_RE = re.compile(r'^(?:"[^"]*/agent-sessions"|[^"\s]*/agent-sessions\.cmd) (hook|status)$')


def windows_command_path(path: str) -> str:
    """How a Windows hook or statusLine names `path`. Claude Code runs those commands through Git
    Bash when it is installed and through PowerShell otherwise; the one spelling both run as a
    plain command is an unquoted path with forward slashes (bash eats unquoted backslashes, and
    PowerShell treats a quoted string followed by arguments as an expression). A path with spaces
    is shortened to its 8.3 form, which has none."""
    if ' ' in path and sys.platform == 'win32':
        import ctypes
        buf = ctypes.create_unicode_buffer(32768)
        if ctypes.windll.kernel32.GetShortPathNameW(path, buf, len(buf)):  # type: ignore[attr-defined]
            path = buf.value
    return path.replace('\\', '/')


def _command(launcher: str, verb: str) -> str:
    if launcher.lower().endswith('.cmd'):
        return '%s %s' % (windows_command_path(launcher), verb)
    return '"%s" %s' % (launcher, verb)


def hook_command(launcher: str = DEFAULT_LAUNCHER) -> str:
    return _command(launcher, 'hook')


def status_line(launcher: str = DEFAULT_LAUNCHER) -> dict:
    return {'type': 'command', 'command': _command(launcher, 'status')}


def _is_our_command(command, verb: str) -> bool:
    if not isinstance(command, str):
        return False
    m = _OUR_COMMAND_RE.match(command)
    return bool(m) and m.group(1) == verb


# The default launcher's commands (tests and older callers refer to these).
_NEW_HOOK_COMMAND = hook_command()
_NEW_STATUS_LINE = status_line()
# (event, matcher). `SessionStart` is restricted to `compact` (both `/compact` and
# automatic context compaction use this value; this is how the "just compacted" marker
# gets set) — `Stop`/`SessionEnd` don't have per-event matchers of their own, so `.*`.
# `UserPromptSubmit` (which clears that same marker) doesn't support a matcher either,
# so also `.*`.
_HOOK_EVENTS = (
    ('Stop', '.*'),
    ('SessionEnd', '.*'),
    ('SessionStart', 'compact'),
    ('UserPromptSubmit', '.*'),
)


def _is_old_hook_command(command) -> bool:
    return isinstance(command, str) and any(m in command for m in _OLD_HOOK_MARKERS)


def _update_hook_event(hooks_obj: dict, event: str, matcher: str, new_command: str) -> List[str]:
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
            if command == new_command:
                if entry.get('matcher') == matcher:
                    already_current = True
            elif _is_old_hook_command(command) or _is_our_command(command, 'hook'):
                # The old `cs` tool's hook, or ours pointing at another launcher.
                changes.append(i18n.t('setup.hook_migrated', event=event, old=command,
                                       new=new_command))
                h['command'] = new_command
                already_current = True
    if not already_current:
        entries.append({'matcher': matcher, 'hooks': [{'type': 'command', 'command': new_command}]})
        changes.append(i18n.t('setup.hook_added', event=event, matcher=matcher,
                               command=new_command))
    return changes


def _is_replaceable_status_line(current, new: dict) -> bool:
    """True when this statusLine should be replaced by `new`: unset, malformed, the literal
    old `cs` tool's invocation, or ours pointing at another launcher. Any other tool's
    statusLine — even one whose command happens to contain "cs" as a substring, like
    ccstatusline, or one that mentions "docs" — is left alone."""
    if current is None:
        return True
    if not isinstance(current, dict):
        return True
    command = current.get('command')
    if not isinstance(command, str):
        return True
    if command == new['command']:
        return False
    return any(m in command for m in _OLD_STATUS_LINE_MARKERS) or _is_our_command(command, 'status')


def _update_status_line(settings: dict, new: dict) -> Optional[str]:
    current = settings.get('statusLine')
    if not _is_replaceable_status_line(current, new):
        return None
    settings['statusLine'] = dict(new)
    return i18n.t('setup.status_line_set', old=current, new=new)


def compute_changes(settings: dict, launcher: str = DEFAULT_LAUNCHER) -> List[str]:
    """Rewrites `settings` in place, returning the list of change descriptions."""
    hooks_obj = settings.get('hooks')
    if not isinstance(hooks_obj, dict):
        hooks_obj = {}
        settings['hooks'] = hooks_obj
    changes: List[str] = []
    for event, matcher in _HOOK_EVENTS:
        changes.extend(_update_hook_event(hooks_obj, event, matcher, hook_command(launcher)))
    line_change = _update_status_line(settings, status_line(launcher))
    if line_change:
        changes.append(line_change)
    return changes


def _remove_hook_event(hooks_obj: dict, event: str) -> List[str]:
    """Removes only our own hook (whichever launcher it names) from `event`'s entries.

    An entry left with no hooks is dropped; if that empties `event`'s entries, the key
    itself is removed from `hooks_obj`. A hook some other tool added, or an entry for a
    different matcher, is left alone.
    """
    changes: List[str] = []
    entries = hooks_obj.get(event)
    if not isinstance(entries, list):
        return changes
    new_entries: List[dict] = []
    removed: List[str] = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get('hooks'), list):
            new_entries.append(entry)
            continue
        kept = []
        for h in entry['hooks']:
            if isinstance(h, dict) and _is_our_command(h.get('command'), 'hook'):
                removed.append(h['command'])
            else:
                kept.append(h)
        if kept:
            new_entry = dict(entry)
            new_entry['hooks'] = kept
            new_entries.append(new_entry)
        # An entry left with no `kept` hooks is simply not re-added.
    for command in dict.fromkeys(removed):
        changes.append(i18n.t('setup.hook_removed', event=event, command=command))
    if new_entries:
        hooks_obj[event] = new_entries
    elif event in hooks_obj:
        del hooks_obj[event]
    return changes


def _remove_status_line(settings: dict) -> Optional[str]:
    current = settings.get('statusLine')
    if isinstance(current, dict) and _is_our_command(current.get('command'), 'status'):
        del settings['statusLine']
        return i18n.t('setup.status_line_removed', old=current)
    return None


def compute_removal(settings: dict) -> List[str]:
    """The inverse of `compute_changes`: rewrites `settings` in place, returning change
    descriptions for only the hooks and statusLine this tool itself added. Leaves other
    hooks and any other statusLine alone. A no-op (empty result) when there's nothing of
    ours to remove — this makes `run_remove` idempotent."""
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


def _read_settings(settings_path: str) -> Tuple[bool, dict, Optional[str]]:
    """Reads `settings_path`. Returns `(existed, settings, original_text)` —
    `original_text` is `None` when the file didn't exist, and is otherwise the exact
    text read (used to write a byte-faithful backup, rather than a re-serialized
    round-trip of the parsed JSON).

    Raises `SettingsUnreadable` if the file exists but isn't valid JSON, or isn't a
    JSON object — this never falls back to treating it as `{}`.
    """
    if not os.path.exists(settings_path):
        return False, {}, None
    with open(settings_path, 'r', encoding='utf-8') as f:
        original_text = f.read()
    try:
        loaded = json.loads(original_text)
    except ValueError as e:
        raise SettingsUnreadable(str(e)) from e
    if not isinstance(loaded, dict):
        raise SettingsUnreadable('not a JSON object')
    return True, loaded, original_text


def _write_backup(settings_path: str, original_text: str) -> None:
    backup_path = settings_path + '.bak-' + time.strftime('%Y%m%d%H%M%S')
    with open(backup_path, 'w', encoding='utf-8') as f:
        f.write(original_text)


def run_remove(settings_path: str = DEFAULT_SETTINGS_PATH, dry_run: bool = False) -> Tuple[List[str], dict]:
    """The inverse of `run()`: reads `settings_path` and removes only the hooks and
    statusLine that `run()` itself added. A no-op (`([], {})`) if `settings_path`
    doesn't exist. Backs up first, the same way `run()` does, if there's anything to
    change.

    Raises `SettingsUnreadable` (writing nothing) if `settings_path` exists but can't
    be parsed as a JSON object.
    """
    existed, settings, original_text = _read_settings(settings_path)
    if not existed:
        return [], {}

    new_settings = copy.deepcopy(settings)
    changes = compute_removal(new_settings)

    if changes and not dry_run:
        assert original_text is not None
        _write_backup(settings_path, original_text)
        with open(settings_path, 'w', encoding='utf-8') as f:
            json.dump(new_settings, f, ensure_ascii=False, indent=2)
            f.write('\n')

    return changes, new_settings


def run(settings_path: str = DEFAULT_SETTINGS_PATH, dry_run: bool = False,
        launcher: str = DEFAULT_LAUNCHER) -> Tuple[List[str], dict]:
    """Reads `settings_path` and computes the changes — hooks and a statusLine running
    `launcher`. Unless `dry_run`, backs up the original and writes the result.

    Returns `(change descriptions, the new settings)`.

    Raises `SettingsUnreadable` (writing nothing) if `settings_path` exists but can't
    be parsed as a JSON object.
    """
    existed, settings, original_text = _read_settings(settings_path)

    new_settings = copy.deepcopy(settings)
    changes = compute_changes(new_settings, launcher)

    if changes and not dry_run:
        if existed:
            assert original_text is not None
            _write_backup(settings_path, original_text)
        dirpath = os.path.dirname(settings_path) or '.'
        os.makedirs(dirpath, exist_ok=True)
        with open(settings_path, 'w', encoding='utf-8') as f:
            json.dump(new_settings, f, ensure_ascii=False, indent=2)
            f.write('\n')

    return changes, new_settings

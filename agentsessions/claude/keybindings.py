"""Removes this tool's submit-key entries from `keybindings.json`.

The write side (`plugin/src/terminal/keybindings.ts`'s `applySubmitKey`, writing
`enter: chat:newline` / `meta+enter: chat:submit`) only exists in the plugin --
uninstalling is the only thing the Python side does with this file, so only the
removal rule lives here, kept in sync with the plugin's `OWNED_KEYS`/
`ownedCanonicalValue` (see that module's docstring for why there are six, not
two: `enter`/`meta+enter` are the only pair written today, but `cmd+enter`/
`ctrl+enter`/`shift+enter`/`alt+enter` are also "ours" to clean up, since an
earlier version or a hand-edited file could hold one of them). Remove a key
only if its value still matches its canonical one, leave a mismatched value in
place with a warning, and drop an emptied `Chat` block. A no-op if the file
doesn't exist.
"""
import json
import os
from typing import List, Optional, Tuple

from .. import i18n

# `enter`'s canonical (ours) value is `chat:newline`; every other owned key's
# is `chat:submit` -- mirrors `ownedCanonicalValue` in keybindings.ts.
OWNED_KEYS = {
    'enter': 'chat:newline',
    'meta+enter': 'chat:submit',
    'cmd+enter': 'chat:submit',
    'ctrl+enter': 'chat:submit',
    'shift+enter': 'chat:submit',
    'alt+enter': 'chat:submit',
}

SCHEMA_URL = 'https://www.schemastore.org/claude-code-keybindings.json'
DOCS_URL = 'https://code.claude.com/docs/en/keybindings'

DEFAULT_KEYBINDINGS_PATH = os.path.join(
    os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude'),
    'keybindings.json',
)


def _parse(text: str) -> Optional[dict]:
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get('bindings'), list):
        return None
    for b in data['bindings']:
        if not isinstance(b, dict) or not isinstance(b.get('context'), str):
            return None
    return data


def _find_chat(data: dict) -> Optional[dict]:
    for b in data['bindings']:
        if b.get('context') == 'Chat':
            return b
    return None


def remove_enter_keys(path: str = DEFAULT_KEYBINDINGS_PATH,
                       dry_run: bool = False) -> Tuple[bool, Optional[str]]:
    """Removes each of `OWNED_KEYS` from `Chat`, but only where the value still matches.

    Returns `(changed, warning)`. `changed` is `True` if at least one key was actually
    removed. `warning` explains that a mismatched key was left in place for the user to
    fix by hand.

    A no-op (`False, None`) if the file doesn't exist, or if there's nothing of ours to
    remove — this never rewrites the file (or touches `$schema`/`$docs`) when it isn't
    changing anything. Also returns a `warning` without writing if the JSON is
    malformed or not shaped as expected.
    """
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
    except FileNotFoundError:
        return False, None
    except OSError as e:
        return False, i18n.t('setup.keybindings_unreadable', error=e)

    data = _parse(text)
    if data is None:
        return False, i18n.t('setup.keybindings_broken', path=path)

    chat = _find_chat(data)
    mismatched: List[str] = []
    changed = False
    if chat is not None and isinstance(chat.get('bindings'), dict):
        for key, value in OWNED_KEYS.items():
            if chat['bindings'].get(key) == value:
                del chat['bindings'][key]
                changed = True
            elif key in chat['bindings']:
                mismatched.append(key)
        if not chat['bindings']:
            data['bindings'] = [b for b in data['bindings'] if b is not chat]

    if changed and not dry_run:
        if data.get('$schema') is None:
            data['$schema'] = SCHEMA_URL
        if data.get('$docs') is None:
            data['$docs'] = DOCS_URL
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    warning = None
    if mismatched:
        warning = i18n.t('setup.keybindings_mismatch',
                         keys=i18n.t('list_separator').join(mismatched))
    return changed, warning

"""Installing and removing the OpenCode status plugin
(`$XDG_CONFIG_HOME/opencode/plugins/agent-sessions.js`, default
`~/.config/opencode/plugins/`) -- the OpenCode analogue of the hooks
`claude.setup` writes into Claude Code's settings.

The file's first line is `plugin_js.MARKER`. An existing file without it is not
ours and is left alone (reported, never overwritten or removed); an existing
file that carries it is replaced when its content differs.
"""
import os
from typing import List, Optional

from ... import i18n
from .plugin_js import MARKER, PLUGIN_JS

PLUGIN_FILENAME = 'agent-sessions.js'


def default_plugin_path() -> str:
    base = os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config')
    return os.path.join(base, 'opencode', 'plugins', PLUGIN_FILENAME)


def _read(path: str) -> Optional[str]:
    try:
        with open(path, encoding='utf-8') as f:
            return f.read()
    except OSError:
        return None


def _is_ours(text: Optional[str]) -> bool:
    return text is not None and text.startswith(MARKER)


def install(path: Optional[str] = None, dry_run: bool = False) -> List[str]:
    """Writes (or updates) the plugin. Returns the change descriptions, `[]` if
    the file is already current."""
    path = path or default_plugin_path()
    existing = _read(path)
    if existing is not None and not _is_ours(existing):
        return [i18n.t('setup.opencode_foreign', path=path)]
    if existing == PLUGIN_JS:
        return []
    if not dry_run:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(PLUGIN_JS)
        os.replace(tmp, path)
    key = 'setup.opencode_updated' if existing is not None else 'setup.opencode_installed'
    return [i18n.t(key, path=path)]


def remove(path: Optional[str] = None, dry_run: bool = False) -> List[str]:
    """Deletes the plugin if it is ours. `[]` if there is none or it isn't ours."""
    path = path or default_plugin_path()
    existing = _read(path)
    if not _is_ours(existing):
        return []
    if not dry_run:
        try:
            os.unlink(path)
        except OSError:
            return []
    return [i18n.t('setup.opencode_removed', path=path)]

"""Installing and removing the OpenCode status plugin
(`$XDG_CONFIG_HOME/opencode/plugins/agent-sessions.js`, default
`~/.config/opencode/plugins/`) -- the OpenCode analogue of the hooks
`claude.setup` writes into Claude Code's settings.

The file's first line is `plugin_js.MARKER`. An existing file without it is not
ours and is left alone (reported, never overwritten or removed); an existing
file that carries it is replaced when its content differs.

`apply` reports what happened as a status (`INSTALLED`, `UPDATED`, `UNCHANGED`,
`FOREIGN`, `ABSENT`, `FAILED`) next to the human-readable lines, so a caller
can tell "installed" from "already current" or "left alone". `update_only`
refreshes an existing file of ours and never creates one.
"""
import os
from typing import List, Optional, Tuple

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


INSTALLED, UPDATED, UNCHANGED, FOREIGN, ABSENT, FAILED = (
    'installed', 'updated', 'unchanged', 'foreign', 'absent', 'failed')


def apply(path: Optional[str] = None, dry_run: bool = False,
          update_only: bool = False) -> Tuple[str, List[str]]:
    """Writes (or updates) the plugin. Returns `(status, change descriptions)`.
    A file system error is reported as `FAILED`, never raised."""
    path = path or default_plugin_path()
    existing = _read(path)
    if existing is not None and not _is_ours(existing):
        return FOREIGN, [i18n.t('setup.opencode_foreign', path=path)]
    if existing == PLUGIN_JS:
        return UNCHANGED, []
    if existing is None and update_only:
        return ABSENT, []
    if not dry_run:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                f.write(PLUGIN_JS)
            os.replace(tmp, path)
        except OSError as e:
            return FAILED, [i18n.t('setup.opencode_failed', path=path, error=e)]
    if existing is not None:
        return UPDATED, [i18n.t('setup.opencode_updated', path=path)]
    return INSTALLED, [i18n.t('setup.opencode_installed', path=path)]


def install(path: Optional[str] = None, dry_run: bool = False, update_only: bool = False) -> List[str]:
    """`apply`'s change descriptions: `[]` if the file is already current (or absent with `update_only`)."""
    return apply(path, dry_run=dry_run, update_only=update_only)[1]


def remove(path: Optional[str] = None, dry_run: bool = False) -> List[str]:
    """Deletes the plugin if it is ours. `[]` if there is none or it isn't ours."""
    path = path or default_plugin_path()
    existing = _read(path)
    if not _is_ours(existing):
        return []
    if not dry_run:
        try:
            os.unlink(path)
        except OSError as e:
            return [i18n.t('setup.opencode_failed', path=path, error=e)]
    return [i18n.t('setup.opencode_removed', path=path)]

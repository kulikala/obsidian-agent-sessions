"""Installing and removing the OpenCode status plugin
(`$XDG_CONFIG_HOME/opencode/plugins/agent-sessions.js`, default
`~/.config/opencode/plugins/`) -- the OpenCode analogue of the hooks
`claude.setup` writes into Claude Code's settings -- and its status line, a TUI
plugin beside it (`opencode/agent-sessions-tui.jsx`; a module is either a server or
a TUI plugin, and only `tui.json` loads TUI plugins, which the managed tui.json
writer sets up).

Each file's first line is `plugin_js.MARKER`. An existing file without it is not
ours and is left alone (reported, never overwritten or removed); an existing
file that carries it is replaced when its content differs. The two files follow
one lifecycle: `apply` writes both, `update_only` refreshes both once the status
plugin exists (which also brings the status line to a plugin installed before it
existed), `remove` deletes both.

`apply` reports what happened as a status (`INSTALLED`, `UPDATED`, `UNCHANGED`,
`FOREIGN`, `ABSENT`, `FAILED`) next to the human-readable lines, so a caller
can tell "installed" from "already current" or "left alone". `update_only`
refreshes an existing file of ours and never creates one.
"""
import os
from typing import List, Optional, Tuple

from ... import i18n
from .plugin_js import MARKER, PLUGIN_JS, TUI_PLUGIN_JSX

PLUGIN_FILENAME = 'agent-sessions.js'
TUI_PLUGIN_FILENAME = 'agent-sessions-tui.jsx'


def default_plugin_path() -> str:
    base = os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config')
    return os.path.join(base, 'opencode', 'plugins', PLUGIN_FILENAME)


def tui_plugin_path(plugin_path: str) -> str:
    """The status line file for a status plugin at `plugin_path`: in the folder above `plugins/`."""
    return os.path.join(os.path.dirname(os.path.dirname(plugin_path)), TUI_PLUGIN_FILENAME)


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


def _write(path: str, text: str, dry_run: bool, update_only: bool) -> Tuple[str, List[str]]:
    existing = _read(path)
    if existing is not None and not _is_ours(existing):
        return FOREIGN, [i18n.t('setup.opencode_foreign', path=path)]
    if existing == text:
        return UNCHANGED, []
    if existing is None and update_only:
        return ABSENT, []
    if not dry_run:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                f.write(text)
            os.replace(tmp, path)
        except OSError as e:
            return FAILED, [i18n.t('setup.opencode_failed', path=path, error=e)]
    if existing is not None:
        return UPDATED, [i18n.t('setup.opencode_updated', path=path)]
    return INSTALLED, [i18n.t('setup.opencode_installed', path=path)]


def apply(path: Optional[str] = None, dry_run: bool = False,
          update_only: bool = False) -> Tuple[str, List[str]]:
    """Writes (or updates) the status plugin and the status line. Returns `(status, change
    descriptions)`; the status is the status plugin's, except that a status line that had to be
    written or updated turns `UNCHANGED` into `UPDATED`, and a failure to write it is `FAILED`.
    A file system error is reported as `FAILED`, never raised."""
    path = path or default_plugin_path()
    status, changes = _write(path, PLUGIN_JS, dry_run, update_only)
    if status in (ABSENT, FOREIGN, FAILED):
        return status, changes
    # The status line is created too when only the older status plugin was there: `update_only`
    # means "keep what is installed current", not "never add a file".
    line_status, line_changes = _write(tui_plugin_path(path), TUI_PLUGIN_JSX, dry_run, False)
    changes = changes + line_changes
    if line_status == FAILED:
        return FAILED, changes
    if status == UNCHANGED and line_status in (INSTALLED, UPDATED):
        status = UPDATED
    return status, changes


def install(path: Optional[str] = None, dry_run: bool = False, update_only: bool = False) -> List[str]:
    """`apply`'s change descriptions: `[]` if the files are already current (or absent with `update_only`)."""
    return apply(path, dry_run=dry_run, update_only=update_only)[1]


def remove(path: Optional[str] = None, dry_run: bool = False) -> List[str]:
    """Deletes the status plugin and the status line if they are ours. `[]` if there is none or
    they aren't ours."""
    path = path or default_plugin_path()
    changes: List[str] = []
    for target in (path, tui_plugin_path(path)):
        if not _is_ours(_read(target)):
            continue
        if not dry_run:
            try:
                os.unlink(target)
            except OSError as e:
                changes.append(i18n.t('setup.opencode_failed', path=target, error=e))
                continue
        changes.append(i18n.t('setup.opencode_removed', path=target))
    return changes

"""Removes only the lines this project added to Codex CLI's own config
(`~/.codex/config.toml`, respecting `CODEX_HOME`) -- the plugin (T-108) is
what writes them (the submit-key keymap, and `[tui]` `status_line` only when
it wasn't already set), marking each written line with a trailing comment
(`MANAGED_MARKER`). This module is `agent-sessions setup --remove`/
`uninstall.sh`'s side of that.

Line-based removal only, never a TOML parse-and-rewrite: this project
supports Python 3.9 (`tomllib` is 3.11+), and even with a TOML library
available, re-serializing the whole file risks reformatting or reordering
content that had nothing to do with this project (comments, blank-line
spacing, key order) just because *something* in the file changed. A line
either ends with the marker (ours -- drop it entirely) or it doesn't (never
touched, byte-for-byte) -- nothing else about the file is inferred or
tidied up (an orphaned, now-empty section header is left exactly as it is,
matching the plugin's own "only the marked line" writing contract).
"""
import os
import time
from typing import List, Optional, Tuple

from .. import i18n

# Written at the end of every line this project adds to config.toml (agreed
# with lnx-ts for T-108/T-109). A line is "ours" if it ends with this after
# trailing whitespace is stripped -- never a substring match elsewhere on the
# line, so a value that happens to contain this text is never mistaken for
# one of our own lines.
MANAGED_MARKER = '# managed by Agent Sessions'

DEFAULT_CONFIG_TOML_PATH = os.path.join(
    os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex'), 'config.toml')


def _is_managed_line(line: str) -> bool:
    return line.rstrip('\r\n').rstrip().endswith(MANAGED_MARKER)


def compute_removal(text: str) -> Tuple[str, bool]:
    """`(new_text, changed)`. Drops every line ending with `MANAGED_MARKER`;
    every other line -- including blank lines and section headers, even ones
    that end up with nothing left under them -- is kept exactly as it was."""
    lines = text.splitlines(keepends=True)
    kept = [line for line in lines if not _is_managed_line(line)]
    changed = len(kept) != len(lines)
    return ''.join(kept), changed


def _write_backup(path: str, original_text: str) -> None:
    backup_path = path + '.bak-' + time.strftime('%Y%m%d%H%M%S')
    with open(backup_path, 'w', encoding='utf-8') as f:
        f.write(original_text)


def remove_managed_lines(path: str = DEFAULT_CONFIG_TOML_PATH,
                          dry_run: bool = False) -> Tuple[bool, Optional[str]]:
    """Removes every `MANAGED_MARKER`-ed line from `path`. Returns `(changed,
    message)` -- `changed` is `True` if at least one line was removed;
    `message` describes what happened (for `agent-sessions setup --remove`'s
    output), or is `None` for a no-op.

    A no-op (`False, None`) if the file doesn't exist, or has nothing of ours
    to remove -- never rewrites the file (or creates a backup) when nothing
    is changing. Backs up first (same convention as `claude.setup`/
    `claude.keybindings`) when something is."""
    try:
        with open(path, encoding='utf-8') as f:
            original_text = f.read()
    except FileNotFoundError:
        return False, None
    except OSError as e:
        return False, i18n.t('setup.config_toml_unreadable', error=e)

    new_text, changed = compute_removal(original_text)
    if not changed:
        return False, None

    if not dry_run:
        _write_backup(path, original_text)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new_text)

    return True, i18n.t('setup.config_toml_removed', path=path)

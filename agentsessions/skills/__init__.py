"""The agent skills Agent Sessions installs into a vault (`agent-sessions setup --skills`).

One skill, `agent-sessions`, ships inside the program (start a session, usage statistics, other
sessions; the `SKILL.md` template sits next to this file). It is installed as a *project* skill of the vault, in the folders
each agent reads them from when it runs in the vault:

    Claude Code   <vault>/.claude/skills/<name>/SKILL.md      (OpenCode reads this too)
    Codex         <vault>/.agents/skills/<name>/SKILL.md      (OpenCode reads this too)
    OpenCode      <vault>/.opencode/skills/<name>/SKILL.md    (only when neither of the above is wanted)

Codex does not read the Claude Code folder, and Claude Code reads neither of the others, so each
enabled agent of those two gets its own folder; OpenCode reads all three, so it needs a folder of its
own only when it is the sole agent (and a name found in two folders is listed once).

Every file written carries a marker. A skill folder whose `SKILL.md` lacks it is somebody else's and
is never overwritten or removed. The bodies name the launcher by the path given at install time.
"""
import os
from typing import List, Optional, Tuple

from .. import i18n

MARKER = '<!-- agent-sessions:managed - written by `agent-sessions setup --skills`; edits are overwritten -->'
YAML_MARKER = '# agent-sessions:managed - written by `agent-sessions setup --skills`; edits are overwritten'
SKILL_NAMES = ('agent-sessions',)
# The three skills earlier versions installed; ours (marked) are removed on install, whatever the agents.
LEGACY_SKILL_NAMES = ('agent-sessions-new', 'agent-sessions-stats', 'agent-sessions-info')
SKILL_FILE = 'SKILL.md'
# Earlier versions wrote Codex's `agents/openai.yaml` (an implicit-invocation policy) next to a skill.
CODEX_POLICY_FILE = os.path.join('agents', 'openai.yaml')

CLAUDE_DIR = os.path.join('.claude', 'skills')
CODEX_DIR = os.path.join('.agents', 'skills')
OPENCODE_DIR = os.path.join('.opencode', 'skills')
ALL_DIRS = (CLAUDE_DIR, CODEX_DIR, OPENCODE_DIR)

INSTALLED, UPDATED, UNCHANGED, FOREIGN, ABSENT, FAILED = (
    'installed', 'updated', 'unchanged', 'foreign', 'absent', 'failed')


def default_launcher() -> str:
    """The launcher of the program this module belongs to, `$HOME/...` when it lives under the home
    directory (a vault synced between machines keeps working)."""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    path = os.path.join(root, 'bin', 'agent-sessions')
    rel = os.path.relpath(path, os.path.expanduser('~'))
    return '$HOME/' + rel if not rel.startswith('..') and not os.path.isabs(rel) else path


def wanted_dirs(agents: List[str]) -> List[str]:
    """The folders (relative to the vault) the enabled `agents` need, in `ALL_DIRS` order."""
    out = []
    if 'claude' in agents:
        out.append(CLAUDE_DIR)
    if 'codex' in agents:
        out.append(CODEX_DIR)
    if 'opencode' in agents and not out:
        out.append(OPENCODE_DIR)
    return out


def render(name: str, launcher: str) -> str:
    """`name`'s `SKILL.md`: the template with the marker and the launcher filled in."""
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), name, SKILL_FILE), encoding='utf-8') as f:
        text = f.read()
    return text.replace('{{MARKER}}', MARKER).replace('{{LAUNCHER}}', launcher)


def _read(path: str) -> Optional[str]:
    try:
        with open(path, encoding='utf-8') as f:
            return f.read()
    except OSError:
        return None


def _managed(text: Optional[str]) -> bool:
    return text is not None and (MARKER in text or text.startswith(YAML_MARKER))


def _write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)


def _files_of(name: str, base: str, launcher: str) -> List[Tuple[str, str]]:
    return [(os.path.join(base, name, SKILL_FILE), render(name, launcher))]


def install(vault: str, agents: List[str], launcher: Optional[str] = None,
            dry_run: bool = False) -> Tuple[str, List[str]]:
    """Writes the skills the enabled `agents` need into `vault` and removes our copies from the other
    folders. Returns `(status, change descriptions)`; the status is the most notable outcome (`failed`,
    `foreign`, `installed`, `updated`, `unchanged`, in that order). A file is written only when its
    text differs, so running this again with the same agents and launcher changes nothing."""
    launcher = launcher or default_launcher()
    wanted = wanted_dirs(agents)
    changes: List[str] = []
    seen = set()
    for base in ALL_DIRS:
        # Our copies of the skills earlier versions installed go from every folder.
        changes.extend(_remove_dir(vault, base, dry_run, LEGACY_SKILL_NAMES))
        if base not in wanted:
            changes.extend(_remove_dir(vault, base, dry_run))
            continue
        for name in SKILL_NAMES:
            for rel, text in _files_of(name, base, launcher):
                path = os.path.join(vault, rel)
                existing = _read(path)
                if existing is not None and not _managed(existing):
                    seen.add(FOREIGN)
                    changes.append(i18n.t('setup.skill_foreign', path=path))
                    continue
                if existing == text:
                    seen.add(UNCHANGED)
                    continue
                if not dry_run:
                    try:
                        _write(path, text)
                    except OSError as e:
                        seen.add(FAILED)
                        changes.append(i18n.t('setup.skill_failed', path=path, error=e))
                        continue
                seen.add(UPDATED if existing is not None else INSTALLED)
                changes.append(i18n.t('setup.skill_updated' if existing is not None else 'setup.skill_installed',
                                      path=path))
    for status in (FAILED, FOREIGN, INSTALLED, UPDATED, UNCHANGED):
        if status in seen:
            return status, changes
    return (ABSENT if not wanted else UNCHANGED), changes


def _remove_dir(vault: str, base: str, dry_run: bool, names: Tuple[str, ...] = SKILL_NAMES + LEGACY_SKILL_NAMES) -> List[str]:
    changes: List[str] = []
    for name in names:
        folder = os.path.join(vault, base, name)
        for rel in (SKILL_FILE, CODEX_POLICY_FILE):
            path = os.path.join(folder, rel)
            if not _managed(_read(path)):
                continue
            if not dry_run:
                try:
                    os.unlink(path)
                except OSError as e:
                    changes.append(i18n.t('setup.skill_failed', path=path, error=e))
                    continue
            changes.append(i18n.t('setup.skill_removed', path=path))
        if not dry_run:
            # Only empty folders go: anything else in there is not ours.
            for d in (os.path.join(folder, 'agents'), folder):
                try:
                    os.rmdir(d)
                except OSError:
                    pass
    if changes and not dry_run:
        # The skills folder and its parent go too when that leaves them empty (`rmdir` refuses otherwise).
        for d in (os.path.join(vault, base), os.path.dirname(os.path.join(vault, base))):
            try:
                os.rmdir(d)
            except OSError:
                pass
    return changes


def remove(vault: str, dry_run: bool = False) -> List[str]:
    """Removes every skill file of ours from every folder (`[]` when there is none), and the folders
    that are left empty. Files without the marker stay."""
    changes: List[str] = []
    for base in ALL_DIRS:
        changes.extend(_remove_dir(vault, base, dry_run))
    return changes

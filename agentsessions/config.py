import json
import os
from typing import Optional

RUNTIME_DIR = os.path.expanduser('~/.agents/sessions')
# Written by the plugin on load ({"vault": "<path>"}, atomically via tmp->rename).
# How code outside Obsidian (the TUI, the CLI) learns where the vault is.
VAULT_STATE_PATH = os.path.join(RUNTIME_DIR, 'vault.json')

VAULT_NOT_CONFIGURED_MESSAGE = (
    'Agent Sessions could not find your vault. Enable the Agent Sessions plugin '
    'once in Obsidian, or set the AGENT_SESSIONS_VAULT environment variable.'
)


class VaultNotConfigured(RuntimeError):
    """Raised when something that needs the vault is called before we know where it is."""


def _read_vault_state() -> Optional[str]:
    try:
        with open(VAULT_STATE_PATH, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    vault = data.get('vault')
    return vault if isinstance(vault, str) and vault else None


def _resolve_vault() -> Optional[str]:
    """env `AGENT_SESSIONS_VAULT` -> `VAULT_STATE_PATH` -> `None` (not configured).

    Both are checked exactly once, at import time (the same contract as every other
    `config.*` constant — tests override it with `mock.patch.object(config, 'VAULT', ...)`
    rather than passing paths around, which is also why this has no fixed absolute-path
    default).
    """
    return os.environ.get('AGENT_SESSIONS_VAULT') or _read_vault_state()


VAULT: Optional[str] = _resolve_vault()


def require_vault() -> str:
    """Returns `VAULT`, or raises `VaultNotConfigured` (a clear, plain-English message) if `None`."""
    if VAULT:
        return VAULT
    raise VaultNotConfigured(VAULT_NOT_CONFIGURED_MESSAGE)


def _vault_path(*parts: str) -> Optional[str]:
    """`None` when `VAULT` is `None`, so this module still imports fine without a vault."""
    return os.path.join(VAULT, *parts) if VAULT else None


STORE_DIR = _vault_path('.agents', 'sessions')
STORE_PATH = _vault_path('.agents', 'sessions', 'sessions.json')
LOCK_DIR = (STORE_PATH + '.lock') if STORE_PATH else None
SOCK_PATH = os.path.join(RUNTIME_DIR, 'daemon.sock')
PLUGIN_SOCK_PATH = os.path.join(RUNTIME_DIR, 'plugin.sock')
PID_PATH = os.path.join(RUNTIME_DIR, 'daemon.pid')
LOG_PATH = os.path.join(RUNTIME_DIR, 'daemon.log')
EXITED_PATH = os.path.join(RUNTIME_DIR, 'exited.json')
EVENTS_LOG = os.path.join(RUNTIME_DIR, 'events.log')
CACHE_PATH = os.path.join(RUNTIME_DIR, 'scan-cache.json')
STATUS_DIR = os.path.join(RUNTIME_DIR, 'status')
STATS_CACHE_PATH = os.path.join(RUNTIME_DIR, 'stats-cache.json')
# Last-known-good {thread_id: {"name", "title"}} from state_5.sqlite (T-105):
# a fallback for when the database genuinely can't be opened read-only right
# now (e.g. no -wal file and no running codex to have created one), so a
# session's name doesn't disappear just because this one read attempt failed.
CODEX_NAMES_CACHE_PATH = os.path.join(RUNTIME_DIR, 'codex-names-cache.json')
# Marks a session as just-compacted, before the next prompt is sent. Written on
# `SessionStart` (source=compact), removed on `UserPromptSubmit`/`SessionEnd`.
COMPACTED_DIR = os.path.join(RUNTIME_DIR, 'compacted')
# Where the plugin writes the submit-key symbol; `format_status_line` reads it.
UI_STATE_PATH = os.path.join(RUNTIME_DIR, 'ui.json')

PROJECTS_DIR = os.path.expanduser('~/.claude/projects')
SESSIONS_DIR = os.path.expanduser('~/.claude/sessions')

# The identifier for the "Other" group (a key in the store's folded-groups list): the one
# group that combines named sessions with no category and sessions with no name. Kept in
# Japanese rather than translated, because it's persisted — it's written into existing
# users' sessions.json as a folded-group key, and changing the value would silently
# un-fold that group for everyone who had it folded. Matches `OTHER_GROUP` in
# `plugin/src/tree.ts`, and is displayed as-is even in an English-language UI.
OTHER_GROUP = 'その他のセッション'

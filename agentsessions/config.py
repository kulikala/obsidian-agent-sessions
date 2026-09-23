import json
import os
from typing import Optional

RUNTIME_DIR = os.path.expanduser('~/.agents/sessions')
# プラグインが起動時に書く（{"vault": "<path>"}、原子的に tmp→rename。T-80）。
# Obsidian の外（TUI・CLI）から vault の場所を知る手段。
VAULT_STATE_PATH = os.path.join(RUNTIME_DIR, 'vault.json')

VAULT_NOT_CONFIGURED_MESSAGE = (
    'Agent Sessions could not find your vault. Enable the Agent Sessions plugin '
    'once in Obsidian, or set the AGENT_SESSIONS_VAULT environment variable.'
)


class VaultNotConfigured(RuntimeError):
    """vault が分からない状態で、vault が要る処理が呼ばれた（T-80）。"""


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
    """env `AGENT_SESSIONS_VAULT` → `VAULT_STATE_PATH` → `None`（未設定）。

    どちらも `import` 時に 1 回だけ見る（他の `config.*` と同じ約束——差し替えは
    `mock.patch.object(config, 'VAULT', ...)` で行う。テストで差し替えられるよう、
    値は固定の絶対パスを持たない。§T-80）。
    """
    return os.environ.get('AGENT_SESSIONS_VAULT') or _read_vault_state()


VAULT: Optional[str] = _resolve_vault()


def require_vault() -> str:
    """`VAULT` を返す。`None` なら `VaultNotConfigured`（分かりやすい英語メッセージ）。"""
    if VAULT:
        return VAULT
    raise VaultNotConfigured(VAULT_NOT_CONFIGURED_MESSAGE)


def _vault_path(*parts: str) -> Optional[str]:
    """`VAULT` が `None` なら `None`（vault 無しでも `import` できるように。§T-80）。"""
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
# compact 直後・まだ次の指示を送っていないセッションの印（T-77 追補）。
# `SessionStart`（source=compact）で書き、`UserPromptSubmit`・`SessionEnd` で消す。
COMPACTED_DIR = os.path.join(RUNTIME_DIR, 'compacted')
# プラグインが送信キーの記号を書く場所（T-71）。`format_status_line` が読む。
UI_STATE_PATH = os.path.join(RUNTIME_DIR, 'ui.json')

PROJECTS_DIR = os.path.expanduser('~/.claude/projects')
SESSIONS_DIR = os.path.expanduser('~/.claude/sessions')

OTHER_GROUP = 'その他のセッション'

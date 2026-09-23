import os

VAULT = os.environ.get(
    'AGENT_SESSIONS_VAULT',
    '/path/to/vault',
)
STORE_DIR = os.path.join(VAULT, '.agents', 'sessions')
STORE_PATH = os.path.join(STORE_DIR, 'sessions.json')
LOCK_DIR = STORE_PATH + '.lock'

RUNTIME_DIR = os.path.expanduser('~/.agents/sessions')
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

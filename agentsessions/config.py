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
PID_PATH = os.path.join(RUNTIME_DIR, 'daemon.pid')
LOG_PATH = os.path.join(RUNTIME_DIR, 'daemon.log')
EXITED_PATH = os.path.join(RUNTIME_DIR, 'exited.json')
EVENTS_LOG = os.path.join(RUNTIME_DIR, 'events.log')
CACHE_PATH = os.path.join(RUNTIME_DIR, 'scan-cache.json')
STATUS_DIR = os.path.join(RUNTIME_DIR, 'status')

PROJECTS_DIR = os.path.expanduser('~/.claude/projects')
SESSIONS_DIR = os.path.expanduser('~/.claude/sessions')

OTHER_GROUP = 'その他のセッション'

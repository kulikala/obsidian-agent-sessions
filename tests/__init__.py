# Keeps the whole test run away from the real runtime directory and vault. `agentsessions.config`
# resolves both once, at import (`RUNTIME_DIR` from AGENT_SESSIONS_RUNTIME_DIR, `VAULT` from
# AGENT_SESSIONS_VAULT or `<RUNTIME_DIR>/vault.json`), so they are pointed at a throwaway
# directory before any test module imports it. A test that forgets its own `--vault` or runtime
# override then acts on this directory, never on the user's vault or daemon.
import os
import tempfile

_SANDBOX = tempfile.mkdtemp(prefix='agent-sessions-tests-')
os.environ['AGENT_SESSIONS_RUNTIME_DIR'] = os.path.join(_SANDBOX, 'runtime')
os.environ['AGENT_SESSIONS_VAULT'] = os.path.join(_SANDBOX, 'vault')

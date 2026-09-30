"""How to start a session of each agent from outside Obsidian (`agent-sessions new`).

The plugin launches sessions with argv and an environment it assembles from its own
settings (`buildAgentArgv`, `launchArgv`, `editorEnv` and the per-agent "environment
variables" in `plugin/src/main.ts` and `plugin/src/backend/backend.ts`). The parts of
those settings a launch needs are mirrored into `ui.json` under `agentLaunch`
(`plugin/src/backend/ui-state.ts`), and this module rebuilds the same argv and env from
that mirror, so a session started by the CLI is the one the plugin would have started.

    "agentLaunch": {
      "claude":   {"path": "", "env": {"KEY": "VALUE"}},
      "codex":    {"path": "", "env": {}},
      "opencode": {"path": "", "env": {}, "launchVia": "opencode" | "ollama", "ollamaModel": ""}
    }

Everything here is pure except `read_launch_config` and `find_binary`.
"""
import json
import os
import shutil
from typing import Dict, List, Mapping, Optional

from .. import config

# What the plugin passes on from the login shell (`LOGIN_ENV_KEYS` in backend.ts). A session
# started here gets exactly these from the caller and nothing else, which also leaves out
# everything that marks the caller as a session of its own (`CLAUDECODE`, `CLAUDE_PID`,
# `CLAUDE_EFFORT`, `CLAUDE_CODE_*`, `CLAUDE_PLUGIN_*`, `AGENT_SESSIONS_ID`, `CODEX_THREAD_ID`,
# `OPENCODE_PID`, ...): inherited, those would make the new session look like a child.
INHERITED_ENV_KEYS = ('PATH', 'LANG', 'HOME', 'USER', 'TMPDIR', 'CLAUDE_CONFIG_DIR')

BIN_NAMES = {'claude': 'claude', 'codex': 'codex', 'opencode': 'opencode'}


class LaunchError(RuntimeError):
    """A session can't be started (missing binary, missing model, ...); the message is for the user."""


def read_launch_config(path: Optional[str] = None) -> Dict[str, dict]:
    """`agentLaunch` from `ui.json`, keeping only well-formed per-agent entries. `{}` when the file
    or the key is missing or malformed."""
    try:
        with open(path or config.UI_STATE_PATH, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    launch = data.get('agentLaunch') if isinstance(data, dict) else None
    if not isinstance(launch, dict):
        return {}
    out: Dict[str, dict] = {}
    for agent in BIN_NAMES:
        entry = launch.get(agent)
        if not isinstance(entry, dict):
            continue
        env = entry.get('env')
        out[agent] = {
            'path': entry['path'] if isinstance(entry.get('path'), str) else '',
            'env': {str(k): str(v) for k, v in env.items()} if isinstance(env, dict) else {},
            'launchVia': entry.get('launchVia') if entry.get('launchVia') in ('opencode', 'ollama') else 'opencode',
            'ollamaModel': entry['ollamaModel'].strip() if isinstance(entry.get('ollamaModel'), str) else '',
        }
    return out


def find_binary(agent: str, configured: str, search_path: Optional[str]) -> str:
    """The agent's executable: the configured path if set, else the first match on `search_path`."""
    if configured:
        return configured
    found = shutil.which(BIN_NAMES[agent], path=search_path)
    if not found:
        raise LaunchError('%s was not found on PATH; set its path in the Agent Sessions settings'
                          % BIN_NAMES[agent])
    return found


def inherited_env(environ: Mapping[str, str]) -> Dict[str, str]:
    return {k: environ[k] for k in INHERITED_ENV_KEYS if k in environ}


def editor_env(agent: str, shim: Optional[str]) -> Dict[str, str]:
    """`VISUAL` for the built-in editor (`EDITOR` too for OpenCode, which reads only that)."""
    if not shim:
        return {}
    return {'VISUAL': shim, 'EDITOR': shim} if agent == 'opencode' else {'VISUAL': shim}


def build_env(agent: str, environ: Mapping[str, str], agent_env: Mapping[str, str], bin_path: str,
              vault: Optional[str], shim: Optional[str]) -> Dict[str, str]:
    """The plugin's order: login env, editor env, the vault, then the agent's own variables (so the
    user can override any of the above); `bin_path`'s directory goes onto PATH last."""
    env = inherited_env(environ)
    env.update(editor_env(agent, shim))
    if vault:
        env['AGENT_SESSIONS_VAULT'] = vault
    env.update(agent_env)
    bin_dir = os.path.dirname(bin_path)
    env['PATH'] = bin_dir + os.pathsep + env['PATH'] if env.get('PATH') else bin_dir
    return env


def build_argv(agent: str, bin_path: str, session_id: str, name: Optional[str] = None,
               remote_control: bool = False, prompt: Optional[str] = None,
               ollama_bin: Optional[str] = None, ollama_model: str = '') -> List[str]:
    """argv for a fresh session. Claude Code takes its id (`--session-id`), name (`--name`) and Remote
    Control (`--remote-control[=name]`) as flags; Codex and OpenCode decide their own ids and take no
    name at launch. `prompt` is the session's first message. OpenCode set to start through ollama
    goes through `ollama launch opencode --model <M> -y --`."""
    if agent == 'codex':
        return [bin_path] + (['--', prompt] if prompt else [])
    if agent == 'opencode':
        tail = ['--prompt', prompt] if prompt else []
        if ollama_bin:
            return [ollama_bin, 'launch', 'opencode', '--model', ollama_model, '-y', '--'] + tail
        return [bin_path] + tail
    argv = [bin_path, '--session-id', session_id]
    if name:
        argv += ['--name', name]
    if remote_control:
        argv.append('--remote-control=' + name if name else '--remote-control')
    if prompt:
        argv += ['--', prompt]
    return argv

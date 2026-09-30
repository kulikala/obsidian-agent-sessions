"""`agent-sessions new [--agent A] [--cwd DIR] [--name N] [--remote-control] [--prompt TEXT]
[--timeout S] [--json]`.

Starts a session the way the plugin does: registers it in `sessions.json`, makes sure the daemon is
up, and asks it to `start` the agent with the argv and env the plugin would use
(`agentsessions/agents/launch.py`). The session runs in the daemon, so it keeps going without any
window and is opened from Obsidian's Agent Sessions list or with `agent-sessions attach <id>`.

Claude Code takes its id, name and Remote Control as flags; the transcript then confirms the name
(`custom-title`) and the Remote Control URL (`system/bridge_status`). Codex and OpenCode choose their
own ids and only record a session once its first message is sent, so the command waits for
`json resolve` to learn the real id (which needs `--prompt`) and links it in `sessions.json`
(design.md 3.3); their name is kept in `sessions.json` (OpenCode) or not applied (Codex has no way
to name a session at launch).

Exit codes: 0 = started and confirmed, 1 = started but not confirmed in time (the session keeps
running; never retry, or there will be two), 2 = could not start.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from .. import agents, config
from ..agents import claude as claude_agent
from ..agents import launch
from ..sessions import store
from . import json_output

DEFAULT_TIMEOUT = 60.0
POLL_SECONDS = 1.0
SETTLE_SECONDS = 2.0
DAEMON_START_ATTEMPTS = 8


class Failure(Exception):
    """Could not start (exit 2). The message is printed as is."""


# ---- Pure helpers ----------------------------------------------------------------------------

def package_root() -> str:
    """The install directory: the parent of the `agentsessions` package (and of `bin/`)."""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def launcher_path() -> str:
    return os.path.join(package_root(), 'bin', 'agent-sessions')


def shim_path() -> Optional[str]:
    path = os.path.join(package_root(), 'bin', 'agent-sessions-code')
    return path if os.path.exists(path) else None


def caller_agent(environ: Dict[str, str], daemon_sessions: List[dict]) -> Optional[str]:
    """The agent the calling process runs under: the daemon's record of `AGENT_SESSIONS_ID` first, then
    the markers each agent leaves in its tools' environment. `None` when the caller is none of them."""
    own = environ.get('AGENT_SESSIONS_ID')
    if own:
        for s in daemon_sessions:
            if isinstance(s, dict) and s.get('id') == own and s.get('agent') in launch.BIN_NAMES:
                return s['agent']
    if environ.get('CLAUDECODE') or environ.get('CLAUDE_CODE_SESSION_ID'):
        return 'claude'
    if environ.get('CODEX_THREAD_ID'):
        return 'codex'
    if environ.get('OPENCODE_PID'):
        return 'opencode'
    return None


def choose_agent(requested: Optional[str], caller: Optional[str], enabled: List[str]) -> str:
    agent = requested or (caller if caller in enabled else None) or (enabled[0] if enabled else 'claude')
    if agent not in launch.BIN_NAMES:
        raise Failure('unknown agent: %s (choose from %s)' % (agent, ', '.join(launch.BIN_NAMES)))
    if agent not in enabled:
        raise Failure('%s is not enabled in Agent Sessions (enabled: %s)' % (agent, ', '.join(enabled) or 'none'))
    return agent


def read_claude_progress(path: str) -> Tuple[Optional[str], Optional[str]]:
    """`(name, remote control url)` from a Claude Code transcript: the latest `custom-title` and the
    latest `system/bridge_status` that carries a `url`."""
    title = url = None
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(ev, dict):
                    continue
                if ev.get('type') == 'custom-title':
                    title = ev.get('customTitle')
                elif ev.get('type') == 'system' and ev.get('subtype') == 'bridge_status' and ev.get('url'):
                    url = ev['url']
    except OSError:
        pass
    return title, url


# ---- Daemon ----------------------------------------------------------------------------------

def _daemon(op: str, **fields: Any) -> Optional[dict]:
    return json_output.send_daemon_op(op, client='cli', **fields)


def ensure_daemon() -> None:
    """Starts the daemon (detached) when nothing answers on its socket, as the plugin does."""
    if _daemon('list') is not None:
        return
    subprocess.Popen([sys.executable, launcher_path(), 'daemon', '--detach'], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                     env=dict(os.environ))
    for _ in range(DAEMON_START_ATTEMPTS):
        time.sleep(0.5)
        if _daemon('list') is not None:
            return
    raise Failure('cannot reach the Agent Sessions daemon: %s' % json_output.daemon_sock_path())


def _daemon_session(daemon_id: str) -> Optional[dict]:
    resp = _daemon('list')
    for s in (resp or {}).get('sessions', []):
        if isinstance(s, dict) and s.get('id') == daemon_id:
            return s
    return None


# ---- The command -----------------------------------------------------------------------------

def parse_args(argv: List[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog='agent-sessions new', description='Start a new agent session in the daemon')
    p.add_argument('--agent', choices=list(launch.BIN_NAMES), default=None,
                   help="which agent (default: the calling session's own agent)")
    p.add_argument('--cwd', default=None, help='working folder (default: the current folder)')
    p.add_argument('--name', default=None, help='session name')
    p.add_argument('--remote-control', action='store_true', help='Claude Code only: enable Remote Control')
    p.add_argument('--prompt', default=None, help="the session's first message")
    p.add_argument('--timeout', type=float, default=DEFAULT_TIMEOUT, help='seconds to wait for confirmation')
    p.add_argument('--json', action='store_true', help='machine-readable output')
    return p.parse_args(argv)


def _register_claude(sid: str, cwd: str, warnings: List[str]) -> None:
    if not config.STORE_PATH:
        warnings.append('the vault is not configured, so sessions.json was not updated '
                        '(the session may not show in the Obsidian list)')
        return
    try:
        store.update(lambda st: st.sessions.__setitem__(sid, {'agent': 'claude', 'cwd': cwd}), config.STORE_PATH)
    except Exception as e:  # noqa: BLE001 -- the session itself can still start
        warnings.append('could not register the session in sessions.json: %s' % e)


def _link(agent: str, real_id: str, cwd: str, daemon_id: str, name: Optional[str], warnings: List[str]) -> bool:
    if not config.STORE_PATH:
        warnings.append('the vault is not configured, so the session was not linked in sessions.json')
        return False
    entry: Dict[str, Any] = {'agent': agent, 'cwd': cwd, 'daemon': daemon_id}
    if name and agent == 'opencode':
        entry['name'] = name
    try:
        store.update(lambda st: st.sessions.__setitem__(real_id, entry), config.STORE_PATH)
        return True
    except Exception as e:  # noqa: BLE001
        warnings.append('could not link the session in sessions.json: %s' % e)
        return False


def start(ns: argparse.Namespace, environ: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Runs the whole flow and returns the result dict (`exit` is the exit code)."""
    environ = dict(os.environ if environ is None else environ)
    cwd = os.path.abspath(ns.cwd or os.getcwd())
    if not os.path.isdir(cwd):
        raise Failure('no such folder: %s' % cwd)
    name = (ns.name or '').strip() or None
    prompt = (ns.prompt or '').strip() or None
    warnings: List[str] = []

    ensure_daemon()
    listing = _daemon('list') or {}
    agent = choose_agent(ns.agent, caller_agent(environ, listing.get('sessions', [])), agents.enabled_agents())
    if ns.remote_control and agent != 'claude':
        warnings.append('--remote-control is only for Claude Code; ignored for %s' % agent)
    rc = ns.remote_control and agent == 'claude'
    if name and agent == 'codex':
        warnings.append('Codex cannot be named at launch; use /rename in the session')

    cfg = launch.read_launch_config().get(agent, {})
    try:
        bin_path = launch.find_binary(agent, cfg.get('path', ''), environ.get('PATH'))
        ollama_bin = None
        model = cfg.get('ollamaModel', '')
        if agent == 'opencode' and cfg.get('launchVia') == 'ollama':
            if not model:
                raise launch.LaunchError('OpenCode is set to start through ollama, but no model is chosen '
                                         'in the Agent Sessions settings')
            ollama_bin = shutil.which('ollama', path=environ.get('PATH'))
            if not ollama_bin:
                raise launch.LaunchError('ollama was not found on PATH')
    except launch.LaunchError as e:
        raise Failure(str(e))

    daemon_id = str(uuid.uuid4())
    argv = launch.build_argv(agent, bin_path, daemon_id, name, rc, prompt, ollama_bin, model)
    env = launch.build_env(agent, environ, cfg.get('env', {}), bin_path, config.VAULT, shim_path())
    if agent == 'claude':
        _register_claude(daemon_id, cwd, warnings)

    since = time.time()
    resp = _daemon('start', id=daemon_id, agent=agent, cwd=cwd, argv=argv, env=env, cols=120, rows=40)
    if resp is None or not resp.get('ok'):
        raise Failure('cannot start the session: %s' % ((resp or {}).get('error') or 'no answer from the daemon'))

    result: Dict[str, Any] = {
        'agent': agent, 'id': daemon_id, 'daemon_id': daemon_id, 'cwd': cwd, 'name': name,
        'remote_control': None, 'confirmed': False, 'warnings': warnings,
        'attach': '"%s" attach %s' % (launcher_path(), daemon_id),
    }
    if agent == 'claude':
        _wait_claude(result, name, rc, ns.timeout)
    else:
        _wait_resolved(result, name, since, ns.timeout, warnings)
    result['exit'] = 0 if result['confirmed'] else 1
    return result


def _wait_claude(result: Dict[str, Any], name: Optional[str], rc: bool, timeout: float) -> None:
    sid = result['id']
    if not (name or rc):
        # Nothing to read back from the transcript (Claude Code writes it with the first message):
        # the session counts as started once it is still running after a moment.
        time.sleep(SETTLE_SECONDS)
        s = _daemon_session(sid)
        if s is None or s.get('exited') is not None:
            raise Failure('the session ended right after it started (see %s)'
                          % os.path.join(config.RUNTIME_DIR, 'daemon.log'))
        result['confirmed'] = True
        return
    deadline = time.monotonic() + timeout
    title = url = None
    while True:
        path = claude_agent.find_transcript(sid)
        if path:
            title, url = read_claude_progress(path)
        if (url or not rc) and (title or not name):
            break
        if time.monotonic() >= deadline:
            break
        time.sleep(POLL_SECONDS)
        s = _daemon_session(sid)
        if s is None or s.get('exited') is not None:
            raise Failure('the session ended right after it started (see %s)'
                          % os.path.join(config.RUNTIME_DIR, 'daemon.log'))
    result['name'] = title or name
    result['remote_control'] = url
    result['confirmed'] = (not rc or bool(url)) and (not name or title == name)


def _wait_resolved(result: Dict[str, Any], name: Optional[str], since: float, timeout: float,
                   warnings: List[str]) -> None:
    daemon_id, agent, cwd = result['daemon_id'], result['agent'], result['cwd']
    deadline = time.monotonic() + timeout
    while True:
        s = _daemon_session(daemon_id)
        if s is None or s.get('exited') is not None:
            raise Failure('the session ended right after it started (see %s)'
                          % os.path.join(config.RUNTIME_DIR, 'daemon.log'))
        pid = s.get('pid')
        if isinstance(pid, int):
            thread = json_output.resolve_output(agent, pid, since, cwd).get('thread')
            if thread:
                result['id'] = thread
                result['confirmed'] = _link(agent, thread, cwd, daemon_id, name, warnings)
                return
        if time.monotonic() >= deadline:
            break
        time.sleep(POLL_SECONDS)
    warnings.append('%s records its session once the first message is sent, so its id is not known yet '
                    '(start with --prompt to have it resolved)' % ('Codex' if agent == 'codex' else 'OpenCode'))


def render(result: Dict[str, Any]) -> str:
    lines = ['%s session %s' % (result['agent'], 'started' if result['confirmed'] else 'started (not confirmed yet)'),
             'ID: %s' % result['id']]
    if result['id'] != result['daemon_id']:
        lines.append('Daemon ID: %s' % result['daemon_id'])
    lines.append('Folder: %s' % result['cwd'])
    lines.append('Name: %s' % (result['name'] or '(none)'))
    if result['agent'] == 'claude':
        lines.append('Remote Control: %s' % (result['remote_control'] or 'not confirmed'))
    lines.append('Open: the Agent Sessions list in Obsidian, or %s' % result['attach'])
    for w in result['warnings']:
        lines.append('Note: %s' % w)
    return '\n'.join(lines) + '\n'


def main(args: List[str]) -> int:
    ns = parse_args(args)
    try:
        result = start(ns)
    except Failure as e:
        if ns.json:
            sys.stdout.write(json.dumps({'ok': False, 'exit': 2, 'error': str(e)}, ensure_ascii=False) + '\n')
        else:
            sys.stderr.write('[ERROR] %s\n' % e)
        return 2
    if ns.json:
        sys.stdout.write(json.dumps(dict(result, ok=True), ensure_ascii=False) + '\n')
    else:
        sys.stdout.write(render(result))
    return result['exit']

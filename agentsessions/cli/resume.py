"""`agent-sessions resume SESSION [--prompt TEXT] [--json]`.

Starts an ended session again (one with no agent process, `ended` in `sessions`) in the daemon, the way
the plugin resumes one: the same argv (`launch.build_resume_argv`, the counterpart of `buildAgentArgv`
with `fresh=false`) and env (`launch.build_env`) as `new`. It asks the running Obsidian plugin to open
a tab for the session; without a plugin the session still runs in the background, shows as running in
Obsidian's Agent Sessions list and is opened from there or with `agent-sessions attach <daemon id>`.

A Claude Code session runs under its own id in the daemon. A Codex or OpenCode session gets a new daemon
id, linked to its real id in `sessions.json` (`sessions[id].daemon`), as the plugin's tab does when it
resumes one (`startSession` in terminal.ts).

A session that is not ended (running, asking or idle) is refused, and so is the caller's own session.

Exit codes as `new`: 0 = started and confirmed, 1 = started but not confirmed (the session keeps
running; never retry, or there will be two), 2 = could not start.
"""
import argparse
import json
import os
import sys
import time
import uuid
from typing import Any, Dict, List, Optional

from .. import config
from ..agents import claude as claude_agent
from ..agents import launch
from ..sessions import store
from . import listing, new
from .new import Failure


def _read(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            return f.read()
    except OSError:
        return None


def _claude_settings_path() -> str:
    base = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
    return os.path.join(base, 'settings.json')


def remote_control_name(row: Dict[str, Any]) -> Optional[str]:
    """The name to resume a Claude Code session into Remote Control with, as `launchArgv` picks it: the
    session's name when resuming connects Remote Control, else None."""
    if row['agent'] != 'claude' or not row.get('named'):
        return None
    transcript = claude_agent.find_transcript(row['id'])
    if launch.resume_connects_remote_control(_read(_claude_settings_path()), _read(transcript)):
        return row['name']
    return None


def _forget_exited(daemon_id: Optional[str]) -> None:
    """Drops the daemon's record of an earlier, ended run under `daemon_id`, so it can be started
    again (the plugin does the same before a headless resume). Refuses one still running."""
    if not daemon_id:
        return
    s = new._daemon_session(daemon_id)
    if s is None:
        return
    if s.get('exited') is None:
        raise Failure('the session is already running in the daemon (%s)' % daemon_id)
    new._daemon('forget', id=daemon_id)


def _link(agent: str, sid: str, cwd: str, daemon_id: str, warnings: List[str]) -> None:
    """Points `sessions.json`'s `sessions[sid].daemon` at the new run, keeping what the entry already
    holds (an OpenCode name)."""
    if not config.STORE_PATH:
        warnings.append('the vault is not configured, so the session was not linked in sessions.json '
                        '(Obsidian may not show it as running)')
        return

    def apply(st: Any) -> None:
        entry = st.sessions.get(sid)
        entry = dict(entry) if isinstance(entry, dict) else {'agent': agent, 'cwd': cwd}
        entry['daemon'] = daemon_id
        st.sessions[sid] = entry
    try:
        store.update(apply, config.STORE_PATH)
    except Exception as e:  # noqa: BLE001 -- the session itself can still start
        warnings.append('could not link the session in sessions.json: %s' % e)


def _stored_daemon(sid: str) -> Optional[str]:
    if not config.STORE_PATH:
        return None
    try:
        entry = store.load(path=config.STORE_PATH).sessions.get(sid)
    except Exception:  # noqa: BLE001
        return None
    d = entry.get('daemon') if isinstance(entry, dict) else None
    return d if isinstance(d, str) and d else None


def start(query: str, prompt: Optional[str], environ: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Resumes the session `query` names and returns the result dict (`exit` is the exit code)."""
    environ = dict(os.environ if environ is None else environ)
    rows = listing.collect(environ, include_children=True, include_archived=True)
    try:
        row = listing.find(rows, query)
    except listing.NotFound:
        raise Failure('no session matches %r' % query)
    except listing.Ambiguous as e:
        raise Failure('%r matches %d sessions; give an id:\n%s' % (query, len(e.rows), '\n'.join(
            '  %s  %s  %s' % (r['id'], r['status'], r['name']) for r in e.rows)))
    if row['self']:
        raise Failure('this is the calling session itself')
    if row['status'] != listing.ENDED:
        raise Failure('the session is not ended (%s); only an ended session can be resumed' % row['status'])

    agent, sid = row['agent'], row['id']
    cwd = row['cwd'] if row['cwd'] and os.path.isdir(row['cwd']) else None
    if cwd is None:
        raise Failure('the session\'s folder no longer exists: %s' % (row['cwd'] or '(unknown)'))
    prompt = (prompt or '').strip() or None
    warnings: List[str] = []

    cfg, bin_path, ollama_bin, model = new.resolve_launch(agent, environ)
    new.ensure_daemon()
    if agent == 'claude':
        daemon_id = sid
        _forget_exited(daemon_id)
    else:
        _forget_exited(_stored_daemon(sid))
        daemon_id = str(uuid.uuid4())
    argv = launch.build_resume_argv(agent, bin_path, sid, remote_control_name(row), prompt, ollama_bin, model,
                                    codex_no_daemon=agent == 'codex' and launch.codex_no_daemon(bin_path))
    env = launch.build_env(agent, environ, cfg.get('env', {}), bin_path, config.VAULT, new.shim_path())
    if agent != 'claude':
        _link(agent, sid, cwd, daemon_id, warnings)

    resp = new._daemon('start', id=daemon_id, agent=agent, cwd=cwd, argv=argv, env=env, cols=120, rows=40)
    if resp is None or not resp.get('ok'):
        raise Failure('cannot start the session: %s' % ((resp or {}).get('error') or 'no answer from the daemon'))

    result: Dict[str, Any] = {
        'agent': agent, 'id': sid, 'daemon_id': daemon_id, 'cwd': cwd, 'name': row['name'],
        'prompt_sent': bool(prompt), 'confirmed': False, 'opened': False, 'warnings': warnings,
        'attach': '"%s" attach %s' % (new.launcher_path(), daemon_id),
    }
    time.sleep(new.SETTLE_SECONDS)
    s = new._daemon_session(daemon_id)
    if s is not None and s.get('exited') is not None:
        raise Failure('the session ended right after it started (see %s)'
                      % os.path.join(config.RUNTIME_DIR, 'daemon.log'))
    result['confirmed'] = s is not None
    new.open_tab(result, None)  # the session already has its name; none is parked for the tab
    result['exit'] = 0 if result['confirmed'] else 1
    return result


def render(result: Dict[str, Any]) -> str:
    lines = ['%s session %s' % (result['agent'], 'resumed' if result['confirmed'] else 'resumed (not confirmed yet)'),
             'ID: %s' % result['id']]
    if result['id'] != result['daemon_id']:
        lines.append('Daemon ID: %s' % result['daemon_id'])
    lines.append('Folder: %s' % result['cwd'])
    lines.append('Name: %s' % (result['name'] or '(none)'))
    if result['prompt_sent']:
        lines.append('Sent the message given with --prompt')
    lines.append('Tab: %s' % ('opened in Obsidian' if result['opened'] else 'not opened'))
    lines.append('Open: the Agent Sessions list in Obsidian, or %s' % result['attach'])
    for w in result['warnings']:
        lines.append('Note: %s' % w)
    return '\n'.join(lines) + '\n'


def main(args: List[str]) -> int:
    p = argparse.ArgumentParser(prog='agent-sessions resume', description='Resume an ended session in the daemon')
    p.add_argument('session', help='id, id prefix or name')
    p.add_argument('--prompt', default=None, help='a message to send to the session as it resumes')
    p.add_argument('--json', action='store_true', help='machine-readable output')
    ns = p.parse_args(args)
    try:
        result = start(ns.session, ns.prompt)
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

"""Builds the output for `json scan`, `json live`, `json detail`, `json usage`, and
`json stats`.

Every entry point loops over `agentsessions.agents.enabled_agents()` and merges
each agent adapter's results (`agentsessions.agents.claude`,
`agentsessions.agents.codex`) -- this module, not `sessions/scan.py` itself, is
the "registered adapters, looped over and merged" dispatch point, since it's the
layer that already owned cross-cutting concerns like the shared scan-cache and
the daemon check.
"""

import os
import socket
import time
from typing import Dict, List, Optional

from .. import agents, config, i18n
from ..agents import claude as claude_agent
from ..agents import codex as codex_agent
from ..daemon import protocol
from ..sessions import cache, store
from ..sessions.live import STATUS_LABEL_KEY
from ..sessions.model import Session, folder_of, split_name
from ..tui.items import OTHER_LABEL_LEN
from ..usage import stats

DAEMON_TIMEOUT = 1.0

_ADAPTERS = {'claude': claude_agent, 'codex': codex_agent}


def _adapter(name: str):
    return _ADAPTERS[name]


def _agent_roots() -> Dict[str, str]:
    """Each agent's own transcript root, used only to decide which cache entries
    are safe to prune (see `scan_output`) -- an entry under a *disabled* agent's
    root is left alone, so toggling an agent off and back on doesn't lose its
    cache."""
    return {
        'claude': config.PROJECTS_DIR,
        'codex': os.path.join(codex_agent.rollout.codex_home(), 'sessions'),
    }


def _session_dict(s: Session) -> dict:
    if s.name:
        group, label = split_name(s.name)
    else:
        group = None
        label = s.first_prompt[:OTHER_LABEL_LEN] or s.id[:8]
    return {
        'id': s.id,
        'agent': s.agent,
        'name': s.name,
        'group': group,
        'label': label,
        'cwd': s.cwd,
        'folder': folder_of(s.cwd),
        'last_activity': s.mtime,
        'child': s.child,
        'transcript': s.path,
    }


def _store_dict() -> dict:
    # Read `config.STORE_PATH` here, at call time — `store.load`'s default argument is
    # bound at import time, so it wouldn't pick up a path swapped in later (e.g. in tests).
    st = store.load(path=config.STORE_PATH)
    return {
        'folded': st.folded,
        'archived': st.archived,
        'pendingRenames': st.pendingRenames,
        'sessions': st.sessions,
    }


def scan_output(only: Optional[List[str]] = None) -> dict:
    # Same reason as `_store_dict`: pass `config.CACHE_PATH` at call time.
    cache_path = config.CACHE_PATH
    c = cache.load(path=cache_path)
    enabled = agents.enabled_agents()
    roots = _agent_roots()
    sessions: List[dict] = []
    all_current_paths = set()

    for name in enabled:
        adapter = _adapter(name)
        if only:
            paths = [p for p in (adapter.find_transcript(sid) for sid in only) if p]
            for p in paths:
                c.pop(p, None)   # `--only` exists to force a re-read, so ignore any cache hit
        else:
            paths = adapter.list_transcripts()
        scanned = adapter.scan(paths, cache=c)
        all_current_paths.update(paths)
        wanted = None if not only else set(only)
        sessions.extend(_session_dict(s) for s in scanned.values()
                         if wanted is None or s.id in wanted)

    if not only:
        # Drop cache entries for transcripts that no longer show up in the scan --
        # but only within an *enabled* agent's own root, so a disabled agent's
        # entries (which this call never re-listed) survive being toggled off.
        for p in list(c):
            for name in enabled:
                if p.startswith(roots[name]) and p not in all_current_paths:
                    del c[p]
                    break
    cache.save(c, path=cache_path)
    return {'sessions': sessions, 'store': _store_dict()}


def _recv_json(sock: socket.socket, decoder: protocol.Decoder, deadline: float) -> dict:
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('daemon did not respond in time')
        sock.settimeout(remaining)
        chunk = sock.recv(65536)
        if not chunk:
            raise ConnectionError('daemon closed the connection')
        for kind, payload in decoder.feed(chunk):
            if kind == protocol.FRAME_J:
                return protocol.decode_json(payload)


def daemon_sock_path() -> str:
    return os.environ.get('AGENT_SESSIONS_SOCK') or config.SOCK_PATH


def send_daemon_op(op: str, client: str = 'json', sock_path: Optional[str] = None,
                    **kw) -> Optional[dict]:
    """Sends `hello` then `op` to the daemon and returns the response, or `None` if it
    can't connect (this never starts the daemon). Used both for `json live`'s `daemon`
    check and for one-off requests to the daemon (e.g. `tui.py`'s `forget`)."""
    if sock_path is None:
        sock_path = daemon_sock_path()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(DAEMON_TIMEOUT)
        sock.connect(sock_path)
        decoder = protocol.Decoder()
        deadline = time.monotonic() + DAEMON_TIMEOUT

        sock.sendall(protocol.encode_json({'op': 'hello', 'client': client, 'seq': 1}))
        hello = _recv_json(sock, decoder, deadline)
        if not hello.get('ok'):
            return None

        req = {'op': op, 'seq': 2}
        req.update(kw)
        sock.sendall(protocol.encode_json(req))
        return _recv_json(sock, decoder, deadline)
    except (OSError, TimeoutError, ConnectionError, ValueError):
        return None
    finally:
        try:
            sock.close()
        except OSError:
            pass


def _codex_daemon_links() -> Dict[str, str]:
    """`{daemon_uuid: thread_id}` for every Codex session sessions.json links
    (`sessions[<thread_id>] = {"agent": "codex", "daemon": "<daemon_uuid>"}`,
    written by the plugin once `json resolve codex` finds the real thread id --
    see design.md §3.3). A link whose `daemon_uuid` no longer names a running
    daemon session (the daemon restarted, or the plugin already re-resumed under
    a new uuid) is simply never looked up by `_daemon_list`'s relabeling below,
    so a stale entry here is inert, not a bug to guard against."""
    st = store.load(path=config.STORE_PATH)
    out: Dict[str, str] = {}
    for thread_id, entry in st.sessions.items():
        if isinstance(entry, dict) and entry.get('agent') == 'codex':
            daemon_id = entry.get('daemon')
            if isinstance(daemon_id, str) and daemon_id:
                out[daemon_id] = thread_id
    return out


def _daemon_list() -> dict:
    """Fetches the daemon's `list`. `running: false` if it isn't up (this never
    starts it). Codex sessions are relabeled from the daemon-assigned uuid
    `start` was called with to the resolved thread id (Claude Code sessions are
    unaffected -- there, the daemon uuid already *is* the transcript id), so a
    consumer only ever sees thread ids for Codex, matching `json scan`'s rows."""
    resp = send_daemon_op('list')
    if resp is None or not resp.get('ok'):
        return {'running': False, 'sessions': []}
    sessions = resp.get('sessions', [])
    if any(isinstance(s, dict) and s.get('agent') == 'codex' for s in sessions):
        links = _codex_daemon_links()
        sessions = [dict(s, id=links[s['id']]) if isinstance(s, dict) and s.get('agent') == 'codex'
                    and s.get('id') in links else s
                    for s in sessions]
    return {'running': True, 'sessions': sessions}


def _live_dict(sid: str, agent: str, l) -> dict:
    d = {
        'agent': agent,
        # The raw value the agent itself reports ('busy' | 'shell' | 'idle' | 'waiting' | '').
        'status': l.status,
        # The display label for `status`, in the current UI language (see `i18n.py`).
        'status_label': i18n.t(STATUS_LABEL_KEY.get(l.status, 'status.unknown')),
        'pid': l.pid,
        'updated_at': l.updated_at,
    }
    if getattr(l, 'rc', False):
        d['rc'] = True
    waiting_for = getattr(l, 'waiting_for', '')
    if waiting_for:
        d['waiting_for'] = waiting_for
    return d


def live_output() -> dict:
    live: dict = {}
    cache_path = config.CACHE_PATH
    for name in agents.enabled_agents():
        adapter = _adapter(name)
        if name == 'claude':
            live_map = adapter.live_sessions()
        else:
            # Codex has no ledger of its own -- it needs a scan (path/cwd per id)
            # to know what to check. Reuses the shared, persistent scan-cache, so
            # this doesn't cost more than `json scan` already would.
            c = cache.load(path=cache_path)
            scanned = adapter.scan(adapter.list_transcripts(), cache=c)
            cache.save(c, path=cache_path)
            live_map = adapter.live_sessions(scanned)
        for sid, l in live_map.items():
            live[sid] = _live_dict(sid, name, l)
    return {'live': live, 'daemon': _daemon_list()}


def _detail_dict(d) -> dict:
    out = {'last_user': d.last_user, 'last_assistant': d.last_assistant,
           'tools': d.tools, 'last_command': d.last_command}
    # additive: only present when the agent adapter actually populates them (today,
    # only agents.codex -- Claude Code carries model/effort via statusLine instead,
    # see design.md §14), so an existing consumer reading just the four keys above
    # sees no difference.
    if d.model is not None:
        out['model'] = d.model
    if d.effort is not None:
        out['effort'] = d.effort
    return out


def detail_output(session_id: str) -> dict:
    for name in agents.enabled_agents():
        adapter = _adapter(name)
        p = adapter.find_transcript(session_id)
        if p:
            return _detail_dict(adapter.read_detail_for(p))
    return _detail_dict(claude_agent.read_detail_for(None))


def usage_output(session_id: str, from_ts: Optional[float] = None,
                  to_ts: Optional[float] = None) -> dict:
    for name in agents.enabled_agents():
        adapter = _adapter(name)
        path = adapter.find_transcript(session_id)
        if path:
            turns = adapter.collect_usage(path)
            return adapter.summarize_usage(turns, from_ts=from_ts, to_ts=to_ts)
    return claude_agent.summarize_usage([], from_ts=from_ts, to_ts=to_ts)


def resolve_output(agent: str, pid: int, since: float, cwd: str) -> dict:
    """Backs `json resolve <agent> --pid --since --cwd` -- see
    `agentsessions.agents.codex.resolve`'s docstring for the contract (a
    freshly-started daemon session's real id, for an agent like Codex that
    can't be told what id to use up front). `{"thread": null, "transcript": null}`
    for any agent that doesn't need this (i.e. every agent but Codex, which picks
    its own id via `--session-id` at launch, per T-96)."""
    if agent != 'codex':
        return {'thread': None, 'transcript': None}
    st = store.load(path=config.STORE_PATH)
    already_linked = {v.get('thread') for v in st.sessions.values()
                       if isinstance(v, dict) and isinstance(v.get('thread'), str)}
    thread, transcript = codex_agent.resolve.resolve(pid, since, cwd, already_linked=already_linked)
    return {'thread': thread, 'transcript': transcript}


def stats_output() -> dict:
    # Same reason as `_store_dict`: pass the config paths at call time.
    result = stats.compute(now=time.time(), projects_dir=config.PROJECTS_DIR,
                            status_dir=config.STATUS_DIR, cache_path=config.STATS_CACHE_PATH)
    if 'codex' in agents.enabled_agents():
        # Additive: a Claude-only deployment (or a plugin build that predates this
        # key) never sees `agents` at all, so this can't regress anything reading
        # the existing `windows` key.
        result['agents'] = {'codex': {'windows': codex_agent.stats.windows()}}
    return result

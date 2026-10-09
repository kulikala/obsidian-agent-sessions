"""Builds the output for `json scan`, `json live`, `json detail`, `json usage`,
`json stats`, and `json efficiency`.

Every entry point loops over `agentsessions.agents.enabled_agents()` and merges
each agent adapter's results (`agentsessions.agents.claude`, `.codex`,
`.opencode`) -- this module, not `sessions/scan.py` itself, is
the "registered adapters, looped over and merged" dispatch point, since it's the
layer that already owned cross-cutting concerns like the shared scan-cache and
the daemon check.
"""

import os
import socket
import time
from typing import Dict, List, Optional

from .. import agents, config, i18n, procs, transport
from ..agents import claude as claude_agent
from ..agents import codex as codex_agent
from ..agents import opencode as opencode_agent
from ..daemon import protocol
from ..sessions import activity, cache, store
from ..sessions import scan as scan_mod
from ..sessions.live import STATUS_LABEL_KEY
from ..sessions.model import Session, folder_of, split_name
from ..tui.items import OTHER_LABEL_LEN
from ..usage import stats

DAEMON_TIMEOUT = 1.0

_ADAPTERS = {'claude': claude_agent, 'codex': codex_agent, 'opencode': opencode_agent}


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
        # OpenCode has no transcript files; its pseudo paths all start with this.
        'opencode': opencode_agent.PSEUDO_ROOT,
    }


def _session_dict(s: Session) -> dict:
    if s.name:
        group, label = split_name(s.name)
    else:
        group = None
        label = s.first_prompt[:OTHER_LABEL_LEN] or s.id[:8]
    out = {
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
        # The `/goal` -- `{condition, met, reason, since, updated}` (+ `failed`; Codex adds its own
        # `status`), or null (none, cleared, or an agent without goals).
        'goal': s.goal,
    }
    # additive, Codex and OpenCode only for now -- Claude Code's model/effort come from
    # statusLine (real-time, already surfaced separately), not scan; adding a
    # transcript-derived copy here would risk showing something stale or
    # inconsistent with what statusLine already reports for the same session.
    if s.model is not None:
        out['model'] = s.model
    if s.effort is not None:
        out['effort'] = s.effort
    # additive, only while the last compaction hasn't been answered by the model yet
    # (`sessions.scan.read_after_compact`) -- the plugin's `compacted` state reads it.
    if s.after_compact is not None:
        out['after_compact'] = s.after_compact
    # additive, only while something is scheduled (`sessions.schedule.summarize`) / the latest turn
    # was started by a schedule -- the plugin's schedule badge and `looped` state read them.
    if s.schedule is not None:
        out['schedule'] = s.schedule
    if s.scheduled_turn:
        out['scheduled_turn'] = True
    return out


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


def activity_output(from_ts: float, to_ts: float, gap: float = activity.DEFAULT_GAP_SECONDS,
                    now: Optional[float] = None, raw: bool = False) -> dict:
    """`{"sessions": [{id, agent, name, label, category, child, first, spans}]}` for the sessions
    that were active inside `[from_ts, to_ts)`. `spans` are blocks `{start, end, final, turns}`
    (epoch seconds): each turn (from a prompt to the agent's last record before the next one) and,
    for Claude Code, each run of the session's sub-agents, with those less than `gap` apart
    joined, clipped to the range (see `sessions/activity.py`); `first` is the session's earliest
    activity, in range or not. Names come
    from the shared scan cache and each transcript's turns from `activity-cache.json`, keyed by
    path, size, mtime and algorithm version, so only changed transcripts are parsed again; a
    transcript last written before `from_ts` can't hold activity in range and is never opened.

    `raw=True` returns the unjoined building blocks instead of `spans`: per session `turns` and
    `runs` (see `activity.raw_runs`; no gap joining, no one-minute stretching), so a reader can
    join with any gap itself."""
    now = time.time() if now is None else now
    c = cache.load(path=config.CACHE_PATH)
    ac = activity.load_cache(config.ACTIVITY_CACHE_PATH)
    enabled = agents.enabled_agents()
    roots = _agent_roots()
    all_paths = set()
    out: List[dict] = []
    for name in enabled:
        adapter = _adapter(name)
        all_listed = adapter.list_transcripts()
        all_paths.update(all_listed)
        paths = all_listed
        if name != 'opencode':   # OpenCode's pseudo paths name no file
            paths = [p for p in paths if _mtime(p) >= from_ts]
        for s in adapter.scan(paths, cache=c).values():
            if s.mtime < from_ts:
                continue
            if name == 'opencode':
                turns = activity.cached_turns(ac, s.path, 0, s.mtime, lambda a=adapter, p=s.path: a.activity_turns(p))
            else:
                turns = _cached_file_turns(ac, s.path, now, lambda a=adapter, p=s.path: a.activity_turns(p))
                # Sub-agent work (their own transcripts) is part of the session's activity.
                extra = getattr(adapter, 'activity_extra_files', None)
                for sub in (extra(s.path) if extra else []):
                    turns = turns + _cached_file_turns(ac, sub, now, lambda a=adapter, p=sub: a.activity_extra_turns(p))
            turns = activity.extend_if_live(turns, now)
            d = _session_dict(s)
            # `first`: the session's earliest activity anywhere, not just in range, so a reader
            # can order sessions the same way in every period.
            meta = {'id': d['id'], 'agent': d['agent'], 'name': d['name'], 'label': d['label'],
                    'category': d['group'], 'child': d['child'],
                    'first': min((t[0] for t in turns), default=None)}
            if raw:
                turn_list, runs = activity.raw_runs(turns, from_ts, to_ts)
                if runs:
                    out.append(dict(meta, turns=turn_list, runs=runs))
                continue
            spans = activity.clip_spans(activity.join_turns(turns, gap), from_ts, to_ts)
            if spans:
                out.append(dict(meta, spans=spans))
    for p in list(ac):
        if any(p.startswith(roots[n]) for n in enabled) and not _has_owner(p, all_paths):
            del ac[p]
    cache.save(c, path=config.CACHE_PATH)
    activity.save_cache(ac, config.ACTIVITY_CACHE_PATH)
    return {'sessions': out}


def _has_owner(path: str, listed: set) -> bool:
    """Whether `path` is a listed transcript, or a sub-agent transcript under a listed
    session's folder (`<id>/…/x.jsonl` next to `<id>.jsonl`)."""
    if path in listed:
        return True
    parent = os.path.dirname(path)
    while parent and parent != os.path.dirname(parent):
        if parent + '.jsonl' in listed:
            return True
        parent = os.path.dirname(parent)
    return False


def _cached_file_turns(ac: dict, path: str, now: float, compute) -> List[list]:
    """`path`'s turns from the activity cache (keyed by path, size, mtime, algorithm version),
    or `compute()`d; a file written within the racy window is never trusted from the cache."""
    try:
        st = os.stat(path)
    except OSError:
        return []
    trust = now - st.st_mtime >= scan_mod.RACY_WINDOW
    return activity.cached_turns(ac, path, st.st_size, st.st_mtime, compute, trust)


def _mtime(path: str) -> float:
    try:
        return os.stat(path).st_mtime
    except OSError:
        return 0.0


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
    try:
        sock = transport.connect(sock_path, DAEMON_TIMEOUT)
    except OSError:
        return None
    try:
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


def _daemon_links() -> Dict[str, str]:
    """`{daemon_uuid: session_id}` for every session sessions.json links
    (`sessions[<session_id>] = {"agent": ..., "daemon": "<daemon_uuid>"}`, written
    by the plugin once `json resolve <agent>` finds a Codex or OpenCode session's
    real id -- see design.md §3.3 -- or once it sees a Claude Code session that
    restarted itself continue under an id other than the one the daemon started it
    with). A link whose `daemon_uuid` no
    longer names a running daemon session (the daemon restarted, or the plugin
    already re-resumed under a new uuid) is simply never looked up by
    `_daemon_list`'s relabeling below, so a stale entry here is inert, not a
    bug to guard against."""
    st = store.load(path=config.STORE_PATH)
    out: Dict[str, str] = {}
    for session_id, entry in st.sessions.items():
        if isinstance(entry, dict) and entry.get('agent') is not None:
            daemon_id = entry.get('daemon')
            if isinstance(daemon_id, str) and daemon_id and daemon_id != session_id:
                out[daemon_id] = session_id
    return out


def _daemon_list() -> dict:
    """Fetches the daemon's `list`. `running: false` if it isn't up (this never
    starts it). Codex and OpenCode sessions are relabeled from the daemon-assigned
    uuid `start` was called with to the resolved session id (a Claude Code session
    keeps its daemon uuid, which already *is* the transcript id, unless the store
    links it to the id it restarted under), so a consumer only ever sees real
    session ids for them, matching `json scan`'s rows."""
    resp = send_daemon_op('list')
    if resp is None or not resp.get('ok'):
        return {'running': False, 'sessions': []}
    sessions = resp.get('sessions', [])
    if any(isinstance(s, dict) for s in sessions):
        links = _daemon_links()
        sessions = [dict(s, id=links[s['id']]) if isinstance(s, dict) and s.get('id') in links else s
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
        elif name == 'opencode':
            # Status files first; the database fallback needs only ids and update
            # times, which a single query gives -- no scan of every session.
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
    # only agents.codex/agents.opencode -- Claude Code carries model/effort via statusLine instead,
    # see design.md §14), so an existing consumer reading just the four keys above
    # sees no difference.
    recent = getattr(d, 'recent_user', None)
    if recent:
        out['recent_user'] = recent
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
    `agentsessions.agents.codex.resolve`'s and `.opencode.resolve`'s docstrings
    for the contract (a freshly-started daemon session's real id, for an agent
    like Codex or OpenCode that can't be told what id to use up front).
    `{"thread": null, "transcript": null}` for any agent that doesn't need this
    (Claude Code picks its own id via `--session-id` at launch)."""
    if agent not in ('codex', 'opencode'):
        return {'thread': None, 'transcript': None}
    st = store.load(path=config.STORE_PATH)
    # A link is keyed BY the real session id (`sessions[<session_id>] =
    # {"agent": "<agent>", "daemon": "<uuid>", ...}` -- see §3/§3.3 of
    # design.md and `_daemon_links`, above) -- so an already-linked id is the
    # dict key itself, not a value field.
    already_linked = {sid for sid, v in st.sessions.items()
                       if isinstance(v, dict) and v.get('agent') == agent}
    resolver = codex_agent.resolve if agent == 'codex' else opencode_agent.resolve
    thread, transcript = resolver.resolve(pid, since, cwd, already_linked=already_linked)
    return {'thread': thread, 'transcript': transcript}


def moved_output(agent: str, pid: int, since: float) -> dict:
    """Backs `json moved <agent> --pid --since`: `{"thread": <id>|null, "transcript": <path>|null}`,
    the session a linked Codex or OpenCode tab's process (`pid`) started at or after `since` with
    `/new` (Codex also `/clear`) and that nothing is linked to yet -- see
    `agents.codex.resolve.new_thread` and `agents.opencode.resolve.new_session`. `null`/`null` for
    any other agent, and while there is none."""
    if agent not in ('codex', 'opencode'):
        return {'thread': None, 'transcript': None}
    st = store.load(path=config.STORE_PATH)
    already_linked = {sid for sid, v in st.sessions.items()
                      if isinstance(v, dict) and v.get('agent') == agent}
    if agent == 'codex':
        thread, transcript = codex_agent.resolve.new_thread(pid, since, already_linked=already_linked)
    else:
        thread, transcript = opencode_agent.resolve.new_session(pid, since, already_linked=already_linked)
    return {'thread': thread, 'transcript': transcript}


def ppid_output(pids: List[int]) -> dict:
    """Backs `json ppid <pid>...`: `{"parents": {"<pid>": <ppid>}}` for every pid in the process table
    (a pid that isn't running is left out). `{"parents": null}` when the table can't be read -- the
    caller then falls back on whatever it knew without the parent (see the plugin's
    `sessions/successor.ts`)."""
    table = procs.parent_table()
    if table is None:
        return {'parents': None}
    return {'parents': {str(p): table[p] for p in pids if p in table}}


def stats_output() -> dict:
    """`{"windows": W2, "agents": {"claude": {"windows": W2}, "codex": {"windows": W2}}}`
    -- `W2 = {"five_hour": W, "seven_day": W}`, `W = {start, end,
    used_percentage, total, sessions}`, the same shape for both agents so the
    plugin's analysis views can render either through the same code. Only an
    enabled agent gets an `agents.<name>` entry. The top-level `windows` key
    (always Claude's, unconditionally -- pre-dating `agents` entirely) is kept
    exactly as before for backward compatibility with a plugin build that reads
    only that key; once the plugin reads `agents.claude.windows` instead, this
    top-level key can be dropped."""
    # Same reason as `_store_dict`: pass the config paths at call time.
    claude_windows = stats.compute(now=time.time(), projects_dir=config.PROJECTS_DIR,
                                    status_dir=config.STATUS_DIR, cache_path=config.STATS_CACHE_PATH)
    result = dict(claude_windows)
    enabled = agents.enabled_agents()
    agents_out = {}
    if 'claude' in enabled:
        agents_out['claude'] = claude_windows
    if 'codex' in enabled:
        agents_out['codex'] = codex_agent.stats.compute(now=time.time())
    if agents_out:
        result['agents'] = agents_out
    return result


def efficiency_output(agent_names: Optional[List[str]] = None, threshold: float = 80.0,
                      budget: float = 10_000_000, explicit=None, max_sessions: int = 200,
                      digest: bool = True, now: Optional[float] = None) -> dict:
    """`{"version": 1, "agents": {"claude": {...}, "codex": {...}, "opencode": {...}}}` -- the
    token efficiency statistics, hits and the masked digest of each requested (and enabled) agent;
    see `agentsessions/efficiency/report.py`."""
    from ..efficiency import report, sources
    now = time.time() if now is None else now
    enabled = agents.enabled_agents()
    wanted = [a for a in (agent_names or enabled) if a in enabled]
    kw = dict(vault=config.VAULT, threshold=threshold, budget=budget, explicit=explicit,
              max_sessions=max_sessions, with_digest=digest)
    out: Dict[str, dict] = {}
    if 'claude' in wanted:
        c = cache.load(path=config.CACHE_PATH)
        paths = claude_agent.list_transcripts()
        names = {s.id: s.name for s in claude_agent.scan(paths, cache=c).values() if s.name}
        cache.save(c, path=config.CACHE_PATH)
        out['claude'] = report.build(
            now, config.PROJECTS_DIR, config.STATUS_DIR, config.STATS_CACHE_PATH, names=names, **kw)
    if 'codex' in wanted:
        out['codex'] = report.build_for(now, sources.CodexSource(), names=_agent_names(codex_agent), **kw)
    if 'opencode' in wanted:
        out['opencode'] = report.build_for(now, sources.OpencodeSource(), names=_agent_names(opencode_agent), **kw)
    return {'version': 1, 'agents': out}


def _agent_names(module) -> Dict[str, str]:
    """Session names of Codex or OpenCode (best effort: none when the scan fails)."""
    try:
        return {s.id: s.name for s in module.scan(module.list_transcripts()).values() if s.name}
    except Exception:
        return {}

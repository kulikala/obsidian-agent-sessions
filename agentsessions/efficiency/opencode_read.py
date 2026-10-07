"""OpenCode session (rows of `opencode.db`) -> the same file record `normalize.read_file` makes of
a Claude Code transcript.

A call is a `step-finish` part (one model request): its `tokens` (`input` uncached, `cache.read`,
`cache.write`, `output`, and `reasoning`, which OpenCode counts apart from the output: `total`
adds it) and `cost`. The model, provider and agent are its message's (`providerID`, `modelID`,
`agent`); its time is the part's `time_created`. Tool parts (`type = tool`) of the same message
before the step's end belong to the call; their results are sized from `state.output`, an
`error` status is an error. Prompts are the text parts of user messages (synthetic and ignored
ones left out). A `compaction` part is a compaction; an assistant message that ended with
`MessageAbortedError` is an interruption. A session with a `parent_id` is a sub-agent chain of
its parent.

Offsets point at rows instead of bytes: a prompt's `off` is its message id, a reply's `text_off`
and a tool's `off` the part id, which `prompt_text` / `reply_text` / `command_text` read back.
"""

import os
from typing import Dict, List, Optional

from ..agents.opencode import db as _db
from . import normalize

READ_TOOLS = ('read',)
SEARCH_TOOLS = ('grep', 'glob', 'list', 'ls', 'codesearch')
EDIT_TOOLS = ('edit', 'write', 'patch', 'multiedit', 'apply_patch')
EXEC_TOOLS = ('bash', 'shell')
AGENT_TOOLS = ('task',)
WEB_TOOLS = ('webfetch', 'websearch')
OTHER_TOOLS = ('todowrite', 'todoread', 'skill', 'invalid', 'question', 'batch', 'lsp')
ABORTED = 'MessageAbortedError'
LOCAL_PROVIDERS = ('ollama', 'lmstudio', 'llama.cpp', 'llamacpp')


def tool_kind(name: str) -> str:
    if name in READ_TOOLS:
        return 'read'
    if name in SEARCH_TOOLS:
        return 'search'
    if name in EDIT_TOOLS:
        return 'edit'
    if name in EXEC_TOOLS:
        return 'exec'
    if name in AGENT_TOOLS:
        return 'agent'
    if name in WEB_TOOLS:
        return 'web'
    if name in OTHER_TOOLS:
        return 'other'
    return 'mcp' if '_' in name else 'other'


def _int(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _secs(ms) -> Optional[float]:
    return ms / 1000.0 if isinstance(ms, (int, float)) and not isinstance(ms, bool) else None


def list_sessions(d: '_db.Db', min_updated: float) -> List[dict]:
    """`{id, parent, directory, version, updated}` of every session updated at or after
    `min_updated` (epoch seconds), newest first."""
    cols = d.select_columns('session', ['id', 'parent_id', 'directory', 'version', 'time_updated', 'title'])
    rows = d.query('SELECT %s FROM session WHERE time_updated >= ? ORDER BY time_updated DESC' % cols,
                   (int(min_updated * 1000),))
    return [{'id': r['id'], 'parent': r['parent_id'], 'directory': r['directory'], 'version': r['version'],
             'updated': (r['time_updated'] or 0) / 1000.0, 'title': r['title']} for r in rows]


def read_session(d: '_db.Db', session: dict, home: Optional[str] = None) -> dict:
    """The file record of one session (see the module docstring)."""
    sid = session['id']
    cwd = session.get('directory')
    sub = bool(session.get('parent'))
    rec_out = {
        'path': _db.pseudo_path(sid), 'session': session.get('parent') if sub else sid,
        'chain': sid if sub else 'main', 'kind': 'subagent' if sub else 'main',
        'agent': 'opencode', 'provider': None, 'cwd': cwd, 'version': session.get('version'),
        'calls': [], 'results': [], 'prompts': [], 'events': [], 'links': [],
        'preamble': {'skills': None, 'instr': instruction_files(cwd, home), 'tool_search_absent': False},
        'first_user_off': None,
    }
    messages = d.query('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id', (sid,))
    parts = d.query('SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY id', (sid,))
    by_message: Dict[str, List] = {}
    for p in parts:
        by_message.setdefault(p['message_id'], []).append(p)
    prompt_texts: List[str] = []
    last_ts: Optional[float] = None
    for m in messages:
        data = _db.loads(m['data'])
        role = data.get('role')
        created = _secs((data.get('time') or {}).get('created'))
        mparts = by_message.get(m['id'], [])
        if role == 'user':
            # `/compact` (or an automatic compaction) is a user message holding a compaction part.
            for p in mparts:
                pd = _db.loads(p['data'])
                if pd.get('type') == 'compaction':
                    rec_out['events'].append({'k': 'compaction', 'ts': _secs(p['time_created']) or created,
                                              'trigger': 'auto' if pd.get('auto') else 'manual', 'pre': 0})
            text = _db.text_of_parts([p for p in mparts])
            if not text.strip():
                continue
            if not sub:
                body = text.strip()
                prompt_texts.append(body)
                if rec_out['first_user_off'] is None:
                    rec_out['first_user_off'] = m['id']
                rec_out['prompts'].append({
                    'uuid': m['id'], 'ts': created, 'off': m['id'],
                    'gap': (created - last_ts) if created is not None and last_ts is not None else None,
                    'est': round(normalize.est_tokens(body), 1), 'chars': len(body),
                    'cmd': False, 'mf': False,
                })
            continue
        if role != 'assistant':
            continue
        err = data.get('error') if isinstance(data.get('error'), dict) else {}
        if err.get('name') == ABORTED:
            rec_out['events'].append({'k': 'interrupt', 'ts': _secs((data.get('time') or {}).get('completed')) or created,
                                      'tool': False})
        model = data.get('modelID') if isinstance(data.get('modelID'), str) else None
        provider = data.get('providerID') if isinstance(data.get('providerID'), str) else None
        mode = data.get('agent') if isinstance(data.get('agent'), str) else data.get('mode')
        tools: List[dict] = []
        edits: List[dict] = []
        text_off = None
        visible = 0.0
        for p in mparts:
            pd = _db.loads(p['data'])
            ptype = pd.get('type')
            pts = _secs(p['time_created']) or created
            if ptype == 'text' and isinstance(pd.get('text'), str) and pd['text'].strip() and not pd.get('synthetic'):
                text_off = p['id']
                visible += normalize.est_tokens(pd['text'])
            elif ptype == 'reasoning' and isinstance(pd.get('text'), str):
                visible += normalize.est_tokens(pd['text'])
            elif ptype == 'compaction':
                rec_out['events'].append({'k': 'compaction', 'ts': pts,
                                          'trigger': 'auto' if pd.get('auto') else 'manual', 'pre': 0})
            elif ptype == 'tool':
                _add_tool(pd, p['id'], tools, edits, rec_out)
            elif ptype == 'step-finish':
                tokens = pd.get('tokens') if isinstance(pd.get('tokens'), dict) else {}
                cache = tokens.get('cache') if isinstance(tokens.get('cache'), dict) else {}
                unc, cr, cw = _int(tokens.get('input')), _int(cache.get('read')), _int(cache.get('write'))
                cost = pd.get('cost')
                rec_out['calls'].append({
                    'id': p['id'], 'ts': pts, 'model': model, 'effort': None, 'mode': mode,
                    'provider': provider, 'in': unc, 'cr': cr, 'cw': cw, 'cw1h': 0,
                    'out': _int(tokens.get('output')), 'rs': _int(tokens.get('reasoning')),
                    'th': _int(tokens.get('reasoning')), 'ctx': unc + cr + cw, 'vis': round(visible),
                    'usd': float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None,
                    'tools': tools, 'edits': edits, 'text_off': text_off, 'off': p['id'],
                })
                if pts is not None:
                    last_ts = pts if last_ts is None else max(last_ts, pts)
                tools, edits, text_off, visible = [], [], None, 0.0
        if tools and rec_out['calls']:
            # Tool parts after the last step's end (a step cut short): give them to that step.
            rec_out['calls'][-1]['tools'] = rec_out['calls'][-1]['tools'] + tools
            rec_out['calls'][-1]['edits'] = rec_out['calls'][-1]['edits'] + edits
    if rec_out['calls']:
        spent: Dict[str, float] = {}
        for c in rec_out['calls']:
            if c['provider']:
                spent[c['provider']] = spent.get(c['provider'], 0.0) + normalize.w_of(c)
        rec_out['provider'] = max(sorted(spent), key=lambda k: spent[k]) if spent else None
    normalize._mark_file_mentions(rec_out, prompt_texts)
    return rec_out


def _add_tool(pd: dict, part_id: str, tools: List[dict], edits: List[dict], rec_out: dict) -> None:
    name = pd.get('tool') if isinstance(pd.get('tool'), str) else ''
    state = pd.get('state') if isinstance(pd.get('state'), dict) else {}
    inp = state.get('input') if isinstance(state.get('input'), dict) else {}
    k = tool_kind(name)
    target = None
    for key in ('filePath', 'path', 'file'):
        if isinstance(inp.get(key), str) and inp[key]:
            target = inp[key]
            break
    cwd = rec_out['cwd']
    if target and cwd and not os.path.isabs(target):
        target = os.path.normpath(os.path.join(cwd, target))
    entry = {'n': name, 'k': k, 'id': pd.get('callID') or part_id, 'off': part_id,
             'p': normalize.rel_path(target, cwd), 'chars': len(str(inp))}
    if k == 'exec' and isinstance(inp.get('command'), str):
        entry['c'] = normalize.command_key(inp['command'])
    if k == 'search' and isinstance(inp.get('pattern'), str):
        entry['c'] = normalize.short_hash(inp['pattern'])
    tools.append(entry)
    if k == 'edit' and entry['p']:
        if name == 'write':
            pairs = [(None, inp.get('content'))]
        else:
            pairs = [(inp.get('oldString'), inp.get('newString'))]
        for old, new in pairs:
            edits.append({'p': entry['p'], 'o': normalize._hash_or_none(old), 'n': normalize._hash_or_none(new)})
    output = state.get('output') if isinstance(state.get('output'), str) else ''
    if state.get('status') in ('completed', 'error'):
        times = state.get('time') if isinstance(state.get('time'), dict) else {}
        rec_out['results'].append({
            'ts': _secs(times.get('end')) or _secs(times.get('start')), 'tu': entry['id'], 'tool': name,
            'chars': len(output), 'est': round(normalize.est_tokens(output)),
            'err': state.get('status') == 'error',
            # Pruned by OpenCode (`compaction.prune`): the output no longer reaches the model.
            'pruned': 'compacted' in times,
        })


def instruction_files(cwd: Optional[str], home: Optional[str] = None) -> List[dict]:
    """Sizes of the instruction files OpenCode loads for `cwd`: `AGENTS.md` (or, without one,
    `CLAUDE.md`) in each folder from `cwd` up to its Git root, and the global
    `~/.config/opencode/AGENTS.md`. Sizes only; the text is never kept."""
    out: List[dict] = []
    if not cwd:
        return out
    d = cwd
    while True:
        for name in ('AGENTS.md', 'CLAUDE.md'):
            path = os.path.join(d, name)
            if os.path.isfile(path):
                out.append(_size(path, cwd))
                break
        if os.path.exists(os.path.join(d, '.git')):
            break
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    config = os.environ.get('XDG_CONFIG_HOME') or os.path.join(home or os.path.expanduser('~'), '.config')
    glob_file = os.path.join(config, 'opencode', 'AGENTS.md')
    if os.path.isfile(glob_file):
        out.append(_size(glob_file, cwd))
    return out


def _size(path: str, cwd: str) -> dict:
    try:
        with open(path, 'rb') as f:
            body = f.read()
    except OSError:
        body = b''
    return {'p': normalize.rel_path(path, cwd), 'type': 'Project', 'bytes': len(body),
            'lines': body.count(b'\n') + (1 if body and not body.endswith(b'\n') else 0)}


# ---- Reading text back for the excerpts ------------------------------------------------------

def prompt_text(d: '_db.Db', message_id) -> str:
    rows = d.query('SELECT data FROM part WHERE message_id = ? ORDER BY id', (message_id,))
    return _db.text_of_parts(rows).strip()


def reply_text(d: '_db.Db', part_id) -> str:
    rows = d.query('SELECT data FROM part WHERE id = ?', (part_id,))
    data = _db.loads(rows[0]['data']) if rows else {}
    return data.get('text').strip() if isinstance(data.get('text'), str) else ''


def command_text(d: '_db.Db', tool: dict) -> Optional[str]:
    if tool.get('k') != 'exec':
        return None
    rows = d.query('SELECT data FROM part WHERE id = ?', (tool.get('off'),))
    data = _db.loads(rows[0]['data']) if rows else {}
    inp = (data.get('state') or {}).get('input') if isinstance(data.get('state'), dict) else None
    cmd = inp.get('command') if isinstance(inp, dict) else None
    return cmd if isinstance(cmd, str) else None


def local_providers(config_path: Optional[str] = None) -> set:
    """Providers whose models run on this machine: the known local ones, and every provider in
    `opencode.json` whose `options.baseURL` is a loopback address."""
    import json
    out = set(LOCAL_PROVIDERS)
    path = config_path or os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.join(os.path.expanduser('~'), '.config'),
                                       'opencode', 'opencode.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            conf = json.load(f)
    except (OSError, ValueError):
        return out
    providers = conf.get('provider') if isinstance(conf, dict) else None
    for name, entry in (providers or {}).items() if isinstance(providers, dict) else []:
        base = ((entry or {}).get('options') or {}).get('baseURL') if isinstance(entry, dict) else None
        if isinstance(base, str) and any(h in base for h in ('://127.', '://localhost', '://[::1]', '://0.0.0.0')):
            out.add(name)
    return out

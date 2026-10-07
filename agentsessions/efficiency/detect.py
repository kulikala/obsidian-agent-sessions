"""Detectors (D-6, P1): E01, E02, E03, E04, E05, E08, E14, E16, for Claude Code, Codex and
OpenCode sessions alike. Where the agents differ -- the instruction file's name, when a cache
counts as expired (E04, not for OpenCode), how long an instruction file may be (E14) -- the
session's `agent` decides.

`run(analysed, base, rng)` takes the sessions of the range (each `{'session', 'tasks'}` from
`tasks.assemble` / `tasks.session_tasks(..., everything=True)`) and returns hits:
`{id, detector, agent, session, chain, ts, task, metrics, impact_w, impact_usd,
saving_rate, confidence, needs_llm, remedy_kind, change, targets}` plus `_contrib` for the
breakdown. Every signal is structural (sizes, counts, times, tool kinds and targets);
`needs_llm` marks the hits whose meaning only a model reading the excerpts can confirm.
"""

import bisect
import os
from typing import Dict, List, Optional, Tuple

from . import impact, normalize, tasks

E01_MIN_TOKENS = 8000
E01_MIN_R = 3
E01_FIX_REPEATS = 3
E02_FALLBACK = 200_000
E02_WINDOW_SHARE = 0.6
E02_BIG_WINDOW = 1_000_000
E02_MIN_CALLS = 10
E02_REWRITES = 3
E03_MIN_TASKS = 3
E03_MIN_CARRY = 100_000
E04_TTL_1H = 3600
E04_TTL_5M = 300
E04_FIX_REPEATS = 3
# Codex (OpenAI prompt caching): a call that reads less than this share of its input from the
# cache after a pause longer than the model's retention, following a call with more input than
# `E04_CODEX_MIN_PREV`.
E04_CODEX_HIT = 0.3
E04_CODEX_MIN_PREV = 20_000
E04_CODEX_TTL_NEW = 1800       # gpt-5.6 and later, gpt-6
E04_CODEX_TTL_OLD = 300
E08_FIRST_TOOLS = 15
E08_MIN_SESSIONS = 3
E08_MIN_TOKENS = 2000
E14_MARGIN = 10_000
E14_MIN_SESSIONS = 3
E14_LONG_FIRST = 5000
E14_MAX_LINES = 200            # Claude Code's CLAUDE.md
E14_MAX_BYTES = 20_000         # Codex's and OpenCode's AGENTS.md
E14_MAX_SKILLS = 50
E16_MIN_CORRECTIONS = 2
E16_MIN_INTERRUPTS = 2
E16_CALL_RATIO = 2.0

INSTRUCTION_NAMES = ('CLAUDE.md', 'AGENTS.md')
INSTRUCTION_FILE = {'claude': 'CLAUDE.md', 'codex': 'AGENTS.md', 'opencode': 'AGENTS.md'}
BUILD_DIRS = ('node_modules', 'dist', 'build', 'out', '.next', 'target', '__pycache__', '.venv')
SETTINGS = os.path.join('~', '.claude', 'settings.json')


def _hit(detector: str, session: str, origin: str, ts: Optional[float], **kw) -> dict:
    hit = {
        'id': tasks.hit_id(detector, session, origin), 'detector': detector, 'agent': kw.pop('agent', None),
        'session': session, 'chain': kw.pop('chain', 'main'), 'ts': ts, 'task': kw.pop('task', None),
        'metrics': kw.pop('metrics', {}), 'impact_w': kw.pop('impact_w', 0.0),
        'impact_usd': kw.pop('impact_usd', None), 'saving_rate': 0.0,
        'confidence': kw.pop('confidence', 'high'), 'needs_llm': kw.pop('needs_llm', False),
        'remedy_kind': kw.pop('remedy_kind', 'habit'), 'change': kw.pop('change', None),
        'targets': kw.pop('targets', []), '_contrib': kw.pop('_contrib', {}),
    }
    hit.update(kw)
    return hit


def _task_of(a: dict, call: dict) -> Optional[str]:
    """The id of the task `call` belongs to (`a` is one analysed session)."""
    index = a.get('_task_index')
    if index is None:
        index = a['_task_index'] = {impact.call_key(c): t['id'] for t in a['tasks'] for c in t['_calls']}
    return index.get(impact.call_key(call))


def _chain_calls(session: dict) -> Dict[str, List[dict]]:
    out: Dict[str, List[dict]] = {}
    for c in session['calls']:
        if c['ts'] is not None:
            out.setdefault(c['chain'], []).append(c)
    return out


def instruction_name(session: dict) -> str:
    return INSTRUCTION_FILE.get(session.get('agent') or 'claude', 'CLAUDE.md')


# ---- E01 -----------------------------------------------------------------------

def e01(analysed: List[dict], rng: Tuple[float, float]) -> List[dict]:
    """Large tool results that stay in the context and are read again by every later call."""
    found = []
    for a in analysed:
        s = a['session']
        chains = _chain_calls(s)
        issuer: Dict[str, Tuple[dict, dict]] = {}
        for c in s['calls']:
            for t in c['tools']:
                if t.get('id'):
                    issuer[t['id']] = (c, t)
        by_call: Dict[str, dict] = {}
        for r in s['results']:
            if r.get('pruned') or r['est'] < E01_MIN_TOKENS or not tasks.in_range(r['ts'], rng) or r['tu'] not in issuer:
                continue
            call, tool = issuer[r['tu']]
            later = impact.calls_after(chains.get(r['chain'], []), r['ts'],
                                       s['compactions'].get(r['chain'], []), rng[1])
            if len(later) < E01_MIN_R:
                continue
            entry = by_call.setdefault(impact.call_key(call), {
                'call': call, 'tool': tool, 'est': 0, 'later': later, 'results': 0})
            entry['est'] += r['est']
            entry['results'] += 1
        for entry in by_call.values():
            call, tool, est, later = entry['call'], entry['tool'], entry['est'], entry['later']
            contrib = {impact.call_key(c): est * impact.P_READ for c in later}
            owner = _e01_owner(s, call, tool)
            found.append(_hit(
                'E01', s['id'], call['id'], call['ts'], chain=call['chain'],
                task=_task_of(a, call),
                metrics={'est_tokens': est, 'reads_after': len(later), 'results': entry['results']},
                impact_w=est * len(later) * impact.P_READ,
                impact_usd=impact.usd_sum(impact.read_usd(est, c) for c in later),
                _contrib=contrib, _group=(owner, tool['n'], tool.get('c', '')), _owner=owner))
    groups: Dict[tuple, int] = {}
    for h in found:
        groups[h['_group']] = groups.get(h['_group'], 0) + 1
    for h in found:
        h['metrics']['repeats'] = groups[h['_group']]
        if groups[h['_group']] >= E01_FIX_REPEATS and h['_owner']:
            h.update(remedy_kind='fix', change='add', targets=[h['_owner']])
    return found


def _e01_owner(s: dict, call: dict, tool: dict) -> Optional[str]:
    """The instruction file a large result's rule belongs in (the same owner rule as E08): the
    owner of the file read, or, for a command, of the last file that chain read or edited
    before it (the repository being worked on); the session folder's own when there is none."""
    path = normalize.abs_path(tool.get('p'), call.get('cwd') or s['cwd']) if tool.get('p') else None
    if path is None:
        for c in reversed([c for c in s['calls'] if c['chain'] == call['chain']
                           and c['ts'] is not None and call['ts'] is not None and c['ts'] <= call['ts']]):
            touched = [t for t in c['tools'] if t['k'] in ('read', 'edit') and t.get('p')]
            if touched:
                path = normalize.abs_path(touched[-1]['p'], c.get('cwd') or s['cwd'])
                break
    name = instruction_name(s)
    owner = owner_instructions(path, name=name) if path else None
    if owner is None and s['cwd']:
        owner = os.path.join(s['cwd'], name)
    return owner


# ---- E02 -----------------------------------------------------------------------

def _threshold(chain_calls: List[dict]) -> int:
    """60% of the context window when it is known to be 1M (a call already went past 200K),
    200K otherwise."""
    if any(c['ctx'] > E02_FALLBACK for c in chain_calls):
        return int(E02_BIG_WINDOW * E02_WINDOW_SHARE)
    return E02_FALLBACK


def e02(analysed: List[dict], rng: Tuple[float, float]) -> List[dict]:
    """A task that keeps working with a very large context."""
    found = []
    for a in analysed:
        s = a['session']
        chains = _chain_calls(s)
        limits = {chain: _threshold(calls) for chain, calls in chains.items()}
        for t in a['tasks']:
            if not t['in_range']:
                continue
            over = [c for c in t['_ranged'] if c['ctx'] > limits.get(c['chain'], E02_FALLBACK)]
            if len(over) < E02_MIN_CALLS:
                continue
            first = over[0]
            contrib = {impact.call_key(c): (c['ctx'] - E02_FALLBACK) * impact.P_READ for c in over}
            found.append(_hit(
                'E02', s['id'], first['id'], first['ts'], chain=first['chain'], task=t['id'],
                metrics={'calls_over': len(over), 'max_ctx': max(c['ctx'] for c in over),
                         'threshold': limits.get(first['chain'], E02_FALLBACK),
                         'max_rewrites': t['max_rewrites']},
                impact_w=sum(contrib.values()),
                impact_usd=impact.usd_sum(impact.read_usd(c['ctx'] - E02_FALLBACK, c) for c in over),
                confidence='low' if t['max_rewrites'] >= E02_REWRITES else 'medium',
                _contrib=contrib))
    return found


# ---- E03 -----------------------------------------------------------------------

def e03(analysed: List[dict], rng: Tuple[float, float]) -> List[dict]:
    """One conversation that goes on to unrelated tasks, each re-reading the previous ones'
    context. Whether the topics really differ is left to the model (`needs_llm`)."""
    found = []
    for a in analysed:
        s = a['session']
        all_tasks = a['tasks']
        if len(all_tasks) < E03_MIN_TASKS:
            continue
        comps = s['compactions'].get('main', [])
        seen: set = set(all_tasks[0]['targets'])
        for k in range(1, len(all_tasks)):
            t = all_tasks[k]
            start = t['first_ts']
            overlap = bool(t['targets'] & seen)
            seen |= t['targets']
            if start is not None and any(x <= start for x in comps):
                break
            if not t['in_range'] or overlap or t['start_ctx'] <= E03_MIN_CARRY:
                continue
            main = [c for c in t['_ranged'] if c['chain'] == 'main']
            carry = t['start_ctx']
            origin = main[0]['id'] if main else t['id']
            found.append(_hit(
                'E03', s['id'], origin, start, task=t['id'], needs_llm=True, confidence='medium',
                metrics={'tasks': len(all_tasks), 'carry': carry, 'calls': len(main), 'position': k + 1},
                impact_w=carry * len(main) * impact.P_READ,
                impact_usd=impact.usd_sum(impact.read_usd(carry, c) for c in main),
                _contrib={impact.call_key(c): carry * impact.P_READ for c in main}))
    return found


# ---- E04 / E05 -----------------------------------------------------------------

def _cache_break(prev: dict, call: dict) -> bool:
    """Whether `call` wrote (Codex: sent uncached) most of its context again after `prev`."""
    if call.get('agent') == 'codex':
        return (prev['ctx'] > E04_CODEX_MIN_PREV and call['ctx'] > 0
                and call['cr'] < E04_CODEX_HIT * call['ctx'])
    return call['cw'] >= 0.5 * call['ctx'] and call['cr'] < 0.2 * prev['ctx']


def codex_retention(model: Optional[str]) -> int:
    """How long OpenAI keeps a prompt cache: 30 minutes from gpt-5.6 and gpt-6 on, 5 before."""
    m = model or ''
    if m.startswith('gpt-5.6') or (m.startswith('gpt-') and m[4:5].isdigit() and int(m[4:5]) >= 6):
        return E04_CODEX_TTL_NEW
    return E04_CODEX_TTL_OLD


def _rewrite_w(call: dict) -> float:
    """The weighted tokens a cache break costs: Claude Code's and OpenCode's cache writes over
    reads, Codex's uncached input over cached (0.9 of it)."""
    if call.get('agent') == 'codex':
        return call['in'] * (1 - impact.P_READ)
    return impact.write_w(call)


def _rewrite_usd(call: dict) -> Optional[float]:
    if call.get('agent') == 'codex':
        p = impact.prices(call)
        return call['in'] * (p['input'] - p['cache_read']) / impact.MTOK if p else None
    return impact.write_usd(call)


def _compacted_between(comps: List[float], a: float, b: float) -> bool:
    return any(a <= x <= b for x in comps)


def e04_e05(analysed: List[dict], rng: Tuple[float, float]) -> List[dict]:
    """E05: the model or effort changed and the next call wrote the whole cache again.
    E04: the cache expired over a pause (longer than its TTL) and was written again."""
    e04, e05 = [], []
    for a in analysed:
        s = a['session']
        session_e05 = []
        chains = _chain_calls(s)
        chain_kinds = {c['chain']: c['chain_kind'] for c in s['calls']}
        others = sorted((c['ts'], c['chain']) for calls in chains.values() for c in calls)
        for chain, calls in chains.items():
            comps = s['compactions'].get(chain, [])
            for prev, call in zip(calls, calls[1:]):
                if not tasks.in_range(call['ts'], rng) or not _cache_break(prev, call):
                    continue
                if _compacted_between(comps, prev['ts'], call['ts']):
                    continue
                w = _rewrite_w(call)
                common = dict(chain=chain, task=_task_of(a, call), impact_w=w,
                              impact_usd=_rewrite_usd(call),
                              _contrib={impact.call_key(call): w})
                changed_model = chain == 'main' and prev.get('model') and call.get('model') \
                    and prev['model'] != call['model']
                changed_effort = chain == 'main' and prev.get('effort') and call.get('effort') \
                    and prev['effort'] != call['effort']
                # OpenCode: the agent (build, plan, a custom one) switched in the conversation.
                changed_agent = chain == 'main' and prev.get('mode') and call.get('mode') \
                    and prev['mode'] != call['mode']
                if changed_model or changed_effort or changed_agent:
                    kind = 'model' if changed_model else 'effort' if changed_effort else 'agent'
                    key = {'model': 'model', 'effort': 'effort', 'agent': 'mode'}[kind]
                    session_e05.append(_hit(
                        'E05', s['id'], call['id'], call['ts'],
                        metrics={'from': prev.get(key), 'to': call.get(key), 'kind': kind,
                                 'cache_write': call['cw'] or call['in']},
                        _models=(prev.get('model'), call.get('model')) if changed_model else None,
                        **common))
                    continue
                if s.get('agent') == 'opencode':
                    continue        # retention depends on the provider (and local models are free)
                gap = call['ts'] - prev['ts']
                if s.get('agent') == 'codex':
                    ttl = codex_retention(prev.get('model'))
                else:
                    ttl = E04_TTL_1H if prev['cw1h'] > 0 else E04_TTL_5M
                if gap <= ttl or chain_kinds.get(chain) == 'teammate':
                    continue
                # A pause in which another chain of the session was working is waiting for
                # sub-agents or teammates, not the person coming back.
                if _busy_between(others, chain, prev['ts'], call['ts']):
                    continue
                e04.append(_hit(
                    'E04', s['id'], call['id'], call['ts'],
                    metrics={'gap': round(gap), 'ttl': ttl, 'cache_write': call['cw'] or call['in']},
                    _short_ttl=(s.get('agent', 'claude') == 'claude' and chain == 'main'
                                and ttl == E04_TTL_5M and gap <= E04_TTL_1H),
                    **common))
        e05.extend(_merge_round_trips(session_e05))
    short = [h for h in e04 if h['_short_ttl']]
    if len(short) >= E04_FIX_REPEATS:
        for h in short:
            h.update(remedy_kind='fix', change='add', targets=[os.path.expanduser(SETTINGS)])
    return e04 + e05


def _busy_between(others: List[Tuple[float, str]], chain: str, a: float, b: float) -> bool:
    """Whether a chain other than `chain` made a call strictly between `a` and `b`."""
    i = bisect.bisect_right(others, (a, '\uffff'))
    while i < len(others) and others[i][0] < b:
        if others[i][1] != chain:
            return True
        i += 1
    return False


def _merge_round_trips(hits: List[dict]) -> List[dict]:
    """Back-and-forth between two models in one session (`opusplan`) counts as one hit."""
    model_hits = [h for h in hits if h.get('_models')]
    models = {m for h in model_hits for m in h['_models']}
    if len(model_hits) < 2 or len(models) != 2:
        return hits
    first = model_hits[0]
    merged = dict(first)
    merged['impact_w'] = sum(h['impact_w'] for h in model_hits)
    merged['impact_usd'] = sum(h['impact_usd'] or 0.0 for h in model_hits)
    merged['_contrib'] = {k: v for h in model_hits for k, v in h['_contrib'].items()}
    merged['metrics'] = dict(first['metrics'], switches=len(model_hits))
    return [merged] + [h for h in hits if not h.get('_models')]


# ---- E08 -----------------------------------------------------------------------

def _is_build_output(path: str) -> bool:
    parts = path.replace(os.sep, '/').split('/')
    return any(p in BUILD_DIRS for p in parts) or path.endswith('.min.js')


def owner_instructions(path: str, name: str = 'CLAUDE.md') -> Optional[str]:
    """The instruction file (`name`: `CLAUDE.md`, or `AGENTS.md` for Codex and OpenCode) that owns
    `path`: `name` in the nearest folder above it that has a `.git` or a `name`. `None` when there
    is none (up to the file system root)."""
    d = path if os.path.isdir(path) else os.path.dirname(path)
    while True:
        if os.path.exists(os.path.join(d, '.git')) or os.path.isfile(os.path.join(d, name)):
            return os.path.join(d, name)
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def e08(analysed: List[dict], rng: Tuple[float, float]) -> List[dict]:
    """The same files read at the start of session after session in one folder: facts the
    instruction file could hold instead."""
    groups: Dict[Tuple[str, str], List[dict]] = {}
    for a in analysed:
        s = a['session']
        if not s['cwd']:
            continue
        written = {e['path'] for e in s['edits']}
        results = {r['tu']: r for r in s['results']}
        chains = _chain_calls(s)
        main = chains.get('main', [])
        seen: set = set()
        n = 0
        for c in main:
            if n >= E08_FIRST_TOOLS:
                break
            for t in c['tools']:
                if n >= E08_FIRST_TOOLS:
                    break
                n += 1
                if t['k'] not in ('read', 'search') or not tasks.in_range(c['ts'], rng):
                    continue
                path = normalize.abs_path(t.get('p'), s['cwd']) if t.get('p') else None
                if t['k'] == 'read':
                    if not path or os.path.basename(path) in INSTRUCTION_NAMES \
                            or path in written or _is_build_output(path):
                        continue
                    key = path
                else:
                    key = 'search:%s:%s' % (t.get('c', ''), path or '')
                if key in seen:
                    continue
                seen.add(key)
                r = results.get(t.get('id'))
                est = r['est'] if r else 0
                later = impact.calls_after(main, c['ts'], s['compactions'].get('main', []), rng[1])
                groups.setdefault((s['cwd'], key), []).append({
                    'session': s['id'], 'call': c, 'est': est, 'later': later, 'path': path,
                    'name': instruction_name(s)})
    found = []
    for (cwd, key), uses in groups.items():
        sessions = {u['session'] for u in uses}
        if len(sessions) < E08_MIN_SESSIONS:
            continue
        mean = sum(u['est'] for u in uses) / len(uses)
        if mean < E08_MIN_TOKENS:
            continue
        w = sum(u['est'] * len(u['later']) * impact.P_READ + u['est'] * 1.25 for u in uses)
        usd = impact.usd_sum(
            v for u in uses
            for v in [impact.write5_usd(u['est'], u['call'])] + [impact.read_usd(u['est'], c) for c in u['later']])
        latest = max(uses, key=lambda u: u['call']['ts'])
        owner = owner_instructions(latest['path'] or cwd, name=latest['name'])
        remedy = dict(remedy_kind='fix', change='add', targets=[owner]) if owner else {}
        # The file read again and again (a search: the folder it searched), named in the
        # finding and the fix request; `report` adds its masked form to `metrics`.
        read_path = latest['path'] or cwd
        found.append(_hit(
            'E08', cwd, key, latest['call']['ts'], read_path=read_path,
            metrics={'sessions': len(sessions), 'est_tokens': round(mean),
                     'kind': 'search' if key.startswith('search:') else 'read',
                     'outside_cwd': bool(owner) and not owner.startswith(cwd.rstrip(os.sep) + os.sep)},
            impact_w=w, impact_usd=usd,
            _contrib={impact.call_key(u['call']): u['est'] * len(u['later']) * impact.P_READ for u in uses},
            **remedy))
        found[-1]['session'] = latest['session']
    return found


# ---- E14 -----------------------------------------------------------------------

def _p10(values: List[int]) -> int:
    values = sorted(values)
    return values[max(int(len(values) * 0.1 + 0.999999) - 1, 0)]


def e14(analysed: List[dict], rng: Tuple[float, float]) -> List[dict]:
    """A session whose preamble (the first call's context) is well above this user's usual
    for the same folder and the same Claude Code version."""
    rows = []
    for a in analysed:
        s = a['session']
        main = _chain_calls(s).get('main', [])
        if not main or not s['version']:
            continue
        ranged = [c for c in main if tasks.in_range(c['ts'], rng)]
        if not ranged:
            continue
        rows.append({'a': a, 'pre': main[0]['ctx'], 'first': main[0], 'ranged': ranged})
    found = []
    for row in rows:
        s = row['a']['session']
        peers = [r['pre'] for r in rows if r['a']['session']['cwd'] == s['cwd']
                 and r['a']['session']['version'] == s['version']]
        if len(peers) < E14_MIN_SESSIONS:
            peers = [r['pre'] for r in rows if r['a']['session']['version'] == s['version']]
        if len(peers) < E14_MIN_SESSIONS:
            continue
        base = _p10(peers)
        excess = row['pre'] - base
        if excess < E14_MARGIN:
            continue
        prompts = s['prompts']
        if prompts and prompts[0]['chars'] > E14_LONG_FIRST:
            continue
        pre = s['main'].get('preamble', {})
        too_long = ((lambda f: f['lines'] > E14_MAX_LINES) if s.get('agent', 'claude') == 'claude'
                    else (lambda f: f['bytes'] > E14_MAX_BYTES))
        long_files = [f for f in pre.get('instr', []) if too_long(f) and f.get('p')]
        remedy = {}
        if long_files:
            src = normalize.abs_path(long_files[0]['p'], s['cwd'])
            remedy = dict(remedy_kind='fix', change='move', targets=[src, reference_file(src)])
        found.append(_hit(
            'E14', s['id'], row['first']['id'], row['first']['ts'],
            task=row['a']['tasks'][0]['id'] if row['a']['tasks'] else None,
            metrics={'preamble': row['pre'], 'baseline': base, 'excess': excess,
                     'skills': pre.get('skills'), 'instr_lines': sum(f['lines'] for f in pre.get('instr', [])),
                     'instr_bytes': sum(f['bytes'] for f in pre.get('instr', [])),
                     'long_file_lines': long_files[0]['lines'] if long_files else 0,
                     'many_skills': (pre.get('skills') or 0) > E14_MAX_SKILLS,
                     'tool_search_absent': bool(pre.get('tool_search_absent')),
                     'version': s['version'], 'calls': len(row['ranged'])},
            impact_w=excess * len(row['ranged']) * impact.P_READ,
            impact_usd=impact.usd_sum(impact.read_usd(excess, c) for c in row['ranged']),
            _contrib={impact.call_key(c): excess * impact.P_READ for c in row['ranged']},
            **remedy))
    return found


def reference_file(instructions: str) -> str:
    """Where `move` puts the sections taken out of a long instruction file: a reference file
    next to it, read only when needed."""
    folder = os.path.dirname(instructions)
    stem = os.path.splitext(os.path.basename(instructions))[0]
    return os.path.join(folder, '%s.reference.md' % stem)


# ---- E16 -----------------------------------------------------------------------

def e16(analysed: List[dict], base: dict, rng: Tuple[float, float]) -> List[dict]:
    """Round trips of corrections in one task (structure only; `needs_llm`)."""
    if 'E16' in base['disabled'] or not base.get('C_med'):
        return []
    found = []
    for a in analysed:
        s = a['session']
        for t in a['tasks']:
            if not t['in_range']:
                continue
            if not (t['corrections'] >= E16_MIN_CORRECTIONS or t['reverts'] >= 1
                    or t['interrupts'] >= E16_MIN_INTERRUPTS):
                continue
            if t['all_calls'] < E16_CALL_RATIO * base['C_med'] * t['turns']:
                continue
            turns = t['_turns']
            first = next((x for x in turns if x['rework']), None) \
                or next((x for x in turns if x['interrupts']), turns[0])
            start = first['prompt']['ts'] if first['prompt'] else None
            after = [c for c in t['_ranged'] if start is None or (c['ts'] is not None and c['ts'] >= start)]
            origin_call = (first['main'] or first['sub'] or [None])[0]
            origin = origin_call['id'] if origin_call else (first['prompt'] or {}).get('uuid') or t['id']
            found.append(_hit(
                'E16', s['id'], origin, start, task=t['id'], needs_llm=True, confidence='medium',
                metrics={'corrections': t['corrections'], 'reverts': t['reverts'],
                         'interrupts': t['interrupts'], 'calls': t['all_calls'], 'turns': t['turns'],
                         'calls_ratio': t['calls_ratio'], 'max_rewrites': t['max_rewrites']},
                impact_w=sum(normalize.w_of(c) for c in after),
                impact_usd=impact.usd_sum(impact.call_usd(c) for c in after),
                _contrib={impact.call_key(c): normalize.w_of(c) for c in after}))
    return found


# ---- All ------------------------------------------------------------------------

def run(analysed: List[dict], base: dict, rng: Tuple[float, float]) -> Tuple[List[dict], int]:
    """`(hits, collisions)`: every P1 hit of the range, largest impact first. Of two hits with
    the same id (a hash collision) the later one is dropped and counted in `collisions`."""
    hits = (e01(analysed, rng) + e02(analysed, rng) + e03(analysed, rng)
            + e04_e05(analysed, rng) + e08(analysed, rng) + e14(analysed, rng)
            + e16(analysed, base, rng))
    agents = {a['session']['id']: a['session'].get('agent') or 'claude' for a in analysed}
    for h in hits:
        h['agent'] = agents.get(h['session'], 'claude')
        impact.finish(h)
    hits.sort(key=lambda h: (-h['impact_w'], h['id']))
    out, seen = [], set()
    for h in hits:
        if h['id'] in seen:
            continue
        seen.add(h['id'])
        out.append(h)
    return out, len(hits) - len(out)


def public(hit: dict) -> dict:
    """`hit` without the private keys (those starting with `_`)."""
    return {k: v for k, v in hit.items() if not k.startswith('_')}

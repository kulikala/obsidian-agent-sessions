"""Sessions, turns, the user's baselines, and tasks (D-5).

A *session* is a main transcript's file record plus its sub-agent and teammate records
(`normalize.read_file`). A *turn* runs from one human prompt to just before the next.
Sub-agent calls join the turn whose `Agent` tool call started them (linked by the tool
call id -> `toolUseResult.agentId` -> `agent-<agentId>.jsonl`); teammate calls, and
sub-agent calls with no link, join the turn their time falls in.

Baselines are the user's own usual values over a fixed window (the 14 days before `now`,
whatever the analysed range), so every threshold is a ratio to how this person normally
writes and works, not to a fixed number that would favour one language:

- `L_med`: median length (estimated tokens) of a human prompt.
- `L1_med`: median length of a *starting* prompt (a session's first, or one that comes
  30 minutes or more after the agent's last output).
- `C_med`: median calls per turn, sub-agent and teammate calls included.

A task is one or more turns. A turn starts a new task at the start of a session, or when it
comes 30 minutes or more after the agent's last output *and* touches none of the files
the current task touched. A turn that looks like rework stays with the task before it.
Rework candidates are found from structure alone (`needs_llm` later decides whether they
really were corrections):

1. a short prompt (at most half of `L_med`) within 10 minutes of the last output, after a
   turn that edited a file, which edits the same file again;
2. an edit that puts back text an earlier edit of the same file replaced (a revert);
3. a turn that follows an interrupted turn.
"""

import hashlib
import statistics
from typing import Dict, List, Optional, Tuple

from . import normalize

WINDOW_DAYS = 14
DAY = 86400.0
TASK_GAP_SECONDS = 30 * 60
REWORK_GAP_SECONDS = 10 * 60
REWORK_LENGTH_RATIO = 0.5
MIN_INPUTS = 100            # fewer prompts in the window: rules using L_med / C_med stop
MIN_STARTS = 60             # fewer starting prompts: rules using L1_med stop
FIRST_CALLS = 10

DISABLE_SHORT_REWORK = 'rework_short'


def _sha10(*parts: str) -> str:
    return hashlib.sha1('\0'.join(parts).encode('utf-8', 'surrogatepass')).hexdigest()[:10]


def task_id(session: str, first_key: str) -> str:
    return 't-' + _sha10(session, first_key)


def hit_id(detector: str, session: str, origin: str) -> str:
    return 'h-' + _sha10(detector, session, origin)


# ---- Sessions ----------------------------------------------------------------

def assemble(main: dict, subs: List[dict]) -> dict:
    """One session from its file records: every call and result tagged with its chain."""
    sid = main.get('session') or ''
    calls: List[dict] = []
    results: List[dict] = []
    edits: List[dict] = []
    chains = [main] + list(subs)
    for rec in chains:
        cwd = rec.get('cwd') or main.get('cwd')
        for c in rec.get('calls', []):
            item = dict(c, chain=rec['chain'], chain_kind=rec['kind'], cwd=cwd)
            calls.append(item)
            for e in c.get('edits', []):
                edits.append({'ts': c['ts'], 'call': c['id'], 'chain': rec['chain'],
                              'path': normalize.abs_path(e['p'], cwd), 'o': e['o'], 'n': e['n']})
        for r in rec.get('results', []):
            results.append(dict(r, chain=rec['chain'], chain_kind=rec['kind']))
    calls.sort(key=lambda c: (c['ts'] is None, c['ts'] or 0))
    edits.sort(key=lambda e: (e['ts'] is None, e['ts'] or 0))
    _mark_reverts(edits)
    return {
        'id': sid, 'cwd': main.get('cwd'), 'version': main.get('version'),
        'main': main, 'subs': list(subs), 'calls': calls, 'results': results, 'edits': edits,
        'prompts': sorted(main.get('prompts', []), key=lambda p: (p['ts'] is None, p['ts'] or 0)),
        'events': sorted(main.get('events', []), key=lambda e: (e['ts'] is None, e['ts'] or 0)),
        'team': any(r['kind'] == 'teammate' for r in subs)
                or any(e['k'] == 'team_start' for e in main.get('events', [])),
    }


def _mark_reverts(edits: List[dict]) -> None:
    """`revert` on an edit whose new text equals the old text of an earlier edit of the
    same file (compared by hash)."""
    olds: Dict[str, set] = {}
    for e in edits:
        e['revert'] = bool(e['n'] and e['n'] in olds.get(e['path'], ()))
        if e['o']:
            olds.setdefault(e['path'], set()).add(e['o'])


# ---- Turns -------------------------------------------------------------------

def turns_of(session: dict) -> List[dict]:
    """The session's turns, each with its main calls, the sub-agent and teammate calls that
    belong to it, interruptions, compactions, edits, reverts and targets."""
    prompts = session['prompts']
    main_calls = [c for c in session['calls'] if c['chain'] == 'main']
    if prompts:
        starts = [p['ts'] if p['ts'] is not None else float('-inf') for p in prompts]
        turns = [_new_turn(i, p) for i, p in enumerate(prompts)]
    else:
        if not main_calls:
            return []
        starts = [float('-inf')]
        turns = [_new_turn(0, None)]

    def index_at(ts: Optional[float]) -> int:
        if ts is None:
            return 0
        lo, hi = 0, len(starts)
        while lo < hi:
            mid = (lo + hi) // 2
            if starts[mid] <= ts:
                lo = mid + 1
            else:
                hi = mid
        return max(lo - 1, 0)

    turn_of_call: Dict[str, int] = {}
    tool_turn: Dict[str, int] = {}
    for c in main_calls:
        i = index_at(c['ts'])
        turns[i]['main'].append(c)
        turn_of_call[c['id']] = i
        for t in c['tools']:
            if t.get('id'):
                tool_turn[t['id']] = i
    linked: Dict[str, int] = {}
    for link in session['main'].get('links', []):
        if link.get('tu') in tool_turn:
            linked[link['agent']] = tool_turn[link['tu']]
    for c in session['calls']:
        if c['chain'] == 'main':
            continue
        if c['chain_kind'] == 'subagent' and c['chain'] in linked:
            i = linked[c['chain']]
        else:
            i = index_at(c['ts'])
        turns[i]['sub'].append(c)
        turn_of_call[c['chain'] + '\0' + c['id']] = i
    for e in session['events']:
        i = index_at(e['ts'])
        if e['k'] == 'interrupt':
            turns[i]['interrupts'] += 1
        elif e['k'] == 'compaction':
            turns[i]['compactions'] += 1
        elif e['k'] == 'team_start':
            turns[i]['team'] = True
    for e in session['edits']:
        key = e['call'] if e['chain'] == 'main' else e['chain'] + '\0' + e['call']
        i = turn_of_call.get(key, index_at(e['ts']))
        t = turns[i]
        if e['chain'] == 'main':
            t['main_edits'].setdefault(e['path'], 0)
            t['main_edits'][e['path']] += 1
        t['edits'].setdefault(e['path'], 0)
        t['edits'][e['path']] += 1
        if e['revert']:
            t['reverts'] += 1
    for t in turns:
        for c in t['main'] + t['sub']:
            for tool in c['tools']:
                if tool['k'] in ('read', 'search', 'edit') and tool.get('p'):
                    t['targets'].add(normalize.abs_path(tool['p'], c.get('cwd')))
            if c['chain_kind'] == 'teammate':
                t['team'] = True
        t['calls'] = len(t['main']) + len(t['sub'])
        t['ends'] = max((c['ts'] for c in t['main'] if c['ts'] is not None), default=None)
    return turns


def _new_turn(i: int, prompt: Optional[dict]) -> dict:
    return {'idx': i, 'prompt': prompt, 'main': [], 'sub': [], 'interrupts': 0,
            'compactions': 0, 'main_edits': {}, 'edits': {}, 'reverts': 0,
            'targets': set(), 'team': False, 'rework': [], 'calls': 0}


# ---- Baselines ---------------------------------------------------------------

def baselines(sessions: List[dict], now: float, window_days: int = WINDOW_DAYS,
              turns_by_session: Optional[Dict[str, List[dict]]] = None) -> dict:
    """The user's usual values over `[now - window_days, now]`; see the module docstring.
    `disabled` lists the rules that stop because the window holds too few prompts."""
    start = now - window_days * DAY
    lengths: List[float] = []
    starting: List[float] = []
    per_turn: List[int] = []
    for s in sessions:
        turns = turns_by_session.get(s['id']) if turns_by_session else None
        if turns is None:
            turns = turns_of(s)
        for t in turns:
            p = t['prompt']
            if p is None or p['ts'] is None or not (start <= p['ts'] <= now):
                continue
            lengths.append(p['est'])
            if t['idx'] == 0 or (p['gap'] is not None and p['gap'] >= TASK_GAP_SECONDS):
                starting.append(p['est'])
            if t['calls'] > 0:
                per_turn.append(t['calls'])
    disabled: List[str] = []
    if len(lengths) < MIN_INPUTS:
        disabled += [DISABLE_SHORT_REWORK, 'E16']
    if len(starting) < MIN_STARTS or len(lengths) < MIN_INPUTS:
        disabled.append('E17')
    return {
        'window_days': window_days, 'inputs': len(lengths), 'starts': len(starting),
        'L_med': round(statistics.median(lengths), 1) if lengths else None,
        'L1_med': round(statistics.median(starting), 1) if starting else None,
        'C_med': statistics.median(per_turn) if per_turn else None,
        'disabled': disabled,
    }


# ---- Rework and tasks --------------------------------------------------------

def mark_rework(turns: List[dict], base: dict) -> None:
    """Fill each turn's `rework` with the rules (1, 2, 3) it meets; see the module docstring."""
    short_ok = DISABLE_SHORT_REWORK not in base['disabled'] and base.get('L_med')
    for i, t in enumerate(turns):
        t['rework'] = []
        if i == 0:
            continue
        prev = turns[i - 1]
        p = t['prompt']
        if (short_ok and p is not None and not p['cmd'] and not prev['compactions']
                and p['est'] <= REWORK_LENGTH_RATIO * base['L_med']
                and p['gap'] is not None and p['gap'] <= REWORK_GAP_SECONDS
                and prev['main_edits'] and set(prev['main_edits']) & set(t['main_edits'])):
            t['rework'].append(1)
        if t['reverts']:
            t['rework'].append(2)
        prev_cmd = prev['prompt'] is not None and prev['prompt']['cmd']
        if prev['interrupts'] and not prev['compactions'] and not prev_cmd:
            t['rework'].append(3)


def split_tasks(session: dict, turns: List[dict]) -> List[List[dict]]:
    """Turns grouped into tasks (see the module docstring)."""
    groups: List[List[dict]] = []
    targets: set = set()
    for t in turns:
        p = t['prompt']
        new = not groups
        if not new and not t['rework'] and p is not None and p['gap'] is not None \
                and p['gap'] >= TASK_GAP_SECONDS and not (t['targets'] & targets):
            new = True
        if new:
            groups.append([t])
            targets = set(t['targets'])
        else:
            groups[-1].append(t)
            targets |= t['targets']
    return groups


def in_range(ts: Optional[float], rng: Tuple[float, float]) -> bool:
    return ts is not None and rng[0] <= ts <= rng[1]


def task_record(session: dict, group: List[dict], base: dict, rng: Tuple[float, float]) -> dict:
    """The numbers of one task (D-5). Structure (turns, rework, calls) counts the whole task,
    so the same task looks the same from any range; `w` and `calls` count only the calls
    inside `rng`."""
    first = group[0]
    p0 = first['prompt']
    all_calls = sorted([c for t in group for c in t['main'] + t['sub']],
                       key=lambda c: (c['ts'] is None, c['ts'] or 0))
    if p0 is not None:
        key = p0.get('uuid') or repr(p0['ts'])
    else:
        key = repr(all_calls[0]['ts']) if all_calls else 'none'
    tid = task_id(session['id'], key)
    prompts = []
    for t in group:
        if t['prompt'] is not None:
            prompts.append(dict(t['prompt'], ref='%s.p%d' % (tid, len(prompts) + 1),
                                turn=t['idx'], rework=list(t['rework'])))
    main = [c for t in group for c in t['main']]
    ranged = [c for c in all_calls if in_range(c['ts'], rng)]
    writes: Dict[str, int] = {}
    reads: set = set()
    written: set = set()
    for t in group:
        for path, n in t['edits'].items():
            writes[path] = writes.get(path, 0) + n
            written.add(path)
        for c in t['main'] + t['sub']:
            for tool in c['tools']:
                if tool['k'] in ('read', 'search') and tool.get('p'):
                    reads.add(normalize.abs_path(tool['p'], c.get('cwd')))
    head = all_calls[:FIRST_CALLS]
    look = [c for c in head if c['tools'] and all(x['k'] in ('read', 'search') for x in c['tools'])]
    look_targets = {normalize.abs_path(x['p'], c.get('cwd')) for c in look for x in c['tools'] if x.get('p')}
    subagents = {c['chain'] for c in all_calls if c['chain_kind'] == 'subagent'}
    rework_turns = [t for t in group if t['rework']]
    return {
        'id': tid, 'session': session['id'], 'provider': 'anthropic',
        'first_ts': (p0['ts'] if p0 is not None else (all_calls[0]['ts'] if all_calls else None)),
        'last_ts': max((c['ts'] for c in all_calls if c['ts'] is not None), default=None),
        'turns': len(group), 'all_calls': len(all_calls), 'calls': len(ranged),
        'w': round(sum(normalize.w_of(c) for c in ranged)),
        'start_ctx': main[0]['ctx'] if main else 0,
        'end_ctx': main[-1]['ctx'] if main else 0,
        'reads': len(reads), 'writes': len(written),
        'corrections': len(rework_turns),
        'reverts': sum(t['reverts'] for t in group),
        'max_rewrites': max(writes.values(), default=0),
        'interrupts': sum(t['interrupts'] for t in group),
        'compactions': sum(t['compactions'] for t in group),
        'calls_ratio': (round(len(all_calls) / (base['C_med'] * len(group)), 2)
                        if base.get('C_med') else None),
        'first_ratio': (round(p0['est'] / base['L1_med'], 2)
                        if p0 is not None and base.get('L1_med') else None),
        'first_mentions_file': bool(p0['mf']) if p0 is not None else False,
        'first_look_share': round(len(look) / len(head), 2) if head else 0.0,
        'first_look_targets': len(look_targets),
        'subagents': len(subagents),
        'team': any(t['team'] for t in group),
        'prompts': prompts,
        'turn_idx': [t['idx'] for t in group],
        'targets': reads | written,
        '_calls': all_calls,
        '_ranged': ranged,
        '_turns': group,
    }


def session_tasks(session: dict, base: dict, rng: Tuple[float, float],
                  turns: Optional[List[dict]] = None) -> List[dict]:
    """Every task of `session` that has a prompt or a call inside `rng`, oldest first."""
    if turns is None:
        turns = turns_of(session)
    mark_rework(turns, base)
    out = []
    for group in split_tasks(session, turns):
        rec = task_record(session, group, base, rng)
        if rec['_ranged'] or any(in_range(p['ts'], rng) for p in rec['prompts']):
            out.append(rec)
    return out

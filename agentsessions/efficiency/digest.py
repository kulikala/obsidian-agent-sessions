"""The digest an analysis sends: every task of one pane's range, as text a model can read.

Per task: its id, its session (masked name and folder), when it started, and its turns. Per
turn: the user's prompt (masked, at most `PROMPT_CHARS`), the start of the agent's last reply
(at most `REPLY_CHARS`), and the turn's numbers -- weighted tokens, calls, tool calls by kind,
the files it read, searched or edited (masked, at most `MAX_PATHS`), interrupts, compactions,
the pause before it, how long it ran, its largest context, its largest tool result, the cache it
had to write again, the models it used and the structural rework marks. Tool output and file
contents are never part of it.

Besides the text, each task carries `saving`: for each check of the dialog, the weighted tokens
fixing that kind of waste in this task could save at most, from the detectors' own impact
formulas and saving rates (`impact.SAVING_RATE`) applied to the task's numbers without their
thresholds. The plugin adds these up over the tasks a finding cites; they are not sent.

The statistics' hits go along as `hints`: what the detectors found, to read alongside the tasks,
never a condition of a verdict.
"""

import time
from typing import Dict, List, Optional, Tuple

from . import detect, impact, normalize, tasks
from .excerpt import ClaudeTexts, Masker

PROMPT_CHARS = 600
REPLY_CHARS = 200
MAX_PATHS = 8
MAX_TURNS = 40
MAX_HINTS = 200
# A tool result counts as large output from this size (estimated tokens).
LARGE_RESULT = 2000
# What fixing waste the agent found on its own could save, as a share of the tasks' tokens.
FOUND_RATE = 0.3

CHECKS = ('rework', 'firstRequest', 'mixedTasks', 'longContext', 'largeOutput', 'cacheRebuild',
          'repeatedLookups', 'startupSize', 'found')


def _iso(ts: Optional[float]) -> Optional[str]:
    return time.strftime('%Y-%m-%dT%H:%M', time.localtime(ts)) if ts is not None else None


def _cache_breaks(session: dict) -> Dict[str, float]:
    """The weighted tokens of each call that wrote its context again (`detect._cache_break`
    after the call before it in its chain, no compaction between), by call key."""
    out: Dict[str, float] = {}
    chains: Dict[str, List[dict]] = {}
    for c in session['calls']:
        if c['ts'] is not None:
            chains.setdefault(c['chain'], []).append(c)
    for chain, calls in chains.items():
        comps = session['compactions'].get(chain, [])
        for prev, call in zip(calls, calls[1:]):
            if detect._cache_break(prev, call) and not detect._compacted_between(comps, prev['ts'], call['ts']):
                out[impact.call_key(call)] = detect._rewrite_w(call)
    return out


def _pick_turns(group: List[dict]) -> List[dict]:
    """At most `MAX_TURNS`: the first, the rework candidates and the last first."""
    if len(group) <= MAX_TURNS:
        return group
    chosen = [0, len(group) - 1] + [i for i, t in enumerate(group) if t['rework']]
    keep: List[int] = []
    for i in chosen + list(range(len(group))):
        if i not in keep and len(keep) < MAX_TURNS:
            keep.append(i)
    return [group[i] for i in sorted(keep)]


def _p10(values: List[int]) -> int:
    values = sorted(values)
    return values[max(int(len(values) * 0.1 + 0.999999) - 1, 0)]


class _Session:
    """What the digest needs of one session, worked out once."""

    def __init__(self, a: dict, rng: Tuple[float, float]):
        s = a['session']
        self.s = s
        self.breaks = _cache_breaks(s)
        self.results = {r['tu']: r for r in s['results'] if r.get('tu')}
        self.main = [c for c in s['calls'] if c['chain'] == 'main' and c['ts'] is not None]
        self.preamble = self.main[0]['ctx'] if self.main else None
        self.first_task = a['tasks'][0]['id'] if a['tasks'] else None
        self.rng = rng

    def results_of(self, calls: List[dict]) -> List[dict]:
        return [self.results[t['id']] for c in calls for t in c['tools'] if t.get('id') in self.results]


def _turn(sess: _Session, t: dict, ref: Optional[str], mask: Masker, texts) -> dict:
    s, rng = sess.s, sess.rng
    calls = sorted(t['main'] + t['sub'], key=lambda c: (c['ts'] is None, c['ts'] or 0))
    ranged = [c for c in calls if tasks.in_range(c['ts'], rng)]
    kinds: Dict[str, int] = {}
    for c in calls:
        for tool in c['tools']:
            kinds[tool['k']] = kinds.get(tool['k'], 0) + 1
    paths: List[str] = []
    for c in calls:
        for tool in c['tools']:
            if tool['k'] in ('read', 'search', 'edit') and tool.get('p'):
                shown = mask.path(normalize.abs_path(tool['p'], c.get('cwd')))
                if shown not in paths:
                    paths.append(shown)
    p = t['prompt']
    start = p['ts'] if p is not None else (calls[0]['ts'] if calls else None)
    end = max((c['ts'] for c in calls if c['ts'] is not None), default=None)
    results = sess.results_of(calls)
    out = {
        'ref': ref,
        'at': _iso(start),
        'prompt': mask(texts.prompt(s, p['off']))[:PROMPT_CHARS] if p is not None else None,
        'w': round(sum(normalize.w_of(c) for c in ranged)),
        'calls': len(calls),
        'subagent_calls': len(t['sub']),
        'tools': kinds,
        'paths': paths[:MAX_PATHS],
        'more_paths': max(len(paths) - MAX_PATHS, 0),
        'interrupts': t['interrupts'],
        'compactions': t['compactions'],
        'pause_min': round(p['gap'] / 60, 1) if p is not None and p['gap'] is not None else None,
        'elapsed_s': round(end - start) if start is not None and end is not None and end >= start else None,
        'max_ctx': max((c['ctx'] for c in t['main']), default=0),
        'largest_result': max((r['est'] for r in results), default=0),
        'cache_rewrite_w': round(sum(sess.breaks.get(impact.call_key(c), 0.0) for c in ranged)),
        'models': sorted({c['model'] for c in t['main'] if c.get('model')}),
        'rework': list(t['rework']),
    }
    last = next((c for c in reversed(t['main']) if c.get('text_off') is not None), None)
    if last is not None and ref:
        reply = mask(texts.reply(s, last['text_off']))[:REPLY_CHARS]
        if reply:
            out['reply'] = reply
            out['reply_ref'] = ref.replace('.p', '.r')
    # Zeros and empty values say nothing: left out to keep the digest short.
    return {k: v for k, v in out.items() if k in ('w', 'calls') or v not in (None, 0, [], {}, '')}


def saving(sess: _Session, task: dict, preamble_base: Optional[int]) -> Dict[str, int]:
    """For each check, the weighted tokens fixing it in `task` could save at most: the impact
    formula of the check's detector applied to the task (no threshold), times its saving rate."""
    rng = sess.rng
    group = task['_turns']
    ranged = task['_ranged']
    main = [c for c in ranged if c['chain'] == 'main']
    rate = impact.SAVING_RATE
    out: Dict[str, float] = {}

    # E16: the calls from the first corrected (or interrupted) turn on.
    first = next((x for x in group if x['rework']), None) or next((x for x in group if x['interrupts']), group[0])
    start = first['prompt']['ts'] if first['prompt'] else None
    after = [c for c in ranged if start is None or (c['ts'] is not None and c['ts'] >= start)]
    out['rework'] = sum(normalize.w_of(c) for c in after) * rate['E16']
    # E17: the first turn's calls.
    head = [c for c in group[0]['main'] + group[0]['sub'] if tasks.in_range(c['ts'], rng)]
    out['firstRequest'] = sum(normalize.w_of(c) for c in head) * rate['E17']
    # E03: the context carried in from the session's earlier tasks, read by every main call.
    carry = task['start_ctx'] if task['id'] != sess.first_task else 0
    out['mixedTasks'] = carry * len(main) * impact.P_READ * rate['E03']
    # E02: context over the usual window, on every call over the threshold.
    limit = detect._threshold(sess.main)
    over = [c for c in ranged if c['ctx'] > limit]
    out['longContext'] = sum((c['ctx'] - detect.E02_FALLBACK) * impact.P_READ for c in over) * rate['E02']
    # E01: each large result, read again by the later calls of its chain.
    chains: Dict[str, List[dict]] = {}
    for c in sess.s['calls']:
        if c['ts'] is not None:
            chains.setdefault(c['chain'], []).append(c)
    large = 0.0
    for r in sess.results_of(ranged):
        if r.get('pruned') or r['est'] < LARGE_RESULT or r['ts'] is None:
            continue
        later = impact.calls_after(chains.get(r['chain'], []), r['ts'],
                                   sess.s['compactions'].get(r['chain'], []), rng[1])
        large += r['est'] * len(later) * impact.P_READ
    out['largeOutput'] = large * rate['E01']
    # E04 / E05: the cache written again.
    out['cacheRebuild'] = sum(sess.breaks.get(impact.call_key(c), 0.0) for c in ranged) * rate['E04']
    # E08: what the task's first tool calls read or searched, written once and read again after.
    looked = 0.0
    n = 0
    comps = sess.s['compactions'].get('main', [])
    for c in [c for c in task['_calls'] if c['chain'] == 'main']:
        for tool in c['tools']:
            if n >= detect.E08_FIRST_TOOLS:
                break
            n += 1
            if tool['k'] not in ('read', 'search') or not tasks.in_range(c['ts'], rng):
                continue
            r = sess.results.get(tool.get('id'))
            est = r['est'] if r else 0
            later = [x for x in impact.calls_after(sess.main, c['ts'], comps, rng[1])
                     if x['ts'] <= (task['last_ts'] or rng[1])]
            looked += est * len(later) * impact.P_READ + est * 1.25
    out['repeatedLookups'] = looked * rate['E08']
    # E14: the preamble over this user's usual one, read by every main call.
    excess = max((sess.preamble or 0) - preamble_base, 0) if preamble_base is not None else 0
    out['startupSize'] = excess * len(main) * impact.P_READ * rate['E14']
    out['found'] = task['w'] * FOUND_RATE
    return {k: round(v) for k, v in out.items()}


def build(analysed: List[dict], hits: List[dict], mask: Masker, names: Dict[str, str],
          rng: Tuple[float, float], texts=None, agent: str = 'claude', context: Optional[dict] = None) -> dict:
    """The digest of `analysed` (one pane's sessions, each `{'session', 'tasks'}`): `context`
    (the range, totals and baselines, instruction files and skills), `sessions`, `tasks` oldest
    first, and `hints` (the hits, at most `MAX_HINTS`)."""
    texts = texts or ClaudeTexts()
    sess = {a['session']['id']: _Session(a, rng) for a in analysed}
    preambles = [x.preamble for x in sess.values() if x.preamble]
    preamble_base = _p10(preambles) if len(preambles) >= detect.E14_MIN_SESSIONS else None
    sessions = []
    instr: Dict[str, dict] = {}
    skills = []
    for a in analysed:
        s = a['session']
        pre = s['main'].get('preamble', {})
        if pre.get('skills') is not None:
            skills.append(pre['skills'])
        for f in pre.get('instr', []):
            shown = mask.path(normalize.abs_path(f.get('p'), s['cwd']))
            instr[shown] = {'file': shown, 'type': f.get('type'), 'bytes': f['bytes'], 'lines': f['lines']}
        sessions.append({'id': s['id'], 'name': mask(names[s['id']]) if names.get(s['id']) else None,
                         'folder': mask.folder(s['cwd']), 'preamble': sess[s['id']].preamble,
                         'tasks': sum(1 for t in a['tasks'] if t['in_range'])})
    rows = []
    for a in analysed:
        x = sess[a['session']['id']]
        for t in a['tasks']:
            if not t['in_range']:
                continue
            refs = {p['turn']: p['ref'] for p in t['prompts']}
            turns = [_turn(x, g, refs.get(g['idx']), mask, texts) for g in _pick_turns(t['_turns'])]
            rows.append({
                'id': t['id'], 'session': t['session'], 'at': _iso(t['first_ts']), 'ts': t['first_ts'],
                'w': t['w'], 'calls': t['calls'], 'start_ctx': t['start_ctx'], 'end_ctx': t['end_ctx'],
                'turn_count': t['turns'], 'turns': turns,
                'saving': saving(x, t, preamble_base),
            })
    rows.sort(key=lambda r: (r['ts'] is None, r['ts'] or 0, r['id']))
    hints = [{'id': h['id'], 'detector': h['detector'], 'session': h['session'], 'task': h['task'],
              'metrics': {k: mask(v) if isinstance(v, str) else v for k, v in h['metrics'].items()
                          if not isinstance(v, (list, dict))},
              'targets': [mask.users(t) for t in h.get('shown_targets', [])]} for h in hits[:MAX_HINTS]]
    return {
        'agent': agent,
        'context': dict(context or {}, instructions=sorted(instr.values(), key=lambda x: x['file']),
                        skills=max(skills) if skills else None, preamble_usual=preamble_base),
        'sessions': sessions,
        'tasks': rows,
        'hints': hints,
    }

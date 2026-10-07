"""`json efficiency` for one agent: sessions -> range -> tasks -> hits -> the output block of D-8.

The agent's sessions come from a source (`sources.py`: Claude Code, Codex or OpenCode). The range
is fixed once per run (D-3), statistics and excerpts come from the same read, and nothing here
carries display text: the plugin chooses the words in the UI language.

What may be sent to a model is split into panes, one per provider the sessions used (Claude Code
has one): each pane's summary and excerpts name only that provider's sessions, so a conversation
held with a local model never reaches another provider, not even by its name.
"""

import statistics
from typing import Dict, List, Optional, Tuple

from . import cache, detect, excerpt, impact, normalize, sources, tasks

DAY = 86400.0
MAX_LOOKBACK_DAYS = 7
MIN_LOOKBACK_HOURS = 24
DEFAULT_THRESHOLD = 80.0
DEFAULT_BUDGET = 10_000_000
DEFAULT_MAX_SESSIONS = 200
MAX_TASKS_OUT = 20
MAX_HITS_OUT = 200
SUMMARY_TASKS = 20
SUMMARY_HITS = 40
# Room kept for the session rows the excerpts add to the summary.
SUMMARY_SLACK = 2000


# ---- Range (D-3) ----------------------------------------------------------------

def choose_range(now: float, windows: Dict[str, dict], calls: List[dict], threshold: float,
                 budget: float) -> dict:
    """The first rule that applies: the 5-hour window at or over `threshold` (or exhausted),
    the 7-day window likewise, else the newest calls up to `budget` weighted tokens, and at
    least the last 24 hours (no further back than 7 days)."""
    floor = now - MAX_LOOKBACK_DAYS * DAY
    # Codex may report only another length (a 30-day window on the free plan): used the same way
    # after the 5-hour and 7-day ones, from no further back than 7 days.
    others = sorted((k for k in windows if k.startswith('window_')),
                    key=lambda k: windows[k].get('minutes') or 0)
    for key in ('five_hour', 'seven_day', *others):
        win = windows.get(key)
        if not win or win.get('start') is None:
            continue
        used = win.get('used_percentage')
        if win.get('exhausted') or (used is not None and used >= threshold):
            start = win['start'] if key in ('five_hour', 'seven_day') else max(win['start'], floor)
            return {'rule': key, 'start': start, 'end': now, 'used_percentage': used,
                    'exhausted': bool(win.get('exhausted'))}
    day = now - MIN_LOOKBACK_HOURS * 3600
    start = floor
    total = 0.0
    reached = False
    for c in sorted((c for c in calls if c['ts'] is not None and floor <= c['ts'] <= now),
                    key=lambda c: -c['ts']):
        total += normalize.w_of(c)
        start = c['ts']
        if total >= budget:
            reached = True
            break
    # `basis` says what set the start: the budget, the one-day minimum (heavy parallel use
    # can reach the budget within minutes), or the 7-day maximum (the budget not reached).
    if not reached:
        start, basis = floor, 'max_week'
    elif start > day:
        start, basis = day, 'min_day'
    else:
        basis = 'budget'
    return {'rule': 'budget', 'start': start, 'end': now, 'used_percentage': None,
            'exhausted': False, 'budget': budget, 'basis': basis}


# ---- Reading ----------------------------------------------------------------------

def read_sessions(projects_dir: str, now: float, oldest: float, max_sessions: int,
                  reader: cache.Reader) -> Tuple[List[dict], dict]:
    """Claude Code's sessions last written at or after `oldest`, newest first, within the limits
    (D-18)."""
    return sources.ClaudeSource(projects_dir, '', '').read(now, oldest, max_sessions, reader)


# ---- Output -----------------------------------------------------------------------

def _totals(calls: List[dict], preambles: List[int]) -> dict:
    """Token totals. `usd` sums the calls with a known cost (`None` when none has one);
    `unpriced_calls` counts the others."""
    t = {'calls': len(calls), 'uncached_in': 0, 'cache_read': 0, 'cache_write': 0,
         'cache_write_1h': 0, 'output': 0, 'reasoning': 0, 'w': 0.0, 'usd': 0.0,
         'unpriced_calls': 0}
    priced = 0
    for c in calls:
        t['uncached_in'] += c['in']
        t['cache_read'] += c['cr']
        t['cache_write'] += c['cw']
        t['cache_write_1h'] += c['cw1h']
        t['output'] += c['out']
        t['reasoning'] += c.get('th', 0)
        t['w'] += normalize.w_of(c)
        usd = impact.call_usd(c)
        if usd is None:
            t['unpriced_calls'] += 1
        else:
            t['usd'] += usd
            priced += 1
    seen = t['uncached_in'] + t['cache_read'] + t['cache_write']
    t['w'] = round(t['w'])
    t['usd'] = round(t['usd'], 4) if priced or not calls else None
    t['cache_hit'] = round(t['cache_read'] / seen, 3) if seen else None
    t['preamble_median'] = round(statistics.median(preambles)) if preambles else None
    return t


def _usd(calls: List[dict]) -> Optional[float]:
    values = [impact.call_usd(c) for c in calls]
    known = [v for v in values if v is not None]
    return round(sum(known), 4) if known or not values else None


def _task_out(t: dict) -> dict:
    keys = ('id', 'session', 'provider', 'first_ts', 'last_ts', 'turns', 'calls', 'all_calls', 'w',
            'start_ctx', 'end_ctx', 'reads', 'writes', 'corrections', 'reverts', 'max_rewrites',
            'interrupts', 'compactions', 'calls_ratio', 'first_ratio', 'first_mentions_file',
            'first_look_share', 'first_look_targets', 'subagents', 'team')
    return {k: t[k] for k in keys}


def _hit_out(h: dict, mask: excerpt.Masker) -> dict:
    out = detect.public(h)
    out['shown_targets'] = [mask.path(p) for p in h['targets']]
    if h.get('read_path'):
        out['metrics'] = dict(out['metrics'], shown_path=mask.path(h['read_path']))
    return out


def build(now: float, projects_dir: str, status_dir: str, stats_cache_path: str,
          vault: Optional[str] = None, threshold: float = DEFAULT_THRESHOLD,
          budget: float = DEFAULT_BUDGET, explicit: Optional[Tuple[float, float]] = None,
          max_sessions: int = DEFAULT_MAX_SESSIONS, with_excerpts: bool = True,
          names: Optional[Dict[str, str]] = None, home: Optional[str] = None,
          cache_folder: Optional[str] = None) -> dict:
    """The `agents.claude` block of `json efficiency` (D-8)."""
    src = sources.ClaudeSource(projects_dir, status_dir, stats_cache_path)
    return build_for(now, src, vault=vault, threshold=threshold, budget=budget, explicit=explicit,
                     max_sessions=max_sessions, with_excerpts=with_excerpts, names=names, home=home,
                     cache_folder=cache_folder)


def build_for(now: float, src, vault: Optional[str] = None, threshold: float = DEFAULT_THRESHOLD,
              budget: float = DEFAULT_BUDGET, explicit: Optional[Tuple[float, float]] = None,
              max_sessions: int = DEFAULT_MAX_SESSIONS, with_excerpts: bool = True,
              names: Optional[Dict[str, str]] = None, home: Optional[str] = None,
              cache_folder: Optional[str] = None) -> dict:
    """The `agents.<agent>` block of `json efficiency` (D-8) for the sessions of `src`."""
    folder = cache_folder or cache.cache_dir(src.agent)
    reader = cache.Reader(now, folder=folder)
    window_start = now - tasks.WINDOW_DAYS * DAY
    oldest = min(window_start, explicit[0]) if explicit else window_start
    try:
        sessions, limits = src.read(now, oldest, max_sessions, reader)
        src.prune(folder)
        return _block(now, src, sessions, limits, reader, vault, threshold, budget, explicit,
                      with_excerpts, names or {}, home)
    finally:
        src.close()


def _block(now, src, sessions, limits, reader, vault, threshold, budget, explicit,
           with_excerpts, names, home) -> dict:
    turns_by = {s['id']: tasks.turns_of(s) for s in sessions}
    base = tasks.baselines(sessions, now, turns_by_session=turns_by)
    all_calls = [c for s in sessions for c in s['calls']]

    if explicit:
        rng_info = {'rule': 'explicit', 'start': explicit[0], 'end': explicit[1],
                    'used_percentage': None, 'exhausted': False}
        windows = {}
    else:
        windows = src.windows(now)
        rng_info = choose_range(now, windows, all_calls, threshold, budget)
    rng_info['windows'] = {k: {'used_percentage': w.get('used_percentage'), 'end': w.get('end'),
                               'exhausted': bool(w.get('exhausted'))} for k, w in windows.items()}
    rng = (rng_info['start'], rng_info['end'])

    analysed = []
    for s in sessions:
        task_list = tasks.session_tasks(s, base, rng, turns=turns_by[s['id']], everything=True)
        if any(t['in_range'] for t in task_list):
            analysed.append({'session': s, 'tasks': task_list})
    hits, collisions = detect.run(analysed, base, rng)

    mask = excerpt.Masker(home=home, vault=vault)
    ranged = [c for a in analysed for c in a['session']['calls'] if tasks.in_range(c['ts'], rng)]
    preambles = [next(c['ctx'] for c in a['session']['calls'] if c['chain'] == 'main')
                 for a in analysed if any(c['chain'] == 'main' for c in a['session']['calls'])]
    totals = _totals(ranged, preambles)

    sessions_out = []
    for a in analysed:
        s = a['session']
        mine = [c for c in s['calls'] if tasks.in_range(c['ts'], rng)]
        sessions_out.append({
            'id': s['id'], 'name': names.get(s['id']), 'cwd': s['cwd'], 'folder': mask.folder(s['cwd']),
            'version': s['version'], 'provider': sources.provider_of(s), 'child': False,
            'team': s['team'], 'calls': len(mine),
            'w': round(sum(normalize.w_of(c) for c in mine)), 'usd': _usd(mine)})
    sessions_out.sort(key=lambda x: -x['w'])

    task_rows = sorted((t for a in analysed for t in a['tasks'] if t['in_range']),
                       key=lambda t: (-t['w'], t['id']))
    limits.update(collisions=collisions, disabled=list(base['disabled']),
                  sessions_read=len(sessions), parsed_bytes=reader.parsed_bytes,
                  cache_hits=reader.hits)
    block = {
        'range': rng_info,
        'totals': totals,
        'providers': _providers(analysed, rng, src),
        'sessions': sessions_out,
        'breakdown': impact.breakdown(ranged, hits),
        'tasks': [_task_out(t) for t in task_rows[:MAX_TASKS_OUT]],
        'hits': [_hit_out(h, mask) for h in hits[:MAX_HITS_OUT]],
        'excerpts': [],
        'baselines': base,
        'limits': limits,
    }
    panes = []
    for prov in block['providers']:
        provider = prov['provider']
        mine = [a for a in analysed if sources.provider_of(a['session']) == provider]
        ids = {a['session']['id'] for a in mine}
        part = dict(block, sessions=[x for x in block['sessions'] if x['id'] in ids],
                    tasks=[x for x in block['tasks'] if x['session'] in ids],
                    hits=[x for x in block['hits'] if x['session'] in ids], excerpts=[])
        part['totals'] = _totals([c for a in mine for c in a['session']['calls'] if tasks.in_range(c['ts'], rng)],
                                 [p for a, p in zip(analysed, preambles) if a in mine])
        part['breakdown'] = impact.breakdown(
            [c for a in mine for c in a['session']['calls'] if tasks.in_range(c['ts'], rng)],
            [h for h in hits if h['session'] in ids])
        if with_excerpts:
            # The summary and the excerpts are sent together: both fit in `excerpt.LIMIT`.
            room = excerpt.LIMIT - excerpt.size([summary(part, mine, mask, names, src.agent)]) - SUMMARY_SLACK
            items = excerpt.build(mine, [h for h in hits if h['session'] in ids], mask,
                                  limit=max(room, 0), texts=src.texts)
            part['excerpts'] = items
            while items and sent_size(summary(part, mine, mask, names, src.agent), items) > excerpt.LIMIT:
                items.pop(min(range(len(items)), key=lambda i: (items[i]['impact_w'], i)))
        panes.append({
            'key': src.agent if src.agent == 'claude' else '%s-%s' % (src.agent, provider),
            'agent': src.agent, 'provider': provider, 'model': prov['analysis_model'],
            'local': prov['local'], 'sessions': len(part['sessions']), 'w': part['totals']['w'],
            'totals': part['totals'], 'breakdown': part['breakdown'],
            'hits': [h['id'] for h in part['hits']],
            'summary': summary(part, mine, mask, names, src.agent), 'excerpts': part['excerpts'],
        })
    block['panes'] = panes
    if panes:
        block['excerpts'] = panes[0]['excerpts']
        block['summary'] = panes[0]['summary']
    else:
        block['summary'] = summary(block, analysed, mask, names, src.agent)
    return block


def _providers(analysed: List[dict], rng: Tuple[float, float], src) -> List[dict]:
    """Providers of the range's sessions, largest first: their models (calls each), whether they
    run on this machine, and the model an analysis of their conversations would use."""
    out: Dict[str, dict] = {}
    for a in analysed:
        s = a['session']
        provider = sources.provider_of(s)
        entry = out.setdefault(provider, {'provider': provider, 'models': {}, 'local': src.is_local(provider),
                                          'w': 0.0, '_calls': []})
        for c in s['calls']:
            if not tasks.in_range(c['ts'], rng):
                continue
            entry['w'] += normalize.w_of(c)
            entry['_calls'].append(c)
            if c.get('model'):
                entry['models'][c['model']] = entry['models'].get(c['model'], 0) + 1
    rows = []
    for entry in sorted(out.values(), key=lambda e: (-e['w'], e['provider'])):
        calls = [c for c in entry.pop('_calls') if c.get('provider', entry['provider']) == entry['provider']
                 or src.agent == 'claude']
        entry['analysis_model'] = src.analysis_model(entry['provider'], calls)
        entry['w'] = round(entry['w'])
        rows.append(entry)
    return rows


def sent_size(summary_: dict, excerpts: List[dict]) -> int:
    """Characters of what the plugin sends: the summary and the excerpts, as JSON."""
    return excerpt.size([summary_]) + excerpt.size(excerpts)


def summary(block: dict, analysed: List[dict], mask: excerpt.Masker, names: Dict[str, str],
            agent: str = 'claude') -> dict:
    """What is sent to the model besides the excerpts (D-9, items 1 and 3): numbers, ids,
    masked session names and folders, instruction file sizes and the skill count."""
    hits = block['hits'][:SUMMARY_HITS]
    tasks_ = block['tasks'][:SUMMARY_TASKS]
    wanted = {h['session'] for h in hits} | {t['session'] for t in tasks_} \
        | {e['session'] for e in block['excerpts']}
    sessions = [{'id': s['id'], 'name': mask(s['name']) if s['name'] else None, 'folder': s['folder']}
                for s in block['sessions'] if s['id'] in wanted]
    instr: Dict[str, dict] = {}
    skills = []
    for a in analysed:
        s = a['session']
        if s['id'] not in wanted:
            continue
        pre = s['main'].get('preamble', {})
        if pre.get('skills') is not None:
            skills.append(pre['skills'])
        for f in pre.get('instr', []):
            shown = mask.path(normalize.abs_path(f.get('p'), s['cwd']))
            instr[shown] = {'file': shown, 'type': f.get('type'), 'bytes': f['bytes'], 'lines': f['lines']}
    rng = {k: v for k, v in block['range'].items() if k != 'windows'}
    return {
        'agent': agent, 'range': rng, 'totals': block['totals'], 'breakdown': block['breakdown'],
        'baselines': {k: block['baselines'][k] for k in ('L_med', 'L1_med', 'C_med', 'disabled')},
        'tasks': tasks_,
        'hits': [{'id': h['id'], 'detector': h['detector'], 'session': h['session'], 'task': h['task'],
                  'metrics': h['metrics'], 'impact_w': h['impact_w'], 'confidence': h['confidence'],
                  'needs_llm': h['needs_llm'], 'remedy_kind': h['remedy_kind'], 'change': h['change'],
                  'targets': h['shown_targets']} for h in hits],
        'sessions': sessions,
        'instructions': sorted(instr.values(), key=lambda x: x['file']),
        'skills': max(skills) if skills else None,
    }

"""`json efficiency` for one agent (Claude Code in this stage): sessions -> range -> tasks ->
hits -> the output block of D-8.

The range is fixed once per run (D-3), statistics and excerpts come from the same read, and
nothing here carries display text: the plugin chooses the words in the UI language.
"""

import os
import statistics
from typing import Dict, List, Optional, Tuple

from ..usage import stats as usage_stats
from . import cache, detect, excerpt, impact, normalize, tasks

DAY = 86400.0
MAX_LOOKBACK_DAYS = 7
MIN_LOOKBACK_HOURS = 24
DEFAULT_THRESHOLD = 80.0
DEFAULT_BUDGET = 10_000_000
DEFAULT_MAX_SESSIONS = 200
MAX_PARSE_BYTES = 2 << 30
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
    for key in ('five_hour', 'seven_day'):
        win = windows.get(key)
        if not win:
            continue
        used = win.get('used_percentage')
        if win.get('exhausted') or (used is not None and used >= threshold):
            return {'rule': key, 'start': win['start'], 'end': now, 'used_percentage': used,
                    'exhausted': bool(win.get('exhausted'))}
    floor = now - MAX_LOOKBACK_DAYS * DAY
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
    """Sessions last written at or after `oldest`, newest first, within the limits (D-18)."""
    limits = {'truncated': False, 'reason': None}
    out = []
    from ..sessions import activity
    for path, sid, _mtime in cache.list_sessions(projects_dir, oldest):
        if len(out) >= max_sessions:
            limits.update(truncated=True, reason='max_sessions')
            break
        if reader.parsed_bytes > MAX_PARSE_BYTES:
            limits.update(truncated=True, reason='max_bytes')
            break
        main = reader.record(path, session=sid)
        if main is None:
            continue
        # A sub-agent transcript last written before the window can't hold a call in it.
        subs = [r for r in (reader.record(p, session=sid) for p in activity.subagent_files(path)
                            if _file_mtime(p) >= oldest) if r]
        out.append(tasks.assemble(main, subs))
    return out, limits


def _file_mtime(path: str) -> float:
    try:
        return os.stat(path).st_mtime
    except OSError:
        return 0.0


# ---- Output -----------------------------------------------------------------------

def _totals(calls: List[dict], preambles: List[int]) -> dict:
    t = {'calls': len(calls), 'uncached_in': 0, 'cache_read': 0, 'cache_write': 0,
         'cache_write_1h': 0, 'output': 0, 'reasoning': 0, 'w': 0.0, 'usd': 0.0,
         'unpriced_calls': 0}
    for c in calls:
        t['uncached_in'] += c['in']
        t['cache_read'] += c['cr']
        t['cache_write'] += c['cw']
        t['cache_write_1h'] += c['cw1h']
        t['output'] += c['out']
        t['reasoning'] += c.get('th', 0)
        t['w'] += normalize.w_of(c)
        t['usd'] += impact.call_usd(c)
    seen = t['uncached_in'] + t['cache_read'] + t['cache_write']
    t['w'] = round(t['w'])
    t['usd'] = round(t['usd'], 4)
    t['cache_hit'] = round(t['cache_read'] / seen, 3) if seen else None
    t['preamble_median'] = round(statistics.median(preambles)) if preambles else None
    return t


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
    reader = cache.Reader(now, folder=cache_folder)
    window_start = now - tasks.WINDOW_DAYS * DAY
    oldest = min(window_start, explicit[0]) if explicit else window_start
    sessions, limits = read_sessions(projects_dir, now, oldest, max_sessions, reader)
    cache.prune(cache.all_transcripts(projects_dir), folder=cache_folder)

    turns_by = {s['id']: tasks.turns_of(s) for s in sessions}
    base = tasks.baselines(sessions, now, turns_by_session=turns_by)
    all_calls = [c for s in sessions for c in s['calls']]

    if explicit:
        rng_info = {'rule': 'explicit', 'start': explicit[0], 'end': explicit[1],
                    'used_percentage': None, 'exhausted': False}
        windows = {}
    else:
        windows = usage_stats.compute(now=now, projects_dir=projects_dir, status_dir=status_dir,
                                      cache_path=stats_cache_path)['windows']
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

    models: Dict[str, int] = {}
    for c in ranged:
        if c.get('model'):
            models[c['model']] = models.get(c['model'], 0) + 1
    names = names or {}
    sessions_out = []
    for a in analysed:
        s = a['session']
        mine = [c for c in s['calls'] if tasks.in_range(c['ts'], rng)]
        sessions_out.append({
            'id': s['id'], 'name': names.get(s['id']), 'cwd': s['cwd'], 'folder': mask.folder(s['cwd']),
            'version': s['version'], 'child': False, 'team': s['team'], 'calls': len(mine),
            'w': round(sum(normalize.w_of(c) for c in mine)),
            'usd': round(sum(impact.call_usd(c) for c in mine), 4)})
    sessions_out.sort(key=lambda x: -x['w'])

    task_rows = sorted((t for a in analysed for t in a['tasks'] if t['in_range']),
                       key=lambda t: (-t['w'], t['id']))
    limits.update(collisions=collisions, disabled=list(base['disabled']),
                  sessions_read=len(sessions), parsed_bytes=reader.parsed_bytes,
                  cache_hits=reader.hits)
    block = {
        'range': rng_info,
        'totals': totals,
        'providers': [{'provider': 'anthropic', 'models': models, 'local': False, 'w': totals['w']}],
        'sessions': sessions_out,
        'breakdown': impact.breakdown(ranged, hits),
        'tasks': [_task_out(t) for t in task_rows[:MAX_TASKS_OUT]],
        'hits': [_hit_out(h, mask) for h in hits[:MAX_HITS_OUT]],
        'excerpts': [],
        'baselines': base,
        'limits': limits,
    }
    if with_excerpts:
        # The summary and the excerpts are sent together: both fit in `excerpt.LIMIT`.
        room = excerpt.LIMIT - excerpt.size([summary(block, analysed, mask, names)]) - SUMMARY_SLACK
        items = excerpt.build(analysed, hits, mask, limit=max(room, 0))
        block['excerpts'] = items
        while items and sent_size(summary(block, analysed, mask, names), items) > excerpt.LIMIT:
            items.pop(min(range(len(items)), key=lambda i: (items[i]['impact_w'], i)))
    block['summary'] = summary(block, analysed, mask, names)
    return block


def sent_size(summary_: dict, excerpts: List[dict]) -> int:
    """Characters of what the plugin sends: the summary and the excerpts, as JSON."""
    return excerpt.size([summary_]) + excerpt.size(excerpts)


def summary(block: dict, analysed: List[dict], mask: excerpt.Masker, names: Dict[str, str]) -> dict:
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
        'agent': 'claude', 'range': rng, 'totals': block['totals'], 'breakdown': block['breakdown'],
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

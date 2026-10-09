"""Scheduled work in a Claude Code session, folded from its transcript.

Claude Code keeps `CronCreate` jobs and `ScheduleWakeup` wakeups in memory only, so the only
trace is in the transcript: the tool calls that created and deleted them, and the
`scheduled_task_fire` records written when one fires. `fold` reads the transcript forward from a
byte offset and keeps a small JSON-serializable state (stored in the scan cache), so a growing
transcript is only read once. `summarize` turns that state into the `schedule` dict that
`json scan` reports, applying the expiry rules at the time of the call.

Whether the session's process is alive is not decided here; the plugin only shows a schedule for a
running session.
"""
import json
import os
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Set

from .scan import _iso_ts

RECURRING_TTL = 7 * 86400        # recurring jobs expire (after one last fire) seven days after creation
EXPIRY_MARGIN = 3600             # extra time before a recurring job is treated as gone
WAKEUP_GRACE = 1800              # a wakeup this long past its time without a fire is treated as gone
MAX_JOBS_LISTED = 5
MAX_PENDING = 50
_LOOKAHEAD_MINUTES = 8 * 24 * 60

_MARKS = (b'CronCreate', b'CronDelete', b'CronList', b'ScheduleWakeup', b'scheduled_task_fire',
          b'scheduledTaskId', b'turnOrigin')


def new_state() -> dict:
    return {
        'offset': 0,
        'jobs': {},          # id -> {cron, recurring, created, human}
        'pending': {},       # tool_use_id -> {kind, cron, recurring, ts}
        'wakeup': None,      # epoch seconds of the pending wakeup
        'scheduled_turn': False,   # the latest turn was started by a schedule, with no human input since
        'last_fire': None,   # epoch seconds
    }


def _blocks(rec: dict) -> list:
    content = (rec.get('message') or {}).get('content')
    return content if isinstance(content, list) else []


def _is_tool_result(rec: dict) -> bool:
    return any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in _blocks(rec))


def _fold_assistant(state: dict, rec: dict) -> None:
    ts = _iso_ts(rec.get('timestamp'))
    for b in _blocks(rec):
        if not isinstance(b, dict) or b.get('type') != 'tool_use':
            continue
        name, inp, tid = b.get('name'), b.get('input') or {}, b.get('id')
        if not isinstance(inp, dict):
            continue
        if name == 'CronCreate' and tid:
            state['pending'][tid] = {'kind': 'create', 'cron': inp.get('cron') or '',
                                     'recurring': inp.get('recurring') is not False, 'ts': ts}
        elif name == 'CronDelete':
            state['jobs'].pop(str(inp.get('id') or ''), None)
        elif name == 'CronList' and tid:
            state['pending'][tid] = {'kind': 'list'}
        elif name == 'ScheduleWakeup':
            if inp.get('stop'):
                state['wakeup'] = None
            elif tid:
                state['pending'][tid] = {'kind': 'wakeup'}


def _fold_result(state: dict, rec: dict) -> None:
    result = rec.get('toolUseResult')
    if not isinstance(result, dict):
        return
    for b in _blocks(rec):
        if not isinstance(b, dict) or b.get('type') != 'tool_result' or b.get('is_error'):
            continue
        p = state['pending'].pop(b.get('tool_use_id'), None)
        if not p:
            continue
        if p['kind'] == 'create' and result.get('id'):
            state['jobs'][str(result['id'])] = {
                'cron': p['cron'], 'recurring': p['recurring'],
                'created': p['ts'] or _iso_ts(rec.get('timestamp')) or 0,
                'human': result.get('humanSchedule') or ''}
        elif p['kind'] == 'wakeup':
            if result.get('stopped'):
                state['wakeup'] = None
            elif isinstance(result.get('scheduledFor'), (int, float)):
                state['wakeup'] = result['scheduledFor'] / 1000.0
        elif p['kind'] == 'list' and isinstance(result.get('jobs'), list):
            # A CronList result is the live set at that moment; it overrides the fold.
            ts = _iso_ts(rec.get('timestamp')) or 0
            listed: Dict[str, dict] = {}
            for j in result['jobs']:
                if isinstance(j, dict) and j.get('id'):
                    jid = str(j['id'])
                    old = state['jobs'].get(jid) or {}
                    listed[jid] = {'cron': j.get('cron') or old.get('cron', ''),
                                   'recurring': j.get('recurring') is not False,
                                   'created': old.get('created') or ts,
                                   'human': j.get('humanSchedule') or old.get('human', '')}
            state['jobs'] = listed


def _fold_fire(state: dict, rec: dict) -> None:
    ts = _iso_ts(rec.get('timestamp'))
    if ts is not None:
        state['last_fire'] = ts
    job = state['jobs'].get(str(rec.get('taskId') or ''))
    if job is not None and not job['recurring']:
        del state['jobs'][str(rec['taskId'])]
    if rec.get('cronKind') == 'loop' or rec.get('taskKind') == 'loop':
        state['wakeup'] = None


def _fold_user(state: dict, rec: dict) -> None:
    """Tracks whether the latest turn was started by a schedule. Tool results continue a turn,
    and peer, task-notification and other machine turns say nothing about who started the
    session's activity, so only a scheduled or a human start moves the flag."""
    if rec.get('scheduledTaskId') or rec.get('turnOrigin') == 'scheduled':
        state['scheduled_turn'] = True
    elif rec.get('turnOrigin') == 'human':
        state['scheduled_turn'] = False
    elif 'turnOrigin' not in rec and not rec.get('isMeta') and not rec.get('isCompactSummary') \
            and not _is_tool_result(rec):
        content = (rec.get('message') or {}).get('content')
        text = content if isinstance(content, str) else ''.join(
            b.get('text', '') for b in _blocks(rec) if isinstance(b, dict) and b.get('type') == 'text')
        if text.strip() and not text.lstrip().startswith('<'):
            state['scheduled_turn'] = False


def fold(path: str, state: Optional[dict] = None) -> dict:
    """Reads `path` from `state['offset']` and folds it into `state` (a fresh one if None, or if
    the file is now shorter than the offset). Only complete lines are consumed."""
    if state is None or state.get('offset', 0) > os.path.getsize(path):
        state = new_state()
    with open(path, 'rb') as f:
        f.seek(state['offset'])
        data = f.read()
    end = data.rfind(b'\n') + 1
    for line in data[:end].split(b'\n'):
        user = b'"type":"user"' in line
        if not (user or b'"type":"assistant"' in line or b'scheduled_task_fire' in line):
            continue
        if user and b'tool_use_id' in line and not state['pending']:
            continue    # a tool result with nothing awaiting it
        if not user and not any(m in line for m in _MARKS):
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict) or rec.get('isSidechain'):
            continue
        kind = rec.get('type')
        if kind == 'assistant':
            _fold_assistant(state, rec)
        elif kind == 'system' and rec.get('subtype') == 'scheduled_task_fire':
            _fold_fire(state, rec)
        elif kind == 'user':
            _fold_result(state, rec)
            if not _is_tool_result(rec):
                _fold_user(state, rec)
    state['offset'] += end
    if len(state['pending']) > MAX_PENDING:    # calls that never got a result (interrupted)
        for k in list(state['pending'])[:-MAX_PENDING]:
            del state['pending'][k]
    return state


# ---- Cron arithmetic -----------------------------------------------------------------

def _field(spec: str, lo: int, hi: int) -> Optional[Set[int]]:
    out: Set[int] = set()
    for part in spec.split(','):
        step = 1
        if '/' in part:
            part, s = part.split('/', 1)
            if not s.isdigit() or int(s) < 1:
                return None
            step = int(s)
        if part in ('*', ''):
            a, b = lo, hi
        elif '-' in part:
            x, y = part.split('-', 1)
            if not (x.isdigit() and y.isdigit()):
                return None
            a, b = int(x), int(y)
        elif part.isdigit():
            a = int(part)
            b = hi if step > 1 else a
        else:
            return None
        if a < lo or b > hi or a > b:
            return None
        out.update(range(a, b + 1, step))
    return out


def next_cron_fire(expr: str, after: float) -> Optional[float]:
    """The next local-time minute after `after` that matches the five-field cron `expr`, within
    eight days; None if it can't be parsed or doesn't come up."""
    parts = expr.split()
    if len(parts) != 5:
        return None
    ranges = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]
    sets = [_field(p, lo, hi) for p, (lo, hi) in zip(parts, ranges)]
    if any(s is None for s in sets):
        return None
    minute, hour, dom, month, dow = sets
    dow = {d % 7 for d in dow}
    dom_star, dow_star = parts[2].startswith('*'), parts[4].startswith('*')
    t = datetime.fromtimestamp(after).replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(_LOOKAHEAD_MINUTES):
        if t.minute in minute and t.hour in hour and t.month in month:
            wd = (t.weekday() + 1) % 7
            if dom_star and dow_star:
                day_ok = True
            elif dom_star:
                day_ok = wd in dow
            elif dow_star:
                day_ok = t.day in dom
            else:
                day_ok = t.day in dom or wd in dow
            if day_ok:
                return t.timestamp()
        t += timedelta(minutes=1)
    return None


# ---- Output ---------------------------------------------------------------------------

def summarize(state: Optional[dict], now: Optional[float] = None) -> Optional[dict]:
    """The `schedule` reported by `json scan`, or None when nothing is scheduled:
    `{jobs: [{cron, recurring, human, next}], wakeup: epoch|None, next: epoch|None}`.
    Recurring jobs past their seven days (plus a margin) and a long-overdue wakeup are dropped."""
    if not state:
        return None
    now = time.time() if now is None else now
    jobs: List[dict] = []
    for j in state['jobs'].values():
        if j['recurring'] and j['created'] and now > j['created'] + RECURRING_TTL + EXPIRY_MARGIN:
            continue
        jobs.append({'cron': j['cron'], 'recurring': j['recurring'], 'human': j['human'],
                     'next': next_cron_fire(j['cron'], now)})
    wakeup = state.get('wakeup')
    if wakeup is not None and now > wakeup + WAKEUP_GRACE:
        wakeup = None
    if not jobs and wakeup is None:
        return None
    nexts = [j['next'] for j in jobs if j['next'] is not None]
    if wakeup is not None:
        nexts.append(wakeup)
    return {'jobs': jobs[:MAX_JOBS_LISTED], 'job_count': len(jobs), 'wakeup': wakeup,
            'next': min(nexts) if nexts else None}

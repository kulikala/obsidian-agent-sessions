"""Per-turn token accounting for an OpenCode session -- the opencode analogue of
`agentsessions.usage.turns`, in the same shape `agents.codex.usage` emits.

A turn starts at each user message; every assistant message after it is one
call. OpenCode records `tokens` (`input`, `output`, `reasoning`,
`cache.read`, `cache.write`) and a `cost` on each assistant message itself, so
this sums them as stored -- no price table (an assistant message without a
numeric `cost` makes its turn's cost `null`, "unknown", as with Codex). A
missing `cache.write` counts as `0`. Assistant messages before the first user
message (rare) roll into a `before_first` turn.
"""
from typing import Dict, List, Optional

from ...sessions.detail import clean_text
from ...usage.turns import summarize as _summarize
from . import db as _db

PROMPT_HEAD_LEN = 60


def _int(v) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) else 0


def _new_turn(ts: Optional[float], prompt: str, before_first: bool = False) -> dict:
    return {'index': -1, 'ts': ts, 'prompt': prompt, 'calls': 0, 'input': 0, 'cache_create': 0,
            'cache_read': 0, 'output': 0, 'thinking': 0, 'cost': 0.0, 'tools': {},
            'estimated': False, 'unknown_cost': False, 'last_ts': None, 'context_last': 0,
            'models': {}, 'before_first': before_first}


def collect(session_id: str, path: Optional[str] = None) -> List[dict]:
    d = _db.open_db(path)
    if d is None:
        return []
    try:
        msgs = d.query('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id',
                       (session_id,))
        texts: Dict[str, list] = {}
        tools: Dict[str, Dict[str, int]] = {}
        for r in d.query('SELECT p.message_id, p.data FROM part p WHERE p.session_id = ? AND (%s OR %s) '
                         'ORDER BY p.id' % (d.part_is('text'), d.part_is('tool')), (session_id,)):
            pd = _db.loads(r['data'])
            if pd.get('type') == 'tool':
                name = pd.get('tool')
                if isinstance(name, str) and name:
                    counts = tools.setdefault(r['message_id'], {})
                    counts[name] = counts.get(name, 0) + 1
            else:
                texts.setdefault(r['message_id'], []).append(r)
    finally:
        d.close()

    turns: List[dict] = []
    before: Optional[dict] = None
    current: Optional[dict] = None
    for r in msgs:
        data = _db.loads(r['data'])
        created = (data.get('time') or {}).get('created')
        ts = created / 1000.0 if isinstance(created, (int, float)) else None
        role = data.get('role')
        if role == 'user':
            prompt = _db.text_of_parts(texts.get(r['id'], []))
            current = _new_turn(ts, clean_text(prompt).strip()[:PROMPT_HEAD_LEN] if prompt else '')
            turns.append(current)
            continue
        if role != 'assistant':
            continue
        target = current
        if target is None:
            if before is None:
                before = _new_turn(None, '', before_first=True)
            target = before
        tokens = data.get('tokens') if isinstance(data.get('tokens'), dict) else {}
        cache = tokens.get('cache') if isinstance(tokens.get('cache'), dict) else {}
        target['calls'] += 1
        target['input'] += _int(tokens.get('input'))
        target['output'] += _int(tokens.get('output'))
        target['thinking'] += _int(tokens.get('reasoning'))
        target['cache_read'] += _int(cache.get('read'))
        target['cache_create'] += _int(cache.get('write'))
        target['context_last'] = _int(tokens.get('input')) + _int(cache.get('read')) + _int(cache.get('write'))
        cost = data.get('cost')
        if isinstance(cost, (int, float)) and not isinstance(cost, bool):
            target['cost'] += float(cost)
        else:
            target['unknown_cost'] = True
        model = _db.model_of_message(data)
        if model:
            target['models'][model] = target['models'].get(model, 0) + 1
        for name, n in tools.get(r['id'], {}).items():
            target['tools'][name] = target['tools'].get(name, 0) + n
        done = (data.get('time') or {}).get('completed')
        end = done if isinstance(done, (int, float)) else created
        if isinstance(end, (int, float)):
            end = end / 1000.0
            if target['last_ts'] is None or end > target['last_ts']:
                target['last_ts'] = end

    ordered = ([before] if before is not None else []) + turns
    for i, t in enumerate(ordered):
        t['index'] = i
        if t['unknown_cost']:
            t['cost'] = None
    return ordered


def collect_for(path: str) -> List[dict]:
    sid = _db.session_id_of(path)
    return collect(sid) if sid else []


def summarize(turns: List[dict], from_ts: Optional[float] = None,
              to_ts: Optional[float] = None) -> dict:
    """Same contract as `agents.codex.usage.summarize` (`total['unknown_cost']`
    is true when any included turn's cost is `null`)."""
    def _in_range(t: dict) -> bool:
        ts = t.get('ts')
        if from_ts is not None and (ts is None or ts < from_ts):
            return False
        if to_ts is not None and (ts is None or ts > to_ts):
            return False
        return True

    sanitized = [dict(t, cost=(t.get('cost') or 0.0)) for t in turns]
    result = _summarize(sanitized, from_ts=from_ts, to_ts=to_ts)
    result['total']['unknown_cost'] = any(t.get('unknown_cost') and _in_range(t) for t in turns)
    result['turns'] = turns
    return result

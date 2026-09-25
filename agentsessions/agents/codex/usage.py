"""Per-turn token accounting for a Codex rollout -- the codex analogue of
`agentsessions.usage.turns`.

Codex's `token_count` event (`event_msg.payload.type == 'token_count'`) carries a
*running total* (`info.total_token_usage`), not a per-call delta the way Claude's
`message.usage` is; this module diffs successive totals to recover per-call deltas,
then buckets them into turns the same way `usage.turns.collect` does: split on each
human-authored prompt, with any usage seen before the first prompt rolled into a
single `before_first` turn.

Shape mirrors `usage.turns.Turn.to_dict()` field-for-field, so the plugin's usage
panel can render either agent without special-casing every field, with one
deliberate addition: `cost` is `null` (not `0`) when the turn used a model
`agentsessions.usage.pricing.OPENAI_PRICES` doesn't recognize (see that module's
docstring for why Codex doesn't get a same-vendor cost estimate the way Claude
does) -- a consumer must treat `cost: null` as "unknown", not "free". `cache_create`
is always `0`: Codex's own accounting has `cache_write_input_tokens`, which this
module *does* fold into `cache_create` when present, but there's no 5-minute/1-hour
tiering the way Claude has (`agentsessions.usage.pricing.price_of` prices Codex's
`cache_5m`/`cache_1h` identically for exactly this reason).
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from ...sessions.detail import clean_text
from ...usage import pricing
from ...usage.turns import summarize as _summarize
from . import rollout

PROMPT_HEAD_LEN = 60


@dataclass
class _Turn:
    index: int
    ts: Optional[float]
    prompt: str
    calls: int = 0
    input: int = 0
    cache_create: int = 0
    cache_read: int = 0
    output: int = 0
    thinking: int = 0
    cost: Optional[float] = 0.0
    tools: Dict[str, int] = field(default_factory=dict)
    estimated: bool = False
    unknown_cost: bool = False
    last_ts: Optional[float] = None
    context_last: int = 0
    models: Dict[str, int] = field(default_factory=dict)
    before_first: bool = False

    def to_dict(self) -> dict:
        return {
            'index': self.index, 'ts': self.ts, 'prompt': self.prompt,
            'calls': self.calls, 'input': self.input, 'cache_create': self.cache_create,
            'cache_read': self.cache_read, 'output': self.output, 'thinking': self.thinking,
            'cost': None if self.unknown_cost else self.cost,
            'tools': dict(self.tools), 'estimated': self.estimated,
            'unknown_cost': self.unknown_cost,
            'last_ts': self.last_ts, 'context_last': self.context_last,
            'models': dict(self.models), 'before_first': self.before_first,
        }


def collect(path: str) -> List[dict]:
    """Read the rollout at `path` from the start and collect per-turn usage."""
    turns: List[_Turn] = []
    before: Optional[_Turn] = None
    current: Optional[_Turn] = None
    current_model: Optional[str] = None
    prev_total = {'input_tokens': 0, 'cached_input_tokens': 0,
                  'cache_write_input_tokens': 0, 'output_tokens': 0,
                  'reasoning_output_tokens': 0}

    for rec in rollout.iter_records(path):
        t = rec.get('type')

        if t == 'turn_context':
            payload = rec.get('payload') or {}
            model = payload.get('model')
            if isinstance(model, str) and model:
                current_model = model
            continue

        if t == 'response_item':
            payload = rec.get('payload') or {}
            if payload.get('type') == 'message' and payload.get('role') == 'user':
                text = rollout.text_of(payload.get('content'))
                if text.strip():
                    current = _Turn(index=len(turns), ts=rollout.parse_ts(rec.get('timestamp')),
                                     prompt=clean_text(text).strip()[:PROMPT_HEAD_LEN])
                    turns.append(current)
            continue

        if t != 'event_msg':
            continue
        payload = rec.get('payload') or {}
        if payload.get('type') != 'token_count':
            continue
        info = payload.get('info') or {}
        total = info.get('total_token_usage')
        if not isinstance(total, dict):
            continue

        def _int(v):
            return v if isinstance(v, int) and not isinstance(v, bool) else 0

        delta = {k: max(0, _int(total.get(k)) - prev_total.get(k, 0)) for k in prev_total}
        prev_total = {k: _int(total.get(k)) for k in prev_total}
        if not any(delta.values()):
            continue   # a repeated/no-op total_token_usage line

        target = current
        if target is None:
            if before is None:
                before = _Turn(index=-1, ts=None, prompt='', before_first=True)
            target = before

        target.calls += 1
        target.input += delta['input_tokens']
        target.cache_read += delta['cached_input_tokens']
        target.cache_create += delta['cache_write_input_tokens']
        target.output += delta['output_tokens']
        target.thinking += delta['reasoning_output_tokens']
        if current_model:
            target.models[current_model] = target.models.get(current_model, 0) + 1

        usage_like = {
            'input_tokens': delta['input_tokens'],
            'output_tokens': delta['output_tokens'],
            'cache_read_input_tokens': delta['cached_input_tokens'],
            'cache_creation_input_tokens': delta['cache_write_input_tokens'],
        }
        call_cost = pricing.cost(usage_like, current_model, agent='codex')
        if call_cost is None:
            target.unknown_cost = True
        elif not target.unknown_cost:
            target.cost = (target.cost or 0.0) + call_cost

        call_ts = rollout.parse_ts(rec.get('timestamp'))
        if call_ts is not None:
            target.last_ts = call_ts if target.last_ts is None else max(target.last_ts, call_ts)
        target.context_last = delta['input_tokens'] + delta['cached_input_tokens'] + delta['cache_write_input_tokens']

    ordered = ([before] if before is not None else []) + turns
    for i, tn in enumerate(ordered):
        tn.index = i
    return [tn.to_dict() for tn in ordered]


def summarize(turns: List[dict], from_ts: Optional[float] = None,
              to_ts: Optional[float] = None) -> dict:
    """Same contract as `usage.turns.summarize`, with one addition:
    `total['unknown_cost']` is `True` if any included turn has `cost: null` (an
    unpriced model) -- `total['cost']` in that case is the sum of only the turns
    whose cost *is* known, i.e. a floor, not the true total. A consumer that shows
    `total['cost']` should also show `unknown_cost` so that floor doesn't read as
    exact."""
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
    result['turns'] = turns   # restore the original (possibly-null) per-turn cost
    return result

"""Impact of a hit, the estimated saving, and the breakdown by main cause (D-7).

`impact_w` is in weighted tokens (D-4, `normalize.w_of`); `impact_usd` is the same formula
priced with `pricing.price_of` for the call's agent, or `None` when a model has no price (a Codex
model missing from the table, every OpenCode call: OpenCode records its own cost per call, which
`call_usd` uses, but no unit prices). Each hit also carries `_contrib` -- the weighted tokens it
puts on each call it covers -- so the breakdown can give every call to the one cause that
costs it the most. Hits that wait for the model (`needs_llm`) don't take part in the
breakdown: they are only candidates until the model confirms them.
"""

import bisect
from typing import Dict, List, Optional, Tuple

from ..usage import pricing
from . import normalize

MTOK = 1_000_000
P_READ = 0.1

SAVING_RATE = {
    'E01': 0.8, 'E02': 0.5, 'E03': 0.9, 'E04': 0.9, 'E05': 0.9,
    'E08': 0.6, 'E14': 0.5, 'E16': 0.5,
}


def prices(call: dict) -> Optional[Dict[str, Optional[float]]]:
    """The unit prices of `call`'s model, or `None` when there are none."""
    agent = call.get('agent') or 'claude'
    if agent == 'opencode':
        return None
    p = pricing.price_of(call.get('model'), agent=agent)
    return None if p.get('unknown') else p


def usd_sum(values) -> Optional[float]:
    """The sum, or `None` when any value is unknown."""
    total = 0.0
    for v in values:
        if v is None:
            return None
        total += v
    return total


def read_usd(tokens: float, call: dict) -> Optional[float]:
    """What reading `tokens` from the cache once costs at `call`'s model."""
    p = prices(call)
    return tokens * p['cache_read'] / MTOK if p else None


def write5_usd(tokens: float, call: dict) -> Optional[float]:
    """What writing `tokens` to the cache (the 5-minute tier) costs at `call`'s model."""
    p = prices(call)
    return tokens * p['cache_5m'] / MTOK if p else None


def write_w(call: dict) -> float:
    """The extra weighted tokens of a call's cache write over reading the same tokens."""
    cw5 = call['cw'] - call['cw1h']
    return call['cw1h'] * (2.0 - P_READ) + cw5 * (1.25 - P_READ)


def write_usd(call: dict) -> Optional[float]:
    p = prices(call)
    if p is None:
        return None
    cw5 = call['cw'] - call['cw1h']
    return (call['cw1h'] * (p['cache_1h'] - p['cache_read'])
            + cw5 * (p['cache_5m'] - p['cache_read'])) / MTOK


def call_usd(call: dict) -> Optional[float]:
    """The call's cost: OpenCode's own record, otherwise priced from the table (`None` for a
    model without a price)."""
    agent = call.get('agent') or 'claude'
    if agent == 'opencode':
        return call.get('usd') if isinstance(call.get('usd'), (int, float)) else None
    if agent == 'codex':
        usage = {'input_tokens': call['in'], 'output_tokens': call['out'],
                 'cache_read_input_tokens': call['cr'], 'cache_creation_input_tokens': call['cw']}
        return pricing.cost(usage, call.get('model'), agent='codex')
    usage = {'input_tokens': call['in'], 'output_tokens': call['out'],
             'cache_read_input_tokens': call['cr'], 'cache_creation_input_tokens': call['cw'],
             'cache_creation': {'ephemeral_1h_input_tokens': call['cw1h']}}
    return pricing.cost(usage, call.get('model')) or 0.0


def call_key(call: dict) -> str:
    return call['chain'] + '\0' + call['id']


def calls_after(chain_calls: List[dict], ts: float, compactions: List[float],
                end: float) -> List[dict]:
    """The calls of one chain after `ts`, up to the chain's next compaction or `end`: the
    calls that read again whatever was added at `ts` (their count is `R`)."""
    stop = end
    i = bisect.bisect_right(compactions, ts)
    if i < len(compactions):
        stop = min(stop, compactions[i])
    return [c for c in chain_calls if c['ts'] is not None and ts < c['ts'] <= stop]


def finish(hit: dict) -> dict:
    """Fill `saving_rate` and the rounded impacts."""
    hit['saving_rate'] = SAVING_RATE.get(hit['detector'], 0.5)
    hit['impact_w'] = round(hit['impact_w'])
    if hit.get('impact_usd') is not None:
        hit['impact_usd'] = round(hit['impact_usd'], 4)
    return hit


def effect(hit: dict) -> float:
    return hit['impact_w'] * hit['saving_rate']


def breakdown(calls: List[dict], hits: List[dict]) -> List[dict]:
    """`[{cause, w}]`: every call's weighted tokens given to the confirmed hit that puts the
    most on it, teammate calls to `team`, the rest to `other`. Largest first."""
    best: Dict[str, Tuple[float, str]] = {}
    for h in hits:
        if h['needs_llm']:
            continue
        for key, w in h.get('_contrib', {}).items():
            if w > best.get(key, (0.0, ''))[0]:
                best[key] = (w, h['detector'])
    totals: Dict[str, float] = {}
    for c in calls:
        if c['chain_kind'] == 'teammate':
            cause = 'team'
        else:
            cause = best.get(call_key(c), (0.0, 'other'))[1]
        totals[cause] = totals.get(cause, 0.0) + normalize.w_of(c)
    return sorted(({'cause': k, 'w': round(v)} for k, v in totals.items()),
                  key=lambda x: -x['w'])

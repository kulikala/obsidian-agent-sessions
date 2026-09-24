"""Per-model pricing table and cost calculation.

Prices are in $/MTok (dollars per million tokens). Looked up by prefix match against
the model ID; when multiple prefixes match, the longest one wins. Cache-creation
tokens are generally priced at the input price x 1.25 for the 5-minute tier and
input price x 2 for the 1-hour tier, but cache-read tokens use the table value
directly (`claude-fable-5-1`, `claude-mythos-5-1`, and `claude-3-haiku` are
exceptions to the "input price x 0.1" rule of thumb for cache reads).
Unknown models fall back to `claude-opus-5` pricing and are reported as
`estimated: True`.
"""

from typing import Dict, Optional, Sequence, Tuple

# (prefixes to match, input, output, cache read). All in $/MTok.
PRICES: Tuple[Tuple[Sequence[str], float, float, float], ...] = (
    (('claude-fable-5-1', 'claude-mythos-5-1'), 10, 50, 0.25),
    (('claude-fable-5', 'claude-mythos-5'), 10, 50, 1.0),
    (('claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
      'claude-opus-4-5'), 5, 25, 0.5),
    (('claude-opus-4-1', 'claude-opus-4'), 15, 75, 1.5),
    (('claude-sonnet-5',), 2, 10, 0.2),
    (('claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4',
      'claude-3-7-sonnet'), 3, 15, 0.3),
    (('claude-haiku-4-5',), 1, 5, 0.1),
    (('claude-3-5-haiku',), 0.8, 4, 0.08),
    (('claude-3-haiku',), 0.25, 1.25, 0.03),
)

# Unknown models are estimated using these (claude-opus-5's prices).
_UNKNOWN_INPUT, _UNKNOWN_OUTPUT, _UNKNOWN_CACHE_READ = 5, 25, 0.5

MTOK = 1_000_000


def price_of(model: Optional[str]) -> Dict[str, float]:
    """Return `model`'s prices: `{input, output, cache_5m, cache_1h, cache_read,
    estimated}` (all in $/MTok). Picks the longest matching prefix. If nothing
    matches, falls back to `claude-opus-5` pricing with `estimated: True`."""
    best_len = -1
    best = None
    if isinstance(model, str) and model:
        for prefixes, input_price, output_price, cache_read in PRICES:
            for prefix in prefixes:
                if model.startswith(prefix) and len(prefix) > best_len:
                    best_len = len(prefix)
                    best = (input_price, output_price, cache_read)

    if best is None:
        input_price, output_price, cache_read = _UNKNOWN_INPUT, _UNKNOWN_OUTPUT, _UNKNOWN_CACHE_READ
        estimated = True
    else:
        input_price, output_price, cache_read = best
        estimated = False

    return {
        'input': input_price,
        'output': output_price,
        'cache_5m': input_price * 1.25,
        'cache_1h': input_price * 2,
        'cache_read': cache_read,
        'estimated': estimated,
    }


def _num(value) -> float:
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def cost(usage: dict, model: Optional[str]) -> float:
    """Return the cost in dollars given `usage` (a transcript's `message.usage`) and `model`.

    If `cache_creation.ephemeral_1h_input_tokens` is present, that portion is priced
    at the 1-hour rate; the rest of `cache_creation_input_tokens` is priced at the
    5-minute rate.
    """
    if not isinstance(usage, dict):
        return 0.0
    prices = price_of(model)

    input_tokens = _num(usage.get('input_tokens'))
    output_tokens = _num(usage.get('output_tokens'))
    cache_read_tokens = _num(usage.get('cache_read_input_tokens'))
    cache_total_tokens = _num(usage.get('cache_creation_input_tokens'))

    cache_1h_tokens = 0.0
    cache_creation = usage.get('cache_creation')
    if isinstance(cache_creation, dict):
        cache_1h_tokens = _num(cache_creation.get('ephemeral_1h_input_tokens'))
    cache_1h_tokens = min(cache_1h_tokens, cache_total_tokens)
    cache_5m_tokens = cache_total_tokens - cache_1h_tokens

    total = (
        input_tokens * prices['input']
        + output_tokens * prices['output']
        + cache_read_tokens * prices['cache_read']
        + cache_5m_tokens * prices['cache_5m']
        + cache_1h_tokens * prices['cache_1h']
    ) / MTOK
    return total

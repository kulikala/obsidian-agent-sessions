"""Per-model pricing table and cost calculation.

Prices are in $/MTok (dollars per million tokens). Looked up by prefix match against
the model ID; when multiple prefixes match, the longest one wins. Cache-creation
tokens are generally priced at the input price x 1.25 for the 5-minute tier and
input price x 2 for the 1-hour tier, but cache-read tokens use the table value
directly (`claude-fable-5-1`, `claude-mythos-5-1`, and `claude-3-haiku` are
exceptions to the "input price x 0.1" rule of thumb for cache reads).

For `agent='claude'` (the default, for backward compatibility with every existing
caller), an unknown model falls back to `claude-opus-5` pricing and is reported as
`estimated: True` -- a reasonable ballpark, since every Claude model is in the same
rough price band. For `agent='codex'`, an unknown model instead reports
`unknown: True` with no dollar figure at all (see `price_of`/`cost`): Claude and
OpenAI pricing bands don't overlap closely enough for a same-vendor fallback to
make sense, and a $ estimate borrowed from an unrelated vendor's model would be
actively misleading rather than a rough ballpark.
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

# Unknown Claude models are estimated using these (claude-opus-5's prices).
_UNKNOWN_INPUT, _UNKNOWN_OUTPUT, _UNKNOWN_CACHE_READ = 5, 25, 0.5

MTOK = 1_000_000

# OpenAI models (Codex), $/MTok, cache-read priced at input x 0.1 (OpenAI's stated
# rule of thumb -- automatic, no separate cache-write tier the way Claude has, which
# matches Codex's own token accounting: see agents/codex/usage.py). Sourced from
# OpenAI's published pricing (openai.com/api/pricing) via a 2026-09-25 web search
# (the pricing page itself blocks scripted fetches); `gpt-5.6-terra` is cross-checked
# against a real local Codex rollout's `turn_context.payload.model`. Deliberately not
# exhaustive -- an unlisted OpenAI model reports `unknown` (see `price_of`) rather than
# guessing, which is safer than a table entry nobody has verified.
OPENAI_PRICES: Tuple[Tuple[Sequence[str], float, float, float], ...] = (
    (('gpt-5.6-sol',), 5.00, 30.00, 0.50),
    (('gpt-5.6-terra',), 2.00, 12.00, 0.20),
    (('gpt-5.6-luna',), 0.20, 1.20, 0.02),
    (('gpt-5.5',), 5.00, 30.00, 0.50),
    (('gpt-5.4',), 2.50, 15.00, 0.25),
    (('gpt-5-nano',), 0.05, 0.40, 0.005),
    (('gpt-5',), 1.25, 10.00, 0.125),   # base gpt-5 -- longest-prefix match still
                                          # prefers gpt-5.4/5.5/5.6/5-nano above it
)


def _match(model: Optional[str], table) -> Optional[Tuple[float, float, float]]:
    best_len = -1
    best = None
    if isinstance(model, str) and model:
        for prefixes, input_price, output_price, cache_read in table:
            for prefix in prefixes:
                if model.startswith(prefix) and len(prefix) > best_len:
                    best_len = len(prefix)
                    best = (input_price, output_price, cache_read)
    return best


def price_of(model: Optional[str], agent: str = 'claude') -> Dict[str, Optional[float]]:
    """Return `model`'s prices: `{input, output, cache_5m, cache_1h, cache_read,
    estimated, unknown}` (all in $/MTok, or `None` when `unknown`). Picks the longest
    matching prefix.

    `agent='claude'` (the default -- every existing caller passes no `agent` and
    keeps this behavior): a non-matching model falls back to `claude-opus-5`
    pricing with `estimated: True`.
    `agent='codex'`: matched against `OPENAI_PRICES` instead; a non-matching model
    returns `unknown: True` and every price is `None` -- no dollar figure, since
    there's no same-vendor ballpark to fall back to (see module docstring).
    """
    if agent == 'codex':
        best = _match(model, OPENAI_PRICES)
        if best is None:
            return {'input': None, 'output': None, 'cache_5m': None, 'cache_1h': None,
                     'cache_read': None, 'estimated': False, 'unknown': True}
        input_price, output_price, cache_read = best
        return {
            'input': input_price,
            'output': output_price,
            'cache_5m': input_price,   # no separate cache-write tier for Codex
            'cache_1h': input_price,
            'cache_read': cache_read,
            'estimated': False,
            'unknown': False,
        }

    best = _match(model, PRICES)
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
        'unknown': False,
    }


def _num(value) -> float:
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def cost(usage: dict, model: Optional[str], agent: str = 'claude') -> Optional[float]:
    """Return the cost in dollars given `usage` (a transcript's `message.usage`) and
    `model`, or `None` if `agent='codex'` and `model` isn't in `OPENAI_PRICES` (see
    `price_of`'s `unknown` field) -- the caller must treat `None` as "unknown", not 0.

    If `cache_creation.ephemeral_1h_input_tokens` is present, that portion is priced
    at the 1-hour rate; the rest of `cache_creation_input_tokens` is priced at the
    5-minute rate.
    """
    if not isinstance(usage, dict):
        return 0.0
    prices = price_of(model, agent=agent)
    if prices['unknown']:
        return None

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

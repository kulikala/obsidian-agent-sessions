"""モデルごとの単価表とコスト計算（D-40）。

単価は $/MTok（100 万トークンあたりのドル）。モデル ID の前方一致で引き、
複数の候補が一致したときは一致した接頭辞が長い方を選ぶ。cache 作成は
5 分単位＝入力単価×1.25、1 時間単位＝入力単価×2 が基本だが、cache 読出は
表の値をそのまま使う（`claude-fable-5-1`・`claude-mythos-5-1`・
`claude-3-haiku` は入力単価×0.1 の原則から外れる例外）。
未知のモデルは `claude-opus-5` の単価を使い、`estimated: True` を返す。
"""

from typing import Dict, Optional, Sequence, Tuple

# (前方一致の接頭辞たち, 入力, 出力, cache 読出)。すべて $/MTok。
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

# 未知のモデルはこれ（`claude-opus-5` の単価）で見積もる。
_UNKNOWN_INPUT, _UNKNOWN_OUTPUT, _UNKNOWN_CACHE_READ = 5, 25, 0.5

MTOK = 1_000_000


def price_of(model: Optional[str]) -> Dict[str, float]:
    """`model` の単価を返す：`{input, output, cache_5m, cache_1h, cache_read,
    estimated}`（$/MTok）。前方一致した接頭辞が最長のものを選ぶ。一致が
    無ければ `claude-opus-5` の単価で `estimated: True`。"""
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
    """`usage`（transcript の `message.usage`）と `model` から $ のコストを返す。

    `cache_creation.ephemeral_1h_input_tokens` があればその分は 1 時間単価、
    残りの `cache_creation_input_tokens` は 5 分単価で計算する。
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

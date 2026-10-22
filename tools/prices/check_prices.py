#!/usr/bin/env python3
"""Compares the Claude price table (`agentsessions/usage/pricing.py`) with Anthropic's pricing page.

    python3 tools/prices/check_prices.py [--file pricing.md] [--suggest]

Reads the page's "Model pricing" table (fetched from `PAGE`, or `--file`), turns each model name
into the id prefix the table matches (`Claude Opus 5.5` -> `claude-opus-5-5`) and prints every
difference: a model the page lists that `PRICES` lacks, a price that differs (input, output,
cache read, and the 5-minute and 1-hour cache writes, which `price_of` derives from the input
price), and the long-prompt prices (`LONG_PROMPT_PRICES`). Retired models are skipped. `--suggest` then
prints, for each model that differs, the `PRICES` / `LONG_PROMPT_PRICES` row to add or change.

Exit codes: 0 = the table matches the page, 1 = differences (printed), 2 = the page could not be
read or has no table.
"""
import argparse
import os
import re
import sys
import urllib.request
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
from agentsessions.usage import pricing  # noqa: E402

PAGE = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
_PRICE = re.compile(r'\$([0-9.]+)\s*/\s*MTok')
_LONG = re.compile(r'\(for prompts over ([0-9,]+) tokens\)')


def _model_id(name: str) -> str:
    base = re.sub(r'\s*\(.*', '', name).strip()
    return re.sub(r'[\s.]+', '-', base.lower())


def page_rows(text: str) -> List[Dict]:
    """The "Model pricing" table's rows: {id, long_over, input, cache_5m, cache_1h, cache_read, output}."""
    start = text.find('## Model pricing')
    if start < 0:
        return []
    rows = []
    for line in text[start:].splitlines()[1:]:
        if line.startswith('## '):
            break
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) != 6 or not cells[0].startswith('Claude') or 'retired' in cells[0].lower():
            continue
        prices = []
        for c in cells[1:]:
            m = _PRICE.search(c)
            prices.append(float(m.group(1)) if m else None)
        if None in prices:
            continue
        long = _LONG.search(cells[0])
        rows.append({'id': _model_id(cells[0]), 'long_over': int(long.group(1).replace(',', '')) if long else None,
                     'input': prices[0], 'cache_5m': prices[1], 'cache_1h': prices[2],
                     'cache_read': prices[3], 'output': prices[4]})
    return rows


def _ours(model_id: str, long_over: Optional[int]) -> Optional[Dict[str, float]]:
    if long_over is None:
        if not any(model_id in prefixes for prefixes, *_ in pricing.PRICES):
            return None
        p = pricing.price_of(model_id)
    else:
        if not any(model_id in prefixes and threshold == long_over
                   for prefixes, threshold, *_ in pricing.LONG_PROMPT_PRICES):
            return None
        p = pricing.price_of(model_id, prompt_tokens=long_over + 1)
    return {k: p[k] for k in ('input', 'output', 'cache_read', 'cache_5m', 'cache_1h')}


def compare(rows: List[Dict]) -> List[str]:
    out = []
    for r in rows:
        label = r['id'] + (' (prompts over %d tokens)' % r['long_over'] if r['long_over'] else '')
        ours = _ours(r['id'], r['long_over'])
        if ours is None:
            out.append('%s: not in the table (page: input %g, output %g, cache read %g)'
                       % (label, r['input'], r['output'], r['cache_read']))
            continue
        for key in ('input', 'output', 'cache_read', 'cache_5m', 'cache_1h'):
            if abs(ours[key] - r[key]) > 1e-9:
                out.append('%s: %s is %g, the page says %g' % (label, key, ours[key], r[key]))
    return out


def _num(x: float) -> str:
    return '%g' % x


def suggest(rows: List[Dict]) -> List[str]:
    """For each page row that differs from the table: the row to put in `pricing.py`."""
    out = []
    for r in rows:
        ours = _ours(r['id'], r['long_over'])
        if ours is not None and not compare([r]):
            continue
        if r['long_over'] is None:
            table, name = pricing.PRICES, 'PRICES'
            values = [_num(v) for v in (r['input'], r['output'], r['cache_read'])]
        else:
            table, name = pricing.LONG_PROMPT_PRICES, 'LONG_PROMPT_PRICES'
            values = ['{:_}'.format(r['long_over'])] + [_num(v) for v in (r['input'], r['output'], r['cache_read'])]
        existing = next((row for row in table if r['id'] in row[0]
                         and (r['long_over'] is None or row[1] == r['long_over'])), None)
        prefixes = tuple(existing[0]) if existing else (r['id'],)
        row = '(%r, %s)' % (prefixes, ', '.join(values))
        out.append('%s %s: %s,' % ('change the row in' if existing else 'add to', name, row))
        if existing and len(prefixes) > 1:
            out.append('  (this row covers %s; split the model out if the others keep their old prices)'
                       % ', '.join(prefixes))
        if abs(r['cache_5m'] - r['input'] * 1.25) > 1e-9 or abs(r['cache_1h'] - r['input'] * 2) > 1e-9:
            out.append('  the page prices cache writes at %s (5m) / %s (1h), not input x 1.25 / x 2; '
                       'price_of needs an exception' % (_num(r['cache_5m']), _num(r['cache_1h'])))
    return out


def main(argv: List[str]) -> int:
    p = argparse.ArgumentParser(description="Compare pricing.py with Anthropic's pricing page")
    p.add_argument('--file', help='a saved copy of the page (markdown) instead of fetching it')
    p.add_argument('--suggest', action='store_true',
                   help='for each difference, print the PRICES / LONG_PROMPT_PRICES row to add or change')
    ns = p.parse_args(argv)
    try:
        if ns.file:
            with open(ns.file, encoding='utf-8') as f:
                text = f.read()
        else:
            req = urllib.request.Request(PAGE, headers={'User-Agent': 'agent-sessions-price-check'})
            with urllib.request.urlopen(req, timeout=30) as resp:
                text = resp.read().decode('utf-8')
    except OSError as e:
        sys.stderr.write('[ERROR] cannot read the pricing page: %s\n' % e)
        return 2
    rows = page_rows(text)
    if not rows:
        sys.stderr.write('[ERROR] no "Model pricing" table on the page; its layout may have changed\n')
        return 2
    diffs = compare(rows)
    for d in diffs:
        print(d)
    if ns.suggest and diffs:
        print('\nSuggested rows for agentsessions/usage/pricing.py:')
        for line in suggest(rows):
            print(line)
    if not diffs:
        print('The price table matches the page (%d models).' % len(rows))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

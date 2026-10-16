import importlib.util
import os
import unittest

_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'tools', 'prices', 'check_prices.py')
_spec = importlib.util.spec_from_file_location('check_prices', _PATH)
check_prices = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_prices)

PAGE = """# Pricing

## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :-- | :-- | :-- | :-- | :-- | :-- |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Opus 4 ([retired, except on Google Cloud](https://example.com)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |
{extra}
## Cloud platform pricing
"""


class CheckPricesTest(unittest.TestCase):
    def test_rows_are_read_and_retired_models_skipped(self):
        rows = check_prices.page_rows(PAGE.format(extra=''))
        self.assertEqual([(r['id'], r['long_over']) for r in rows],
                         [('claude-opus-5-5', None), ('claude-haiku-5-5', None), ('claude-haiku-5-5', 100000)])

    def test_the_table_matches_these_rows(self):
        self.assertEqual(check_prices.compare(check_prices.page_rows(PAGE.format(extra=''))), [])

    def test_a_changed_price_and_a_new_model_are_reported(self):
        extra = ('| Claude Opus 5 | $6 / MTok | $7.50 / MTok | $12 / MTok | $0.50 / MTok | $25 / MTok |\n'
                 '| Claude Opus 6 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |')
        diffs = check_prices.compare(check_prices.page_rows(PAGE.format(extra=extra)))
        self.assertIn('claude-opus-5: input is 5, the page says 6', diffs)
        self.assertTrue(any(d.startswith('claude-opus-6: not in the table') for d in diffs))

    def test_suggest_prints_the_row_to_change_and_the_row_to_add(self):
        extra = ('| Claude Opus 5 | $6 / MTok | $7.50 / MTok | $12 / MTok | $0.50 / MTok | $25 / MTok |\n'
                 '| Claude Opus 6 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |')
        lines = check_prices.suggest(check_prices.page_rows(PAGE.format(extra=extra)))
        self.assertTrue(any(l.startswith("change the row in PRICES: (('claude-opus-5', 'claude-opus-4-8'") and
                            l.endswith('6, 25, 0.5),') for l in lines), lines)
        self.assertIn("add to PRICES: (('claude-opus-6',), 4, 20, 0.2),", lines)

    def test_suggest_covers_long_prompt_rows_and_odd_cache_writes(self):
        extra = ('| Claude Haiku 6 (for prompts over 200,000 tokens) | $1 / MTok | $2 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |')
        lines = check_prices.suggest(check_prices.page_rows(PAGE.format(extra=extra)))
        self.assertIn("add to LONG_PROMPT_PRICES: (('claude-haiku-6',), 200_000, 1, 5, 0.1),", lines)
        self.assertTrue(any('not input x 1.25' in l for l in lines))

    def test_suggest_is_empty_when_the_table_matches(self):
        self.assertEqual(check_prices.suggest(check_prices.page_rows(PAGE.format(extra=''))), [])

    def test_no_table_reads_no_rows(self):
        self.assertEqual(check_prices.page_rows('# Pricing\n\nmoved'), [])


if __name__ == '__main__':
    unittest.main()

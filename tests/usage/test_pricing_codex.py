import unittest

from agentsessions.usage import pricing


class TestCodexPricing(unittest.TestCase):
    def test_known_openai_model_has_a_real_price(self):
        p = pricing.price_of('gpt-5.6-terra', agent='codex')
        self.assertFalse(p['unknown'])
        self.assertEqual(p['input'], 2.00)
        self.assertEqual(p['output'], 12.00)

    def test_unknown_openai_model_reports_unknown_not_zero(self):
        p = pricing.price_of('some-model-that-does-not-exist', agent='codex')
        self.assertTrue(p['unknown'])
        self.assertIsNone(p['input'])
        self.assertIsNone(p['output'])

    def test_cost_returns_none_for_unknown_codex_model(self):
        usage = {'input_tokens': 1000, 'output_tokens': 100}
        self.assertIsNone(pricing.cost(usage, 'not-a-real-model', agent='codex'))

    def test_cost_is_a_number_for_known_codex_model(self):
        usage = {'input_tokens': 1_000_000, 'output_tokens': 0}
        self.assertEqual(pricing.cost(usage, 'gpt-5.6-terra', agent='codex'), 2.00)

    def test_claude_agent_default_is_unaffected_by_codex_prices(self):
        # An unknown *Claude* model still gets the opus-5 estimate fallback, not "unknown" --
        # backward compatible with every existing caller that never passes `agent`.
        p = pricing.price_of('some-unreleased-claude-model')
        self.assertFalse(p['unknown'])
        self.assertTrue(p['estimated'])


if __name__ == '__main__':
    unittest.main()

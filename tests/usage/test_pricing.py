import unittest

from agentsessions import pricing


class PriceOfTest(unittest.TestCase):
    def test_each_table_row(self):
        cases = [
            ('claude-fable-5-1', 10, 50, 0.25),
            ('claude-mythos-5-1', 10, 50, 0.25),
            ('claude-fable-5', 10, 50, 1.0),
            ('claude-mythos-5', 10, 50, 1.0),
            ('claude-opus-5', 5, 25, 0.5),
            ('claude-opus-4-8', 5, 25, 0.5),
            ('claude-opus-4-7', 5, 25, 0.5),
            ('claude-opus-4-6', 5, 25, 0.5),
            ('claude-opus-4-5', 5, 25, 0.5),
            ('claude-opus-4-1', 15, 75, 1.5),
            ('claude-opus-4', 15, 75, 1.5),
            ('claude-sonnet-5', 2, 10, 0.2),
            ('claude-sonnet-4-6', 3, 15, 0.3),
            ('claude-sonnet-4-5', 3, 15, 0.3),
            ('claude-sonnet-4', 3, 15, 0.3),
            ('claude-3-7-sonnet', 3, 15, 0.3),
            ('claude-haiku-4-5', 1, 5, 0.1),
            ('claude-3-5-haiku', 0.8, 4, 0.08),
            ('claude-3-haiku', 0.25, 1.25, 0.03),
        ]
        for model_id, expected_input, expected_output, expected_cache_read in cases:
            with self.subTest(model=model_id):
                p = pricing.price_of(model_id)
                self.assertEqual(p['input'], expected_input)
                self.assertEqual(p['output'], expected_output)
                self.assertEqual(p['cache_read'], expected_cache_read)
                self.assertFalse(p['estimated'])

    def test_ids_match_by_forward_prefix_with_suffix(self):
        # Real model IDs sometimes have a date suffix appended
        p = pricing.price_of('claude-sonnet-5-20260101')
        self.assertEqual(p['input'], 2)
        self.assertEqual(p['output'], 10)

    def test_longer_prefix_wins_over_shorter_one(self):
        # claude-opus-4-1 is longer than claude-opus-4, and both could match as a prefix
        p = pricing.price_of('claude-opus-4-1-20260101')
        self.assertEqual(p['input'], 15)
        self.assertEqual(p['output'], 75)
        self.assertEqual(p['cache_read'], 1.5)

        p2 = pricing.price_of('claude-opus-4-20260101')
        self.assertEqual(p2['input'], 15)
        self.assertEqual(p2['cache_read'], 1.5)

        # claude-fable-5-1 has a longer prefix than claude-fable-5
        p3 = pricing.price_of('claude-fable-5-1-20260101')
        self.assertEqual(p3['cache_read'], 0.25)

        p4 = pricing.price_of('claude-fable-5-20260101')
        self.assertEqual(p4['cache_read'], 1.0)

    def test_cache_5m_and_1h_multiples_of_input(self):
        p = pricing.price_of('claude-sonnet-5')
        self.assertAlmostEqual(p['cache_5m'], 2 * 1.25)
        self.assertAlmostEqual(p['cache_1h'], 2 * 2)

    def test_unknown_model_falls_back_to_opus_5_and_is_estimated(self):
        p = pricing.price_of('some-unknown-model')
        opus5 = pricing.price_of('claude-opus-5')
        self.assertEqual(p['input'], opus5['input'])
        self.assertEqual(p['output'], opus5['output'])
        self.assertEqual(p['cache_read'], opus5['cache_read'])
        self.assertTrue(p['estimated'])

    def test_missing_or_empty_model_is_estimated(self):
        self.assertTrue(pricing.price_of(None)['estimated'])
        self.assertTrue(pricing.price_of('')['estimated'])


class CostTest(unittest.TestCase):
    def test_input_output_and_cache_read(self):
        usage = {
            'input_tokens': 1_000_000,
            'output_tokens': 1_000_000,
            'cache_read_input_tokens': 1_000_000,
        }
        c = pricing.cost(usage, 'claude-sonnet-5')
        # 2 + 10 + 0.2 = $12.2
        self.assertAlmostEqual(c, 12.2)

    def test_cache_creation_without_1h_is_priced_at_5m(self):
        usage = {'cache_creation_input_tokens': 1_000_000}
        c = pricing.cost(usage, 'claude-sonnet-5')
        self.assertAlmostEqual(c, 2 * 1.25)

    def test_cache_creation_1h_split_from_5m(self):
        usage = {
            'cache_creation_input_tokens': 1_000_000,
            'cache_creation': {'ephemeral_1h_input_tokens': 400_000},
        }
        c = pricing.cost(usage, 'claude-sonnet-5')
        expected = (400_000 * (2 * 2) + 600_000 * (2 * 1.25)) / 1_000_000
        self.assertAlmostEqual(c, expected)

    def test_unknown_model_uses_opus_5_price_and_is_still_a_number(self):
        usage = {'input_tokens': 1_000_000}
        c = pricing.cost(usage, 'nonexistent-model')
        self.assertAlmostEqual(c, 5.0)

    def test_non_dict_usage_is_zero(self):
        self.assertEqual(pricing.cost(None, 'claude-sonnet-5'), 0.0)
        self.assertEqual(pricing.cost({}, 'claude-sonnet-5'), 0.0)


if __name__ == '__main__':
    unittest.main()

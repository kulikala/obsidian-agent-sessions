import tempfile
import unittest

from agentsessions.agents.codex import usage
from tests.agents.codex_helpers import (
    rollout_path, session_meta, token_count, turn_context, user_message, write_rollout,
)

ID1 = '03000000-0000-0000-0000-000000000001'


class TestCodexUsage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name

    def test_collect_computes_per_turn_deltas_from_running_totals(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='gpt-5.6-terra'),
            user_message('first prompt', '2026-09-24T01:30:31Z'),
            token_count({'input_tokens': 1000, 'cached_input_tokens': 200,
                         'cache_write_input_tokens': 0, 'output_tokens': 50,
                         'reasoning_output_tokens': 10}, '2026-09-24T01:30:32Z'),
            user_message('second prompt', '2026-09-24T01:31:00Z'),
            token_count({'input_tokens': 1800, 'cached_input_tokens': 500,
                         'cache_write_input_tokens': 0, 'output_tokens': 90,
                         'reasoning_output_tokens': 20}, '2026-09-24T01:31:05Z'),
        ])
        turns = usage.collect(p)
        self.assertEqual(len(turns), 2)
        first, second = turns
        self.assertEqual(first['input'], 1000)
        self.assertEqual(first['cache_read'], 200)
        self.assertEqual(first['output'], 50)
        self.assertEqual(first['thinking'], 10)
        # second turn is a DELTA against the running total, not the raw cumulative value
        self.assertEqual(second['input'], 800)
        self.assertEqual(second['cache_read'], 300)
        self.assertEqual(second['output'], 40)
        self.assertGreater(first['cost'], 0)
        self.assertFalse(first['unknown_cost'])

    def test_unknown_model_reports_unknown_cost_not_zero(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='some-future-model-not-in-the-price-table'),
            user_message('prompt', '2026-09-24T01:30:31Z'),
            token_count({'input_tokens': 1000, 'cached_input_tokens': 0,
                         'cache_write_input_tokens': 0, 'output_tokens': 50,
                         'reasoning_output_tokens': 0}, '2026-09-24T01:30:32Z'),
        ])
        turns = usage.collect(p)
        self.assertTrue(turns[0]['unknown_cost'])
        self.assertIsNone(turns[0]['cost'])

    def test_usage_before_first_prompt_is_rolled_into_before_first_turn(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='gpt-5.6-terra'),
            token_count({'input_tokens': 500, 'cached_input_tokens': 0,
                         'cache_write_input_tokens': 0, 'output_tokens': 10,
                         'reasoning_output_tokens': 0}, '2026-09-24T01:30:31Z'),
        ])
        turns = usage.collect(p)
        self.assertEqual(len(turns), 1)
        self.assertTrue(turns[0]['before_first'])

    def test_summarize_marks_unknown_cost_when_any_turn_in_range_is_unknown(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='unpriced-model'),
            user_message('prompt', '2026-09-24T01:30:31Z'),
            token_count({'input_tokens': 100, 'cached_input_tokens': 0,
                         'cache_write_input_tokens': 0, 'output_tokens': 5,
                         'reasoning_output_tokens': 0}, '2026-09-24T01:30:32Z'),
        ])
        turns = usage.collect(p)
        result = usage.summarize(turns)
        self.assertTrue(result['total']['unknown_cost'])


if __name__ == '__main__':
    unittest.main()

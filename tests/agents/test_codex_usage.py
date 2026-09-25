import tempfile
import unittest

from agentsessions.agents.codex import usage
from tests.agents.codex_helpers import (
    assistant_message, event, event_user_message, rollout_path, session_meta,
    token_count, turn_context, user_message, write_rollout,
)

ID1 = '03000000-0000-0000-0000-000000000001'


def task_started(ts: str) -> dict:
    return event('task_started', ts)


def task_complete(ts: str) -> dict:
    return event('task_complete', ts)


class TestCodexUsage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name

    def test_collect_computes_per_turn_deltas_from_running_totals(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='gpt-5.6-terra'),
            task_started('2026-09-24T01:30:30Z'),
            event_user_message('first prompt', '2026-09-24T01:30:31Z'),
            token_count({'input_tokens': 1000, 'cached_input_tokens': 200,
                         'cache_write_input_tokens': 0, 'output_tokens': 50,
                         'reasoning_output_tokens': 10}, '2026-09-24T01:30:32Z'),
            task_complete('2026-09-24T01:30:59Z'),
            task_started('2026-09-24T01:30:59.5Z'),
            event_user_message('second prompt', '2026-09-24T01:31:00Z'),
            token_count({'input_tokens': 1800, 'cached_input_tokens': 500,
                         'cache_write_input_tokens': 0, 'output_tokens': 90,
                         'reasoning_output_tokens': 20}, '2026-09-24T01:31:05Z'),
        ])
        turns = usage.collect(p)
        self.assertEqual(len(turns), 2)
        first, second = turns
        self.assertEqual(first['prompt'], 'first prompt')
        self.assertEqual(first['input'], 1000)
        self.assertEqual(first['cache_read'], 200)
        self.assertEqual(first['output'], 50)
        self.assertEqual(first['thinking'], 10)
        # second turn is a DELTA against the running total, not the raw cumulative value
        self.assertEqual(second['prompt'], 'second prompt')
        self.assertEqual(second['input'], 800)
        self.assertEqual(second['cache_read'], 300)
        self.assertEqual(second['output'], 40)
        self.assertGreater(first['cost'], 0)
        self.assertFalse(first['unknown_cost'])

    def test_injected_response_item_does_not_create_an_extra_turn(self):
        # The bug this covers: real data shows task_started firing BEFORE a
        # turn's response_items (including Codex's own injected context, which
        # historically showed up as a *second* role=user response_item ahead of
        # the real one). Splitting on response_item produced two turns for what
        # is really one; splitting on task_started must produce exactly one.
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='gpt-5.6-terra'),
            task_started('2026-09-24T01:30:30Z'),
            user_message('<recommended_plugins>\ninjected stuff', '2026-09-24T01:30:30.5Z'),
            event_user_message('Reply with the single word: ok', '2026-09-24T01:30:31Z'),
            assistant_message('ok', '2026-09-24T01:30:32Z'),
            token_count({'input_tokens': 14565, 'cached_input_tokens': 5888,
                         'cache_write_input_tokens': 0, 'output_tokens': 5,
                         'reasoning_output_tokens': 0}, '2026-09-24T01:30:33Z'),
            task_complete('2026-09-24T01:30:34Z'),
        ])
        turns = usage.collect(p)
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0]['prompt'], 'Reply with the single word: ok')
        self.assertEqual(turns[0]['input'], 14565)

    def test_totals_are_unchanged_regardless_of_how_many_turns_the_data_splits_into(self):
        # Same total token/cost sums whether one task_started fires (one turn)
        # or three (three turns) for the same overall token_count events -- only
        # the boundary placement should ever differ, never the totals.
        def usage_events(paths_ts):
            out = []
            for ts in paths_ts:
                out.append(token_count({'input_tokens': 100, 'cached_input_tokens': 10,
                                        'cache_write_input_tokens': 0, 'output_tokens': 20,
                                        'reasoning_output_tokens': 0}, ts))
            return out

        p1 = rollout_path(self.home, ID1, when='2026/09/24', ts='2026-09-24T01-30-30')
        write_rollout(p1, [
            session_meta(ID1, '/work/one'),
            turn_context(model='gpt-5.6-terra'),
            task_started('2026-09-24T01:30:30Z'),
            event_user_message('go', '2026-09-24T01:30:31Z'),
        ] + usage_events(['2026-09-24T01:30:32Z', '2026-09-24T01:30:33Z', '2026-09-24T01:30:34Z']))

        ID2 = '03000000-0000-0000-0000-000000000002'
        p2 = rollout_path(self.home, ID2, when='2026/09/24', ts='2026-09-24T02-00-00')
        write_rollout(p2, [
            session_meta(ID2, '/work/one'),
            turn_context(model='gpt-5.6-terra'),
            task_started('2026-09-24T02:00:00Z'),
            event_user_message('go', '2026-09-24T02:00:01Z'),
            token_count({'input_tokens': 100, 'cached_input_tokens': 10,
                        'cache_write_input_tokens': 0, 'output_tokens': 20,
                        'reasoning_output_tokens': 0}, '2026-09-24T02:00:02Z'),
            task_complete('2026-09-24T02:00:03Z'),
            task_started('2026-09-24T02:00:04Z'),
            event_user_message('continue', '2026-09-24T02:00:05Z'),
            token_count({'input_tokens': 100, 'cached_input_tokens': 10,
                        'cache_write_input_tokens': 0, 'output_tokens': 20,
                        'reasoning_output_tokens': 0}, '2026-09-24T02:00:06Z'),
            task_complete('2026-09-24T02:00:07Z'),
            task_started('2026-09-24T02:00:08Z'),
            event_user_message('continue', '2026-09-24T02:00:09Z'),
            token_count({'input_tokens': 100, 'cached_input_tokens': 10,
                        'cache_write_input_tokens': 0, 'output_tokens': 20,
                        'reasoning_output_tokens': 0}, '2026-09-24T02:00:10Z'),
        ])

        turns_one_task = usage.collect(p1)
        turns_three_tasks = usage.collect(p2)
        self.assertEqual(len(turns_one_task), 1)
        self.assertEqual(len(turns_three_tasks), 3)

        total_one = usage.summarize(turns_one_task)['total']
        total_three = usage.summarize(turns_three_tasks)['total']
        for key in ('input', 'cache_read', 'output', 'thinking', 'calls'):
            self.assertEqual(total_one[key], total_three[key])
        self.assertAlmostEqual(total_one['cost'], total_three['cost'])

    def test_unknown_model_reports_unknown_cost_not_zero(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='some-future-model-not-in-the-price-table'),
            task_started('2026-09-24T01:30:30Z'),
            event_user_message('prompt', '2026-09-24T01:30:31Z'),
            token_count({'input_tokens': 1000, 'cached_input_tokens': 0,
                         'cache_write_input_tokens': 0, 'output_tokens': 50,
                         'reasoning_output_tokens': 0}, '2026-09-24T01:30:32Z'),
        ])
        turns = usage.collect(p)
        self.assertTrue(turns[0]['unknown_cost'])
        self.assertIsNone(turns[0]['cost'])

    def test_usage_before_first_task_started_is_rolled_into_before_first_turn(self):
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
            task_started('2026-09-24T01:30:30Z'),
            event_user_message('prompt', '2026-09-24T01:30:31Z'),
            token_count({'input_tokens': 100, 'cached_input_tokens': 0,
                         'cache_write_input_tokens': 0, 'output_tokens': 5,
                         'reasoning_output_tokens': 0}, '2026-09-24T01:30:32Z'),
        ])
        turns = usage.collect(p)
        result = usage.summarize(turns)
        self.assertTrue(result['total']['unknown_cost'])

    def test_slash_command_user_message_does_not_become_the_prompt(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='gpt-5.6-terra'),
            task_started('2026-09-24T01:30:30Z'),
            event_user_message('/compact', '2026-09-24T01:30:31Z'),
            token_count({'input_tokens': 100, 'cached_input_tokens': 0,
                         'cache_write_input_tokens': 0, 'output_tokens': 5,
                         'reasoning_output_tokens': 0}, '2026-09-24T01:30:32Z'),
        ])
        turns = usage.collect(p)
        self.assertEqual(turns[0]['prompt'], '')


if __name__ == '__main__':
    unittest.main()

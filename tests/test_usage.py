import json
import os
import tempfile
import unittest

from agentsessions import pricing, usage


def _line(obj) -> str:
    return json.dumps(obj, ensure_ascii=False) + '\n'


def _assistant(ts, msg_id, model, tokens, thinking=None, tools=None, **flags):
    u = {
        'input_tokens': tokens.get('input', 0),
        'cache_creation_input_tokens': tokens.get('cache_create', 0),
        'cache_read_input_tokens': tokens.get('cache_read', 0),
        'output_tokens': tokens.get('output', 0),
    }
    if thinking is not None:
        u['output_tokens_details'] = {'thinking_tokens': thinking}
    message = {'id': msg_id, 'model': model, 'usage': u}
    if tools is not None:
        message['content'] = [{'type': 'tool_use', 'name': name} for name in tools]
    rec = {'type': 'assistant', 'timestamp': ts, 'message': message}
    rec.update(flags)
    return rec


def _user(ts, text, **flags):
    rec = {'type': 'user', 'timestamp': ts, 'message': {'role': 'user', 'content': text}}
    rec.update(flags)
    return rec


FIXTURE = [
    # usage before the first instruction (goes into the "(before first prompt)" turn)
    _assistant('2024-01-01T00:00:00.000Z', 'pre1', 'claude-3-x', {'input': 10, 'output': 5}),
    # isSidechain: not counted
    _assistant('2024-01-01T00:00:01.000Z', 'side1', 'claude-3-x', {'input': 999, 'output': 999},
                isSidechain=True),
    # isMeta: doesn't even start a turn
    _user('2024-01-01T00:00:01.500Z', 'injected meta line', isMeta=True),

    # turn 1
    _user('2024-01-01T00:00:02.000Z', 'first instruction'),
    _assistant('2024-01-01T00:00:03.000Z', 'syn1', '<synthetic>', {'input': 50, 'output': 50}),
    _assistant('2024-01-01T00:00:03.500Z', 'm1', 'claude-3-opus',
               {'input': 100, 'cache_create': 20, 'cache_read': 5, 'output': 40},
               tools=['Read', 'Read', 'Edit']),
    # duplicate line with the same message.id: the second one isn't counted
    # (tools aren't double-counted either)
    _assistant('2024-01-01T00:00:03.600Z', 'm1', 'claude-3-opus',
               {'input': 100, 'cache_create': 20, 'cache_read': 5, 'output': 40},
               tools=['Read', 'Read', 'Edit']),

    # turn 2
    _user('2024-01-01T00:00:05.000Z', 'second instruction'),
    _assistant('2024-01-01T00:00:06.000Z', 'm2', 'claude-3-sonnet', {'input': 200, 'output': 80},
               thinking=15),

    # turn 3 (a known model: claude-3-haiku. `estimated` is not set)
    _user('2024-01-01T00:00:07.000Z', 'third instruction'),
    _assistant('2024-01-01T00:00:08.000Z', 'm3', 'claude-3-haiku', {'input': 30, 'output': 10}),
]


def _cost(model, tokens):
    u = {
        'input_tokens': tokens.get('input', 0),
        'cache_creation_input_tokens': tokens.get('cache_create', 0),
        'cache_read_input_tokens': tokens.get('cache_read', 0),
        'output_tokens': tokens.get('output', 0),
    }
    return pricing.cost(u, model)


class UsageTest(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(prefix='agent-sessions-usage-', suffix='.jsonl')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            for rec in FIXTURE:
                f.write(_line(rec))
        self.addCleanup(os.remove, self.path)

    def test_turn_count_and_labels(self):
        turns = usage.collect(self.path)
        self.assertEqual(len(turns), 4)
        self.assertEqual(turns[0]['prompt'], usage.BEFORE_LABEL)
        self.assertIsNone(turns[0]['ts'])
        self.assertEqual(turns[1]['prompt'], 'first instruction')
        self.assertEqual(turns[2]['prompt'], 'second instruction')
        self.assertEqual(turns[3]['prompt'], 'third instruction')
        self.assertEqual([t['index'] for t in turns], [0, 1, 2, 3])

    def test_before_turn_collects_pre_prompt_usage_only(self):
        turns = usage.collect(self.path)
        before = turns[0]
        self.assertEqual(before['calls'], 1)
        self.assertEqual(before['input'], 10)
        self.assertEqual(before['output'], 5)
        self.assertEqual(before['models'], {'claude-3-x': 1})

    def test_sidechain_and_meta_are_skipped(self):
        turns = usage.collect(self.path)
        total_calls = sum(t['calls'] for t in turns)
        # side1 (isSidechain) is not included in either the before turn or turn 1
        self.assertNotIn('claude-3-x', turns[1].get('models', {}))
        self.assertEqual(total_calls, 4)   # only pre1, m1, m2, m3

    def test_duplicate_message_id_counted_once(self):
        turns = usage.collect(self.path)
        turn1 = turns[1]
        self.assertEqual(turn1['calls'], 1)
        self.assertEqual(turn1['input'], 100)
        self.assertEqual(turn1['cache_create'], 20)
        self.assertEqual(turn1['cache_read'], 5)
        self.assertEqual(turn1['output'], 40)

    def test_synthetic_model_is_not_counted(self):
        turns = usage.collect(self.path)
        turn1 = turns[1]
        self.assertNotIn('<synthetic>', turn1['models'])
        self.assertEqual(turn1['calls'], 1)   # would be 2 if syn1 were counted

    def test_thinking_tokens(self):
        turns = usage.collect(self.path)
        self.assertEqual(turns[2]['thinking'], 15)
        self.assertEqual(turns[1]['thinking'], 0)

    # --- per-turn cost, tools, and estimated ---

    def test_cost_per_turn_matches_pricing_cost(self):
        turns = usage.collect(self.path)
        self.assertAlmostEqual(turns[0]['cost'], _cost('claude-3-x', {'input': 10, 'output': 5}))
        self.assertAlmostEqual(turns[1]['cost'], _cost('claude-3-opus',
            {'input': 100, 'cache_create': 20, 'cache_read': 5, 'output': 40}))
        self.assertAlmostEqual(turns[2]['cost'], _cost('claude-3-sonnet', {'input': 200, 'output': 80}))
        self.assertAlmostEqual(turns[3]['cost'], _cost('claude-3-haiku', {'input': 30, 'output': 10}))

    def test_unknown_model_marks_turn_estimated(self):
        turns = usage.collect(self.path)
        # claude-3-x, claude-3-opus, claude-3-sonnet aren't in the pricing table,
        # so they're treated as unknown and marked estimated
        self.assertTrue(turns[0]['estimated'])
        self.assertTrue(turns[1]['estimated'])
        self.assertTrue(turns[2]['estimated'])
        # claude-3-haiku is a known model in the pricing table
        self.assertFalse(turns[3]['estimated'])

    def test_tool_use_counted_by_name_and_deduplicated_with_the_message(self):
        turns = usage.collect(self.path)
        turn1 = turns[1]
        # tools from a duplicate line (same message.id) aren't double-counted
        self.assertEqual(turn1['tools'], {'Read': 2, 'Edit': 1})
        self.assertEqual(turns[2]['tools'], {})

    def test_context_last_is_the_last_calls_input_plus_cache(self):
        turns = usage.collect(self.path)
        turn1 = turns[1]
        self.assertEqual(turn1['context_last'], 100 + 5 + 20)   # input + cache_read + cache_create
        self.assertEqual(turns[3]['context_last'], 30)

    def test_last_ts_is_the_last_assistant_lines_ts_within_the_turn(self):
        turns = usage.collect(self.path)
        self.assertEqual(turns[1]['last_ts'], usage._parse_ts('2024-01-01T00:00:03.500Z'))
        self.assertEqual(turns[3]['last_ts'], usage._parse_ts('2024-01-01T00:00:08.000Z'))

    # --- summarize's total: cost, tools, duration, first_ts, last_ts, context_last, estimated ---

    def test_summarize_totals_everything_by_default(self):
        turns = usage.collect(self.path)
        result = usage.summarize(turns)
        self.assertEqual(result['from'], None)
        self.assertEqual(result['to'], None)
        self.assertEqual(result['turns'], turns)
        total = result['total']
        self.assertEqual(total['calls'], 4)
        self.assertEqual(total['input'], 340)
        self.assertEqual(total['cache_create'], 20)
        self.assertEqual(total['cache_read'], 5)
        self.assertEqual(total['output'], 135)
        self.assertEqual(total['thinking'], 15)
        self.assertAlmostEqual(total['cost'], sum(t['cost'] for t in turns))
        self.assertEqual(total['tools'], {'Read': 2, 'Edit': 1})
        self.assertTrue(total['estimated'])   # there's a turn with an unknown model
        self.assertEqual(total['first_ts'], usage._parse_ts('2024-01-01T00:00:02.000Z'))
        self.assertEqual(total['last_ts'], usage._parse_ts('2024-01-01T00:00:08.000Z'))
        self.assertAlmostEqual(total['duration'], 6.0)
        self.assertEqual(total['context_last'], 30)   # the last counted call == m3

    def test_summarize_range_excludes_before_turn(self):
        turns = usage.collect(self.path)
        turn2_ts = turns[2]['ts']
        result = usage.summarize(turns, from_ts=turn2_ts, to_ts=turn2_ts)
        total = result['total']
        self.assertEqual(total['calls'], 1)
        self.assertEqual(total['input'], 200)
        self.assertEqual(total['cache_create'], 0)
        self.assertEqual(total['cache_read'], 0)
        self.assertEqual(total['output'], 80)
        self.assertEqual(total['thinking'], 15)
        self.assertAlmostEqual(total['cost'], turns[2]['cost'])
        self.assertEqual(total['tools'], {})
        self.assertEqual(total['context_last'], turns[2]['context_last'])

    def test_summarize_range_is_inclusive_of_both_ends(self):
        turns = usage.collect(self.path)
        result = usage.summarize(turns, from_ts=turns[1]['ts'], to_ts=turns[3]['ts'])
        self.assertEqual(result['total']['calls'], 3)   # turns 1-3; the before-turn isn't included

    def test_summarize_range_includes_cost_and_tools_for_partial_range(self):
        turns = usage.collect(self.path)
        result = usage.summarize(turns, from_ts=turns[1]['ts'], to_ts=turns[2]['ts'])
        total = result['total']
        self.assertAlmostEqual(total['cost'], turns[1]['cost'] + turns[2]['cost'])
        self.assertEqual(total['tools'], {'Read': 2, 'Edit': 1})

    def test_summarize_with_no_turns_has_no_duration(self):
        result = usage.summarize([])
        self.assertIsNone(result['total']['first_ts'])
        self.assertIsNone(result['total']['last_ts'])
        self.assertIsNone(result['total']['duration'])
        self.assertEqual(result['total']['context_last'], 0)
        self.assertEqual(result['total']['cost'], 0.0)
        self.assertEqual(result['total']['tools'], {})
        self.assertFalse(result['total']['estimated'])

    def test_missing_transcript_collects_nothing(self):
        self.assertEqual(usage.collect('/no/such/path.jsonl'), [])


if __name__ == '__main__':
    unittest.main()

import json
import os
import tempfile
import unittest

from agentsessions import usage


def _line(obj) -> str:
    return json.dumps(obj, ensure_ascii=False) + '\n'


def _assistant(ts, msg_id, model, tokens, thinking=None, **flags):
    u = {
        'input_tokens': tokens.get('input', 0),
        'cache_creation_input_tokens': tokens.get('cache_create', 0),
        'cache_read_input_tokens': tokens.get('cache_read', 0),
        'output_tokens': tokens.get('output', 0),
    }
    if thinking is not None:
        u['output_tokens_details'] = {'thinking_tokens': thinking}
    rec = {'type': 'assistant', 'timestamp': ts,
           'message': {'id': msg_id, 'model': model, 'usage': u}}
    rec.update(flags)
    return rec


def _user(ts, text, **flags):
    rec = {'type': 'user', 'timestamp': ts, 'message': {'role': 'user', 'content': text}}
    rec.update(flags)
    return rec


FIXTURE = [
    # 最初の指示より前の usage（「（開始前）」のターンに入る）
    _assistant('2024-01-01T00:00:00.000Z', 'pre1', 'claude-3-x', {'input': 10, 'output': 5}),
    # isSidechain：数えない
    _assistant('2024-01-01T00:00:01.000Z', 'side1', 'claude-3-x', {'input': 999, 'output': 999},
                isSidechain=True),
    # isMeta：ターンの開始にもならない
    _user('2024-01-01T00:00:01.500Z', 'メタの差し込み', isMeta=True),

    # ターン 1
    _user('2024-01-01T00:00:02.000Z', '最初の指示です'),
    _assistant('2024-01-01T00:00:03.000Z', 'syn1', '<synthetic>', {'input': 50, 'output': 50}),
    _assistant('2024-01-01T00:00:03.500Z', 'm1', 'claude-3-opus',
               {'input': 100, 'cache_create': 20, 'cache_read': 5, 'output': 40}),
    # 同じ message.id の重複行：2 回目は数えない
    _assistant('2024-01-01T00:00:03.600Z', 'm1', 'claude-3-opus',
               {'input': 100, 'cache_create': 20, 'cache_read': 5, 'output': 40}),

    # ターン 2
    _user('2024-01-01T00:00:05.000Z', '2件目の指示'),
    _assistant('2024-01-01T00:00:06.000Z', 'm2', 'claude-3-sonnet', {'input': 200, 'output': 80},
               thinking=15),

    # ターン 3
    _user('2024-01-01T00:00:07.000Z', '3件目の指示'),
    _assistant('2024-01-01T00:00:08.000Z', 'm3', 'claude-3-haiku', {'input': 30, 'output': 10}),
]


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
        self.assertEqual(turns[1]['prompt'], '最初の指示です')
        self.assertEqual(turns[2]['prompt'], '2件目の指示')
        self.assertEqual(turns[3]['prompt'], '3件目の指示')
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
        # side1（isSidechain）は before にも turn 1 にも入らない
        self.assertNotIn('claude-3-x', turns[1].get('models', {}))
        self.assertEqual(total_calls, 4)   # pre1・m1・m2・m3 のみ

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
        self.assertEqual(turn1['calls'], 1)   # syn1 を数えていれば 2 になる

    def test_thinking_tokens(self):
        turns = usage.collect(self.path)
        self.assertEqual(turns[2]['thinking'], 15)
        self.assertEqual(turns[1]['thinking'], 0)

    def test_summarize_totals_everything_by_default(self):
        turns = usage.collect(self.path)
        result = usage.summarize(turns)
        self.assertEqual(result['from'], None)
        self.assertEqual(result['to'], None)
        self.assertEqual(result['turns'], turns)
        self.assertEqual(result['total'], {
            'calls': 4, 'input': 340, 'cache_create': 20, 'cache_read': 5,
            'output': 135, 'thinking': 15,
        })

    def test_summarize_range_excludes_before_turn(self):
        turns = usage.collect(self.path)
        turn2_ts = turns[2]['ts']
        result = usage.summarize(turns, from_ts=turn2_ts, to_ts=turn2_ts)
        self.assertEqual(result['total'], {
            'calls': 1, 'input': 200, 'cache_create': 0, 'cache_read': 0,
            'output': 80, 'thinking': 15,
        })

    def test_summarize_range_is_inclusive_of_both_ends(self):
        turns = usage.collect(self.path)
        result = usage.summarize(turns, from_ts=turns[1]['ts'], to_ts=turns[3]['ts'])
        self.assertEqual(result['total']['calls'], 3)   # ターン 1〜3。開始前は入らない

    def test_missing_transcript_collects_nothing(self):
        self.assertEqual(usage.collect('/no/such/path.jsonl'), [])


if __name__ == '__main__':
    unittest.main()

import unittest

from agentsessions.agents import opencode
from agentsessions.agents.codex import usage as codex_usage
from tests.agents.opencode_helpers import Fixture, make_db
from tests.agents.test_opencode_scan import S1, OpencodeCase


def tokens(inp, out, reasoning=0, read=0, write=0):
    return {'total': inp + out, 'input': inp, 'output': out, 'reasoning': reasoning,
            'cache': {'read': read, 'write': write}}


class TestUsage(OpencodeCase):
    def _turns(self):
        return opencode.collect_usage('opencode:' + S1)

    def test_no_database(self):
        self.assertEqual(self._turns(), [])

    def test_turns_split_at_user_messages(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1)
            f.user(S1, 'first question', 1_000)
            f.assistant(S1, '', 2_000, tokens=tokens(100, 10, 5, 200, 300), cost=0.5, tools=('read',),
                        finish='tool-calls')
            f.assistant(S1, 'ok', 3_000, tokens=tokens(50, 20, 0, 400, 0), cost=0.25, tools=('read', 'edit'))
            f.user(S1, 'second question', 4_000)
            f.assistant(S1, 'ok', 5_000, tokens=tokens(7, 3), cost=0.0)
        turns = self._turns()
        self.assertEqual([t['index'] for t in turns], [0, 1])
        t0, t1 = turns
        self.assertEqual(t0['prompt'], 'first question')
        self.assertEqual((t0['calls'], t0['input'], t0['output'], t0['thinking']), (2, 150, 30, 5))
        self.assertEqual((t0['cache_read'], t0['cache_create']), (600, 300))
        self.assertEqual(t0['cost'], 0.75)
        self.assertEqual(t0['tools'], {'read': 2, 'edit': 1})
        self.assertEqual(t0['context_last'], 450)
        self.assertEqual(t0['models'], {'ollama/gemma': 2})
        self.assertEqual(t0['ts'], 1.0)
        self.assertEqual(t0['last_ts'], 3.005)
        self.assertFalse(t0['unknown_cost'])
        self.assertEqual((t1['calls'], t1['input'], t1['cost']), (1, 7, 0.0))

    def test_assistant_before_any_user_message_rolls_into_before_first(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1)
            f.assistant(S1, 'hi', 500, tokens=tokens(5, 1))
            f.user(S1, 'q', 1_000)
        turns = self._turns()
        self.assertTrue(turns[0]['before_first'])
        self.assertEqual(turns[0]['input'], 5)
        self.assertEqual(turns[1]['prompt'], 'q')

    def test_missing_cost_is_unknown_not_free(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1)
            f.user(S1, 'q', 1_000)
            f.assistant(S1, 'a', 2_000, tokens=tokens(5, 1), cost=None)
        turns = self._turns()
        self.assertEqual((turns[0]['cost'], turns[0]['unpriced_calls']), (0.0, 1))
        summary = opencode.summarize_usage(turns)
        self.assertTrue(summary['total']['unknown_cost'])
        self.assertEqual(summary['total']['unpriced_calls'], 1)
        self.assertEqual(summary['total']['input'], 5)

    def test_replies_with_a_cost_still_count_next_to_one_without(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1)
            f.user(S1, 'q', 1_000)
            f.assistant(S1, '', 2_000, tokens=tokens(5, 1), cost=0.25, finish='tool-calls')
            f.assistant(S1, 'a', 3_000, tokens=tokens(5, 1), cost=None)
        turn = self._turns()[0]
        self.assertEqual((turn['calls'], turn['unpriced_calls']), (2, 1))
        self.assertEqual(turn['cost'], 0.25)

    def test_summarize_shape_matches_codex(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1)
            f.user(S1, 'q', 1_000)
            f.assistant(S1, 'a', 2_000, tokens=tokens(5, 1), cost=0.1)
        summary = opencode.summarize_usage(self._turns())
        self.assertEqual(set(summary), set(codex_usage.summarize([])))
        self.assertEqual(set(summary['total']), set(codex_usage.summarize([])['total']))
        self.assertAlmostEqual(summary['total']['cost'], 0.1)
        self.assertFalse(summary['total']['unknown_cost'])
        self.assertEqual(len(summary['turns']), 1)


if __name__ == '__main__':
    unittest.main()

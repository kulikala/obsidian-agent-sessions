import tempfile
import unittest

from agentsessions.agents.codex import stats
from agentsessions.usage.stats import FIVE_HOUR_SECONDS, SEVEN_DAY_SECONDS
from tests.agents.codex_helpers import (
    rollout_path, session_meta, token_count, turn_context, write_rollout,
)

ID1 = '06000000-0000-0000-0000-000000000001'
ID2 = '06000000-0000-0000-0000-000000000002'


def _iso(ts: float) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')


class TestClassify(unittest.TestCase):
    def test_five_hour_window_classified_regardless_of_slight_wobble(self):
        self.assertEqual(stats._classify(299), 'five_hour')
        self.assertEqual(stats._classify(300), 'five_hour')

    def test_seven_day_window_classified(self):
        self.assertEqual(stats._classify(10080), 'seven_day')
        self.assertEqual(stats._classify(10079), 'seven_day')

    def test_unrelated_window_matches_neither(self):
        # A real value seen on a free-tier Codex account: a ~30-day quota,
        # which doesn't fit this project's five_hour/seven_day shape at all.
        self.assertIsNone(stats._classify(43200))

    def test_missing_or_wrong_type_matches_neither(self):
        self.assertIsNone(stats._classify(None))
        self.assertIsNone(stats._classify('not a number'))


class TestWindowReading(unittest.TestCase):
    """The bug this guards against: Codex's rate_limits has two positional
    slots (primary/secondary) whose *meaning* isn't fixed -- real data shows
    the same account reporting a 5-hour window as `primary` in one rollout and
    a 7-day window as `primary` in another. Position must never be trusted."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        self.now = 1_700_100_000.0

    def test_five_hour_found_even_when_it_is_the_secondary_slot(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            token_count({'input_tokens': 1, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                        'output_tokens': 1}, '2026-09-24T01:30:31Z',
                        rate_limits={'primary': {'used_percent': 50.0, 'window_minutes': 10080,
                                                  'resets_at': self.now + SEVEN_DAY_SECONDS},
                                     'secondary': {'used_percent': 12.0, 'window_minutes': 300,
                                                   'resets_at': self.now + FIVE_HOUR_SECONDS}}),
        ])
        paths = [p]
        five_end, five_used = stats._window_bounds(paths, 'five_hour', FIVE_HOUR_SECONDS, self.now)
        self.assertEqual(five_used, 12.0)
        seven_end, seven_used = stats._window_bounds(paths, 'seven_day', SEVEN_DAY_SECONDS, self.now)
        self.assertEqual(seven_used, 50.0)

    def test_only_a_monthly_window_present_reports_both_as_unavailable(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            token_count({'input_tokens': 1, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                        'output_tokens': 1}, '2026-09-24T01:30:31Z',
                        rate_limits={'primary': {'used_percent': 8.0, 'window_minutes': 43200,
                                                  'resets_at': self.now + 1000}, 'secondary': None}),
        ])
        paths = [p]
        _, five_used = stats._window_bounds(paths, 'five_hour', FIVE_HOUR_SECONDS, self.now)
        _, seven_used = stats._window_bounds(paths, 'seven_day', SEVEN_DAY_SECONDS, self.now)
        self.assertIsNone(five_used)
        self.assertIsNone(seven_used)

    def test_no_rate_limits_anywhere_reports_unavailable_not_an_error(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [session_meta(ID1, '/work/one')])
        end, used = stats._window_bounds([p], 'five_hour', FIVE_HOUR_SECONDS, self.now)
        self.assertEqual(end, self.now)
        self.assertIsNone(used)

    def test_stale_resets_at_rolls_forward_and_used_percentage_becomes_unknown(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            token_count({'input_tokens': 1, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                        'output_tokens': 1}, '2026-09-24T01:30:31Z',
                        rate_limits={'primary': {'used_percent': 90.0, 'window_minutes': 300,
                                                  'resets_at': self.now - 10}, 'secondary': None}),
        ])
        end, used = stats._window_bounds([p], 'five_hour', FIVE_HOUR_SECONDS, self.now)
        self.assertGreaterEqual(end, self.now)
        self.assertIsNone(used)


class TestTokenAggregation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name

    def test_compute_places_usage_in_the_right_window_and_session(self):
        now = 1_700_100_000.0
        # resets_at == now, so five_end == now exactly -- inside_ts just needs
        # to land safely inside [five_end - 5h, five_end).
        inside_ts = _iso(now - FIVE_HOUR_SECONDS / 2)

        p = rollout_path(self.home, ID1, ts='2026-09-24T01-30-30')
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='gpt-5.6-terra'),
            token_count({'input_tokens': 1000, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                        'output_tokens': 100}, inside_ts,
                        rate_limits={'primary': {'used_percent': 10.0, 'window_minutes': 300,
                                                  'resets_at': now},
                                     'secondary': {'used_percent': 5.0, 'window_minutes': 10080,
                                                   'resets_at': now}}),
        ])
        out = stats.compute(now=now, home=self.home)
        five = out['windows']['five_hour']
        self.assertEqual(five['total']['input'], 1000)
        self.assertEqual(five['total']['output'], 100)
        self.assertIn(ID1, five['sessions'])
        self.assertGreater(five['total']['cost'], 0)

    def test_unknown_model_marks_unknown_cost_not_zero(self):
        now = 1_700_100_000.0
        p = rollout_path(self.home, ID1, ts='2026-09-24T01-30-30')
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='some-unpriced-future-model'),
            token_count({'input_tokens': 1000, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                        'output_tokens': 100}, _iso(now - 100),
                        rate_limits={'primary': {'used_percent': 10.0, 'window_minutes': 300,
                                                  'resets_at': now + 1000}}),
        ])
        out = stats.compute(now=now, home=self.home)
        self.assertTrue(out['windows']['five_hour']['total']['unknown_cost'])

    def test_sessions_outside_both_windows_are_excluded(self):
        now = 1_700_100_000.0
        long_ago = now - SEVEN_DAY_SECONDS - 10_000
        p = rollout_path(self.home, ID2, ts='2026-01-01T00-00-00')
        write_rollout(p, [
            session_meta(ID2, '/work/two'),
            turn_context(model='gpt-5.6-terra'),
            token_count({'input_tokens': 500, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                        'output_tokens': 50}, _iso(long_ago)),
        ])
        import os
        os.utime(p, (long_ago, long_ago))
        out = stats.compute(now=now, home=self.home)
        self.assertNotIn(ID2, out['windows']['seven_day']['sessions'])
        self.assertEqual(out['windows']['seven_day']['total']['calls'], 0)


if __name__ == '__main__':
    unittest.main()

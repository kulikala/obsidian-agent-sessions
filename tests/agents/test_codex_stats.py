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


class TestWindowDefs(unittest.TestCase):
    """The bug this guards against: Codex's rate_limits has two positional
    slots (primary/secondary) whose *meaning* isn't fixed -- real data shows
    the same account reporting a 5-hour window as `primary` in one rollout and
    a 7-day window as `primary` in another. Position must never be trusted.
    A window that isn't 5h or 7d (e.g. a monthly quota) must not be discarded
    either -- it's this account's actual current, real state."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        self.now = 1_700_100_000.0

    def _defs_by_key(self, paths):
        return {d['key']: d for d in stats._window_defs(paths, self.now)}

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
        defs = self._defs_by_key([p])
        self.assertEqual(defs['five_hour']['used_percentage'], 12.0)
        self.assertEqual(defs['five_hour']['minutes'], 300.0)
        self.assertEqual(defs['seven_day']['used_percentage'], 50.0)
        self.assertEqual(defs['seven_day']['minutes'], 10080.0)
        # only the two known kinds present -- nothing extra when both slots classify
        self.assertEqual(set(defs.keys()), {'five_hour', 'seven_day'})

    def test_monthly_window_is_surfaced_not_discarded(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            token_count({'input_tokens': 1, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                        'output_tokens': 1}, '2026-09-24T01:30:31Z',
                        rate_limits={'primary': {'used_percent': 8.0, 'window_minutes': 43200,
                                                  'resets_at': self.now + 1000}, 'secondary': None}),
        ])
        defs = self._defs_by_key([p])
        # five_hour/seven_day still always present, unavailable since this
        # account isn't tracking either right now
        self.assertIsNone(defs['five_hour']['used_percentage'])
        self.assertIsNone(defs['seven_day']['used_percentage'])
        # ...but the real 30-day window is surfaced, not dropped
        self.assertIn('window_43200m', defs)
        thirty_day = defs['window_43200m']
        self.assertEqual(thirty_day['used_percentage'], 8.0)
        self.assertEqual(thirty_day['minutes'], 43200.0)
        self.assertEqual(thirty_day['label_key'], 'window.30d')

    def test_non_day_aligned_window_gets_a_minutes_label_key(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            token_count({'input_tokens': 1, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                        'output_tokens': 1}, '2026-09-24T01:30:31Z',
                        rate_limits={'primary': {'used_percent': 3.0, 'window_minutes': 90,
                                                  'resets_at': self.now + 1000}, 'secondary': None}),
        ])
        defs = self._defs_by_key([p])
        self.assertIn('window_90m', defs)
        self.assertEqual(defs['window_90m']['label_key'], 'window.90m')

    def test_hour_aligned_window_gets_an_hours_label_key(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            token_count({'input_tokens': 1, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                        'output_tokens': 1}, '2026-09-24T01:30:31Z',
                        rate_limits={'primary': {'used_percent': 3.0, 'window_minutes': 120,
                                                  'resets_at': self.now + 1000}, 'secondary': None}),
        ])
        defs = self._defs_by_key([p])
        self.assertEqual(defs['window_120m']['label_key'], 'window.2h')

    def test_no_rate_limits_anywhere_reports_unavailable_not_an_error(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [session_meta(ID1, '/work/one')])
        defs = self._defs_by_key([p])
        self.assertEqual(defs['five_hour']['end'], self.now)
        self.assertIsNone(defs['five_hour']['used_percentage'])
        self.assertEqual(set(defs.keys()), {'five_hour', 'seven_day'})

    def test_stale_resets_at_rolls_forward_and_used_percentage_becomes_unknown(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            token_count({'input_tokens': 1, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                        'output_tokens': 1}, '2026-09-24T01:30:31Z',
                        rate_limits={'primary': {'used_percent': 90.0, 'window_minutes': 300,
                                                  'resets_at': self.now - 10}, 'secondary': None}),
        ])
        defs = self._defs_by_key([p])
        self.assertGreaterEqual(defs['five_hour']['end'], self.now)
        self.assertIsNone(defs['five_hour']['used_percentage'])

    def test_primary_and_secondary_from_an_older_snapshot_are_not_mixed_with_a_newer_one(self):
        # Two rollouts, different mtimes -- only the newest file's snapshot
        # should be used, never a merge across the two.
        import os
        old = rollout_path(self.home, ID1, ts='2026-01-01T00-00-00')
        write_rollout(old, [
            session_meta(ID1, '/work/one'),
            token_count({'input_tokens': 1, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                        'output_tokens': 1}, '2026-01-01T00:00:01Z',
                        rate_limits={'primary': {'used_percent': 99.0, 'window_minutes': 300,
                                                  'resets_at': self.now + 1000}, 'secondary': None}),
        ])
        new = rollout_path(self.home, ID2, ts='2026-09-24T01-30-30')
        write_rollout(new, [
            session_meta(ID2, '/work/two'),
            token_count({'input_tokens': 1, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                        'output_tokens': 1}, '2026-09-24T01:30:31Z',
                        rate_limits={'primary': {'used_percent': 1.0, 'window_minutes': 43200,
                                                  'resets_at': self.now + 1000}, 'secondary': None}),
        ])
        very_old = self.now - 10_000_000
        os.utime(old, (very_old, very_old))
        defs = self._defs_by_key([old, new])
        # the newest snapshot (43200m/1.0%) wins outright -- the older
        # five-hour reading (300m/99.0%) is not carried over
        self.assertIsNone(defs['five_hour']['used_percentage'])
        self.assertEqual(defs['window_43200m']['used_percentage'], 1.0)


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

    def test_compute_includes_a_non_5h_7d_window_with_its_own_totals(self):
        now = 1_700_100_000.0
        p = rollout_path(self.home, ID1, ts='2026-09-24T01-30-30')
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='gpt-5.6-terra'),
            token_count({'input_tokens': 1000, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                        'output_tokens': 100}, _iso(now - 1000),
                        rate_limits={'primary': {'used_percent': 8.0, 'window_minutes': 43200,
                                                  'resets_at': now}, 'secondary': None}),
        ])
        out = stats.compute(now=now, home=self.home)
        self.assertIn('window_43200m', out['windows'])
        thirty_day = out['windows']['window_43200m']
        self.assertEqual(thirty_day['key'], 'window_43200m')
        self.assertEqual(thirty_day['minutes'], 43200.0)
        self.assertEqual(thirty_day['label_key'], 'window.30d')
        self.assertEqual(thirty_day['total']['input'], 1000)
        self.assertIn(ID1, thirty_day['sessions'])
        # five_hour/seven_day still both present, just unavailable
        self.assertIsNone(out['windows']['five_hour']['used_percentage'])
        self.assertIsNone(out['windows']['seven_day']['used_percentage'])


if __name__ == '__main__':
    unittest.main()

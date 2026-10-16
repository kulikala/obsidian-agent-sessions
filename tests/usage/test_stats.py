import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

from agentsessions.usage import pricing, stats

ID1 = '11111111-1111-1111-1111-111111111111'
PARENT_ID = '22222222-2222-2222-2222-222222222222'


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')


def _assistant(ts, msg_id, model, tokens, **flags) -> dict:
    usage = {
        'input_tokens': tokens.get('input', 0),
        'cache_creation_input_tokens': tokens.get('cache_create', 0),
        'cache_read_input_tokens': tokens.get('cache_read', 0),
        'output_tokens': tokens.get('output', 0),
    }
    rec = {'type': 'assistant', 'timestamp': _iso(ts),
           'message': {'id': msg_id, 'model': model, 'usage': usage}}
    rec.update(flags)
    return rec


def _user(ts, text='a question') -> dict:
    return {'type': 'user', 'timestamp': _iso(ts), 'message': {'role': 'user', 'content': text}}


def _write(path, records) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')


def _append(path, records) -> None:
    with open(path, 'a', encoding='utf-8') as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')


def _cost(model, tokens) -> float:
    usage = {
        'input_tokens': tokens.get('input', 0),
        'cache_creation_input_tokens': tokens.get('cache_create', 0),
        'cache_read_input_tokens': tokens.get('cache_read', 0),
        'output_tokens': tokens.get('output', 0),
    }
    return pricing.cost(usage, model)


class StatsTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='agent-sessions-stats-')
        self.projects_dir = os.path.join(self.tmp, 'projects')
        self.proj = os.path.join(self.projects_dir, '-vault')
        os.makedirs(self.proj)
        self.status_dir = os.path.join(self.tmp, 'status')
        os.makedirs(self.status_dir)
        self.cache_path = os.path.join(self.tmp, 'stats-cache.json')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _status(self, name, rate_limits, mtime=None):
        p = os.path.join(self.status_dir, name)
        with open(p, 'w', encoding='utf-8') as f:
            json.dump({'session_id': 'x', 'rate_limits': rate_limits}, f)
        if mtime is not None:
            os.utime(p, (mtime, mtime))
        return p

    def compute(self, now):
        return stats.compute(now=now, projects_dir=self.projects_dir,
                              status_dir=self.status_dir, cache_path=self.cache_path)


class WindowsFromStatusTest(StatsTestBase):
    def test_no_status_files_has_no_readings(self):
        win = stats.windows_from_status(self.status_dir, 1_700_000_000.0)
        self.assertEqual(win, {'five_hour': None, 'seven_day': None})

    def test_reads_from_most_recent_file_with_rate_limits(self):
        now = 1_700_000_000.0
        self._status('old.json', {
            'five_hour': {'resets_at': 1_700_010_000, 'used_percentage': 1},
            'seven_day': {'resets_at': 1_700_020_000, 'used_percentage': 2},
        }, mtime=now - 100)
        self._status('new.json', {
            'five_hour': {'resets_at': 1_700_030_000, 'used_percentage': 9},
            'seven_day': {'resets_at': 1_700_040_000, 'used_percentage': 8},
        }, mtime=now - 10)
        # an even newer file that has no rate_limits (should be ignored)
        newest_no_rl = os.path.join(self.status_dir, 'newest.json')
        with open(newest_no_rl, 'w', encoding='utf-8') as f:
            json.dump({'session_id': 'x'}, f)
        os.utime(newest_no_rl, (now, now))

        win = stats.windows_from_status(self.status_dir, now)
        self.assertEqual(win['five_hour'], {'resets_at': 1_700_030_000, 'used_percentage': 9, 'as_of': now - 10})
        self.assertEqual(win['seven_day'], {'resets_at': 1_700_040_000, 'used_percentage': 8, 'as_of': now - 10})

    def test_each_window_comes_from_the_newest_file_that_has_it(self):
        """At a reset Claude Code drops the expired window, and idle sessions rewrite their files
        then: the newest file lacks the 5-hour window an older one still has."""
        now = 1_700_000_000.0
        self._status('active.json', {
            'five_hour': {'resets_at': now + 3600, 'used_percentage': 40},
            'seven_day': {'resets_at': now + 86400, 'used_percentage': 10},
        }, mtime=now - 120)
        self._status('idle.json', {
            'seven_day': {'resets_at': now + 86400, 'used_percentage': 11},
        }, mtime=now - 60)
        win = stats.windows_from_status(self.status_dir, now)
        self.assertEqual(win['five_hour']['used_percentage'], 40)
        self.assertEqual(win['five_hour']['as_of'], now - 120)
        self.assertEqual(win['seven_day']['used_percentage'], 11)

    def test_broken_status_file_is_skipped(self):
        now = 1_700_000_000.0
        p = os.path.join(self.status_dir, 'broken.json')
        with open(p, 'w', encoding='utf-8') as f:
            f.write('{not json')
        os.utime(p, (now, now))
        win = stats.windows_from_status(self.status_dir, now)
        self.assertIsNone(win['five_hour'])


class CurrentWindowTest(unittest.TestCase):
    NOW = 1_700_000_000.0

    def test_no_reading_ends_now_with_unknown_usage(self):
        w = stats.current_window(None, None, stats.FIVE_HOUR_SECONDS, self.NOW)
        self.assertEqual(w, {'end': self.NOW, 'used_percentage': None, 'source': None, 'as_of': None, 'stale': False})

    def test_a_live_reading_is_used_as_is(self):
        local = {'resets_at': self.NOW + 600, 'used_percentage': 30.0, 'as_of': self.NOW - 10}
        w = stats.current_window(local, None, stats.FIVE_HOUR_SECONDS, self.NOW)
        self.assertEqual((w['end'], w['used_percentage'], w['source'], w['stale']), (self.NOW + 600, 30.0, 'status', False))

    def test_resets_at_exactly_now_is_not_stale(self):
        local = {'resets_at': self.NOW, 'used_percentage': 10.0, 'as_of': self.NOW}
        w = stats.current_window(local, None, stats.FIVE_HOUR_SECONDS, self.NOW)
        self.assertEqual((w['end'], w['used_percentage'], w['stale']), (self.NOW, 10.0, False))

    def test_a_passed_reset_is_stale_with_unknown_usage(self):
        """Right after a reset, before a fresh reading: no leftover percentage, and `end` moves
        past now (by whole windows) instead of sticking at the old reset."""
        resets_at = self.NOW - 2 * stats.FIVE_HOUR_SECONDS - 100
        local = {'resets_at': resets_at, 'used_percentage': 99.0, 'as_of': resets_at - 60}
        w = stats.current_window(local, None, stats.FIVE_HOUR_SECONDS, self.NOW)
        self.assertTrue(w['stale'])
        self.assertIsNone(w['used_percentage'])
        self.assertEqual(w['end'], resets_at + 3 * stats.FIVE_HOUR_SECONDS)

    def test_the_newer_of_status_and_usage_wins(self):
        local = {'resets_at': self.NOW + 600, 'used_percentage': 5.0, 'as_of': self.NOW - 900}
        usage = {'resets_at': self.NOW + 900, 'used_percentage': 60.0, 'as_of': self.NOW - 30}
        w = stats.current_window(local, usage, stats.FIVE_HOUR_SECONDS, self.NOW)
        self.assertEqual((w['end'], w['used_percentage'], w['source'], w['as_of']), (self.NOW + 900, 60.0, 'usage', self.NOW - 30))
        local['as_of'] = self.NOW - 5
        w = stats.current_window(local, usage, stats.FIVE_HOUR_SECONDS, self.NOW)
        self.assertEqual((w['end'], w['used_percentage'], w['source']), (self.NOW + 600, 5.0, 'status'))


class NeedsUsageTest(unittest.TestCase):
    NOW = 1_700_000_000.0

    def _r(self, resets_in, age):
        return {'resets_at': self.NOW + resets_in, 'used_percentage': 1.0, 'as_of': self.NOW - age}

    def test_fresh_live_readings_need_nothing(self):
        self.assertFalse(stats.needs_usage({'five_hour': self._r(600, 10), 'seven_day': self._r(9999, 10)}, self.NOW))

    def test_missing_passed_or_old_readings_need_usage(self):
        fresh = self._r(9999, 10)
        self.assertTrue(stats.needs_usage({'five_hour': None, 'seven_day': fresh}, self.NOW))
        self.assertTrue(stats.needs_usage({'five_hour': self._r(-1, 10), 'seven_day': fresh}, self.NOW))
        self.assertTrue(stats.needs_usage({'five_hour': self._r(600, stats.STATUS_STALE_SECONDS), 'seven_day': fresh}, self.NOW))


class ComputeWithUsageTest(StatsTestBase):
    def setUp(self):
        super().setUp()
        self.usage_path = os.path.join(self.tmp, 'claude-usage.json')

    def _usage_stream(self, five_pct, five_reset, week_pct, week_reset):
        iso = lambda ts: datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        event = {'type': 'assistant', 'usage_report': {'rate_limits': {'limits': [
            {'kind': 'session', 'percent': five_pct, 'resets_at': iso(five_reset), 'scope': None},
            {'kind': 'weekly_all', 'percent': week_pct, 'resets_at': iso(week_reset), 'scope': None},
            {'kind': 'weekly_scoped', 'percent': 0, 'resets_at': iso(week_reset), 'scope': {'model': {}}},
        ]}}}
        return '{"type":"system","subtype":"init"}\n' + json.dumps(event) + '\n'

    def test_stale_status_files_are_replaced_by_usage(self):
        """Used elsewhere: the status files still show the window before the reset, `/usage`
        has the account's current one, and every number comes from `/usage`."""
        now = 1_700_000_000.0
        hit = now - 2 * 3600
        self._status('s.json', {
            'five_hour': {'resets_at': now - 600, 'used_percentage': 99},
            'seven_day': {'resets_at': now + 86400, 'used_percentage': 30},
        }, mtime=hit + 60)
        _write(os.path.join(self.proj, ID1 + '.jsonl'), [{
            'type': 'assistant', 'timestamp': _iso(hit), 'isApiErrorMessage': True, 'error': 'rate_limit',
            'message': {'content': [{'type': 'text', 'text': "You've hit your session limit · resets 7:10pm"}]},
        }])
        runs = []
        stream = self._usage_stream(40, now + 4 * 3600, 35, now + 86400)
        out = stats.compute(now, self.projects_dir, self.status_dir, self.cache_path,
                            usage_path=self.usage_path, usage_runner=lambda: runs.append(1) or stream)
        five = out['windows']['five_hour']
        self.assertEqual(len(runs), 1)
        self.assertEqual((five['used_percentage'], five['end'], five['start']), (40.0, now + 4 * 3600, now - 3600))
        self.assertEqual((five['source'], five['as_of'], five['stale'], five['exhausted']), ('usage', now, False, False))
        self.assertEqual(out['windows']['seven_day']['used_percentage'], 35.0)

    def test_usage_is_asked_at_most_once_per_interval(self):
        now = 1_700_000_000.0
        runs = []
        runner = lambda: runs.append(1) or ''
        for t in (now, now + 60, now + stats.claude_usage.MIN_INTERVAL_SECONDS):
            out = stats.compute(t, self.projects_dir, self.status_dir, self.cache_path,
                                usage_path=self.usage_path, usage_runner=runner)
        self.assertEqual(len(runs), 2)
        self.assertIsNone(out['windows']['five_hour']['used_percentage'])

    def test_fresh_status_files_do_not_ask_usage(self):
        now = 1_700_000_000.0
        self._status('s.json', {
            'five_hour': {'resets_at': now + 600, 'used_percentage': 3},
            'seven_day': {'resets_at': now + 86400, 'used_percentage': 4},
        }, mtime=now - 10)
        runs = []
        out = stats.compute(now, self.projects_dir, self.status_dir, self.cache_path,
                            usage_path=self.usage_path, usage_runner=lambda: runs.append(1) or '')
        self.assertEqual(runs, [])
        self.assertEqual(out['windows']['five_hour']['source'], 'status')

    def test_without_usage_path_usage_is_never_asked(self):
        out = self.compute(1_700_000_000.0)
        self.assertEqual(out['windows']['five_hour']['source'], None)
        self.assertFalse(os.path.exists(self.usage_path))


class WindowBucketingTest(StatsTestBase):
    """Covers bucketing records inside/outside the window, de-duplication, excluding
    <synthetic>, and counting sidechain calls, all together."""

    def setUp(self):
        super().setUp()
        self.five_end = 1_700_020_000.0
        self.seven_end = 1_700_100_000.0
        self._status('s.json', {
            'five_hour': {'resets_at': self.five_end, 'used_percentage': 42},
            'seven_day': {'resets_at': self.seven_end, 'used_percentage': 7},
        }, mtime=self.five_end)
        self.five_start = self.five_end - stats.FIVE_HOUR_SECONDS
        self.seven_start = self.seven_end - stats.SEVEN_DAY_SECONDS

        # A: inside both windows. Has a duplicate line (the second one isn't counted).
        self.ts_a = self.five_end - 100
        # B: outside the 5h window, inside the 7d window.
        self.ts_b = self.five_start - 100
        # C: outside both windows.
        self.ts_c = self.seven_start - 100
        # D: at or after the end of the 5h window (exclusive), inside the 7d window.
        # Placed more than one bucket (10 min) past the 5h end so it crosses the
        # bucket granularity boundary.
        self.ts_d = self.five_end + 700
        # F: a sidechain line. Inside the 5h window. Should be counted.
        self.ts_f = self.five_end - 60

        self.model = 'claude-sonnet-5'
        records = [
            _assistant(self.ts_a, 'm-a', self.model, {'input': 100, 'output': 50}),
            _assistant(self.ts_a, 'm-a', self.model, {'input': 100, 'output': 50}),  # duplicate
            _assistant(self.ts_b, 'm-b', self.model, {'input': 200, 'output': 80}),
            _assistant(self.ts_c, 'm-c', self.model, {'input': 999, 'output': 999}),
            _assistant(self.ts_d, 'm-d', self.model, {'input': 10, 'output': 10}),
            _assistant(self.ts_f, 'm-f', self.model, {'input': 5, 'output': 5}, isSidechain=True),
            _assistant(self.ts_a, 'm-e', '<synthetic>', {'input': 12345, 'output': 12345}),
            _user(self.ts_a),
        ]
        self.path = os.path.join(self.proj, ID1 + '.jsonl')
        _write(self.path, records)

    def test_five_hour_window(self):
        out = self.compute(now=self.five_end)
        five = out['windows']['five_hour']
        self.assertEqual(five['start'], self.five_start)
        self.assertEqual(five['end'], self.five_end)
        self.assertEqual(five['used_percentage'], 42)
        self.assertEqual(five['total']['calls'], 2)   # A (de-duplicated) and F
        self.assertEqual(five['total']['input'], 105)
        self.assertEqual(five['total']['output'], 55)
        expected_cost = _cost(self.model, {'input': 100, 'output': 50}) + \
            _cost(self.model, {'input': 5, 'output': 5})
        self.assertAlmostEqual(five['total']['cost'], expected_cost)
        self.assertEqual(five['sessions'][ID1]['calls'], 2)
        self.assertAlmostEqual(five['sessions'][ID1]['cost'], five['total']['cost'])

    def test_seven_day_window(self):
        out = self.compute(now=self.five_end)
        seven = out['windows']['seven_day']
        self.assertEqual(seven['start'], self.seven_start)
        self.assertEqual(seven['end'], self.seven_end)
        self.assertEqual(seven['used_percentage'], 7)
        # A (de-duplicated), B, D, F. C is outside the window.
        self.assertEqual(seven['total']['calls'], 4)
        self.assertEqual(seven['total']['input'], 100 + 200 + 10 + 5)
        self.assertEqual(seven['total']['output'], 50 + 80 + 10 + 5)
        self.assertEqual(seven['sessions'][ID1]['calls'], 4)
        self.assertAlmostEqual(seven['sessions'][ID1]['cost'], seven['total']['cost'])

    def test_window_total_equals_sum_of_sessions(self):
        out = self.compute(now=self.five_end)
        for key in ('five_hour', 'seven_day'):
            w = out['windows'][key]
            summed = {k: 0 for k in ('calls', 'input', 'output', 'cache_read', 'cache_create')}
            cost = 0.0
            for s in w['sessions'].values():
                for k in summed:
                    summed[k] += s[k]
                cost += s['cost']
            for k in summed:
                self.assertEqual(summed[k], w['total'][k])
            self.assertAlmostEqual(cost, w['total']['cost'])


class ResetRolloverComputeTest(StatsTestBase):
    """Even right after a reset has passed (before new rate_limits data arrives),
    aggregation only looks at the "current window" (start = the old end) — it must
    not carry over cost from the old window."""

    def test_cost_only_counts_activity_after_rolled_start(self):
        old_end = 1_700_000_000.0
        now = old_end + 60  # 1 minute after the reset; new rate_limits haven't arrived yet
        self._status('s.json', {
            'five_hour': {'resets_at': old_end, 'used_percentage': 88},
        }, mtime=old_end)

        model = 'claude-sonnet-5'
        # Usage from the old window (before the reset): must not be included in the new window.
        old_ts = old_end - 100
        _write(os.path.join(self.proj, ID1 + '.jsonl'),
               [_assistant(old_ts, 'm-old', model, {'input': 1000, 'output': 1000})])

        out = self.compute(now=now)
        five = out['windows']['five_hour']
        self.assertEqual(five['start'], old_end)
        self.assertEqual(five['end'], old_end + stats.FIVE_HOUR_SECONDS)
        self.assertIsNone(five['used_percentage'])
        self.assertEqual(five['total']['calls'], 0)
        self.assertEqual(five['total']['cost'], 0.0)
        self.assertEqual(five['sessions'], {})


class SubagentAggregationTest(StatsTestBase):
    def test_subagent_transcript_adds_to_parent_session(self):
        now = 1_700_020_000.0
        self._status('s.json', {
            'five_hour': {'resets_at': now, 'used_percentage': 1},
            'seven_day': {'resets_at': now, 'used_percentage': 1},
        }, mtime=now)
        ts = now - 100
        model = 'claude-sonnet-5'
        parent_path = os.path.join(self.proj, PARENT_ID + '.jsonl')
        _write(parent_path, [_assistant(ts, 'p-1', model, {'input': 100, 'output': 40})])

        # .jsonl files under <project>/<parent_id>/, at any depth, are aggregated into the parent
        sub_path = os.path.join(self.proj, PARENT_ID, 'subagents', 'agent-xyz.jsonl')
        _write(sub_path, [_assistant(ts, 's-1', model, {'input': 30, 'output': 10})])

        out = self.compute(now=now)
        five = out['windows']['five_hour']
        self.assertNotIn('agent-xyz', five['sessions'])
        self.assertEqual(list(five['sessions'].keys()), [PARENT_ID])
        self.assertEqual(five['sessions'][PARENT_ID]['calls'], 2)
        self.assertEqual(five['sessions'][PARENT_ID]['input'], 130)
        self.assertEqual(five['sessions'][PARENT_ID]['output'], 50)
        self.assertEqual(five['total']['calls'], 2)


class DedupTest(StatsTestBase):
    def setUp(self):
        super().setUp()
        self.now = 1_700_020_000.0
        self._status('s.json', {
            'five_hour': {'resets_at': self.now, 'used_percentage': 1},
            'seven_day': {'resets_at': self.now, 'used_percentage': 1},
        }, mtime=self.now)
        self.ts = self.now - 100
        self.model = 'claude-sonnet-5'

    def test_last_line_of_a_message_id_wins(self):
        path = os.path.join(self.proj, ID1 + '.jsonl')
        _write(path, [
            _assistant(self.ts, 'm1', self.model, {'input': 100, 'output': 3}),
            _assistant(self.ts + 1, 'm1', self.model, {'input': 100, 'output': 500}),
        ])
        five = self.compute(now=self.now)['windows']['five_hour']
        self.assertEqual(five['total']['calls'], 1)
        self.assertEqual(five['total']['output'], 500)   # replaced, not 503
        self.assertEqual(five['total']['input'], 100)

    def test_last_line_wins_across_incremental_reads(self):
        path = os.path.join(self.proj, ID1 + '.jsonl')
        _write(path, [_assistant(self.ts, 'm1', self.model, {'input': 100, 'output': 3})])
        self.compute(now=self.now)
        _append(path, [_assistant(self.ts + 1, 'm1', self.model, {'input': 100, 'output': 500})])
        five = self.compute(now=self.now)['windows']['five_hour']
        self.assertEqual((five['total']['calls'], five['total']['output']), (1, 500))

    def test_same_id_in_parent_and_subagent_file_is_counted_once(self):
        _write(os.path.join(self.proj, PARENT_ID + '.jsonl'), [
            _assistant(self.ts, 'shared', self.model, {'input': 100, 'output': 40}),
            _assistant(self.ts + 5, 'p-only', self.model, {'input': 1, 'output': 1}),
        ])
        # a forked sub-agent copies the parent's history, with the partial first line
        _write(os.path.join(self.proj, PARENT_ID, 'subagents', 'agent-x.jsonl'), [
            _assistant(self.ts, 'shared', self.model, {'input': 100, 'output': 7}),
            _assistant(self.ts + 9, 's-only', self.model, {'input': 2, 'output': 2}),
        ])
        five = self.compute(now=self.now)['windows']['five_hour']
        self.assertEqual(five['total']['calls'], 3)
        self.assertEqual(five['total']['output'], 40 + 1 + 2)   # the larger (final) copy of 'shared'
        self.assertEqual(five['sessions'][PARENT_ID]['calls'], 3)

    def test_lines_without_an_id_in_different_files_are_all_counted(self):
        for sid in (ID1, PARENT_ID):
            _write(os.path.join(self.proj, sid + '.jsonl'),
                   [_assistant(self.ts, None, self.model, {'input': 10, 'output': 5})])
        five = self.compute(now=self.now)['windows']['five_hour']
        self.assertEqual(five['total']['calls'], 2)


class IncrementalCacheTest(StatsTestBase):
    def setUp(self):
        super().setUp()
        # The window isn't used in this test (any value for `now` is fine).
        self.now = 1_700_000_000.0
        self.model = 'claude-sonnet-5'
        self.path = os.path.join(self.proj, ID1 + '.jsonl')
        self.ts1 = 1_699_000_000.0
        _write(self.path, [_assistant(self.ts1, 'm1', self.model, {'input': 10, 'output': 5})])

    def test_second_run_without_changes_does_not_reopen_transcript(self):
        self.compute(now=self.now)

        real_open = open

        def _guard(path, *a, **kw):
            if os.path.abspath(path) == os.path.abspath(self.path):
                raise AssertionError('unchanged transcript was reopened')
            return real_open(path, *a, **kw)

        with mock.patch('builtins.open', side_effect=_guard):
            self.compute(now=self.now)

    def test_append_continues_from_offset_without_rereading(self):
        self.compute(now=self.now)
        cache = stats.load_cache(self.cache_path)
        bucket_key_1 = stats._bucket_key(self.ts1)
        self.assertEqual(cache[self.path]['calls']['m1'][0], bucket_key_1)

        # Tamper with the existing record: if the next run re-read from the start,
        # it would revert to the original value (input=10). The tampered value
        # surviving proves that only the appended part was read, from the saved offset.
        cache[self.path]['calls']['m1'][1] = 999
        stats.save_cache(cache, self.cache_path)

        # Append a new line at a timestamp that falls in a different bucket (more than 10 minutes away).
        ts2 = self.ts1 + 700
        _append(self.path, [_assistant(ts2, 'm2', self.model, {'input': 20, 'output': 8})])

        self.compute(now=self.now)
        cache2 = stats.load_cache(self.cache_path)
        calls = cache2[self.path]['calls']
        bucket_key_2 = stats._bucket_key(ts2)
        self.assertNotEqual(bucket_key_1, bucket_key_2)
        self.assertEqual(calls['m1'][1], 999)            # tampered value survives == not re-read
        self.assertEqual(calls['m2'][0], bucket_key_2)   # only the appended line was newly added
        self.assertEqual(cache2[self.path]['offset'], os.path.getsize(self.path))

    def test_truncated_file_is_reread_from_scratch(self):
        self.compute(now=self.now)
        # File shrinks (not expected in practice, but treated as a corruption case) → re-read from offset 0.
        _write(self.path, [])
        out = self.compute(now=self.now)
        cache = stats.load_cache(self.cache_path)
        self.assertEqual(cache[self.path]['offset'], 0)
        self.assertEqual(cache[self.path]['calls'], {})

    def test_corrupted_cache_file_is_discarded(self):
        with open(self.cache_path, 'w', encoding='utf-8') as f:
            f.write('not json at all')
        out = self.compute(now=self.now)
        # Even though it's corrupted, no exception is raised and aggregation proceeds normally.
        cache = stats.load_cache(self.cache_path)
        self.assertIn(self.path, cache)
        self.assertEqual(cache[self.path]['offset'], os.path.getsize(self.path))

    def test_stale_schema_version_forces_a_full_reread_not_incremental(self):
        """An upgrade that changes how a bucket is computed must not layer new
        buckets on top of buckets computed by the old logic just because
        offset/mtime/size still look consistent -- see STATS_SCHEMA_VERSION."""
        self.compute(now=self.now)
        cache = stats.load_cache(self.cache_path)
        self.assertEqual(cache[self.path]['schema_version'], stats.STATS_SCHEMA_VERSION)
        bucket_key_1 = stats._bucket_key(self.ts1)
        # Tamper with both the bucket (to prove it gets discarded, not reused)
        # and the schema_version (to simulate an old, pre-upgrade cache entry).
        cache[self.path]['calls']['m1'][1] = 999
        cache[self.path]['schema_version'] = stats.STATS_SCHEMA_VERSION - 1
        stats.save_cache(cache, self.cache_path)

        self.compute(now=self.now)
        cache2 = stats.load_cache(self.cache_path)
        self.assertEqual(cache2[self.path]['schema_version'], stats.STATS_SCHEMA_VERSION)
        self.assertEqual(cache2[self.path]['calls']['m1'][1], 10)   # not 999: fully re-read

    def test_corrupted_entry_for_one_file_is_reread(self):
        self.compute(now=self.now)
        cache = stats.load_cache(self.cache_path)
        cache[self.path] = {'offset': 'not-an-int', 'garbage': True}
        stats.save_cache(cache, self.cache_path)
        out = self.compute(now=self.now)
        cache2 = stats.load_cache(self.cache_path)
        self.assertEqual(cache2[self.path]['offset'], os.path.getsize(self.path))
        self.assertEqual(cache2[self.path]['calls']['m1'][0], stats._bucket_key(self.ts1))


def _limit_error(ts, text) -> dict:
    """Claude Code's synthetic line for a request rejected by a usage limit."""
    return {'type': 'assistant', 'timestamp': _iso(ts), 'error': 'rate_limit',
            'isApiErrorMessage': True, 'apiErrorStatus': 429,
            'message': {'id': 'synthetic-%s' % ts, 'model': '<synthetic>', 'role': 'assistant',
                        'usage': {'input_tokens': 0, 'output_tokens': 0},
                        'content': [{'type': 'text', 'text': text}]}}


class LimitHitKeysTest(unittest.TestCase):
    def test_session_and_weekly_wording(self):
        self.assertEqual(stats.limit_hit_keys(_limit_error(1.0, "You've hit your session limit · resets 2:50pm (Asia/Tokyo)")),
                         ['five_hour'])
        self.assertEqual(stats.limit_hit_keys(_limit_error(1.0, "You've hit your weekly limit · resets Sep 3 at 1am (Asia/Tokyo)")),
                         ['seven_day'])
        self.assertEqual(stats.limit_hit_keys(_limit_error(1.0, "You've hit your monthly spend limit · raise it at "
                                                                 "claude.ai/settings/usage · your weekly limit resets Sep 3 at 1am")),
                         ['seven_day'])

    def test_other_lines_are_not_hits(self):
        self.assertEqual(stats.limit_hit_keys(_limit_error(1.0, "You've hit your monthly spend limit · raise it at claude.ai")), [])
        self.assertEqual(stats.limit_hit_keys(_limit_error(
            1.0, 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited')), [])
        not_error = _limit_error(1.0, "You've hit your session limit · resets 2pm")
        del not_error['isApiErrorMessage']
        self.assertEqual(stats.limit_hit_keys(not_error), [])
        self.assertEqual(stats.limit_hit_keys(_user(1.0, "You've hit your session limit")), [])


class ExhaustionTest(unittest.TestCase):
    def test_earliest_hit_inside_the_window(self):
        self.assertEqual(stats.exhaustion(99, [50.0, 30.0, 5.0, 100.0], 10.0, 100.0), (True, 30.0))

    def test_hits_outside_the_window_do_not_count(self):
        self.assertEqual(stats.exhaustion(99, [5.0, 100.0], 10.0, 100.0), (False, None))

    def test_percentage_alone_is_exhausted_without_a_time(self):
        self.assertEqual(stats.exhaustion(100, [], 10.0, 100.0), (True, None))
        self.assertEqual(stats.exhaustion(99.9, [], 10.0, 100.0), (False, None))
        self.assertEqual(stats.exhaustion(None, [], 10.0, 100.0), (False, None))

    def test_with_exhaustion_reports_100_percent(self):
        w = stats.with_exhaustion({'start': 10.0, 'end': 100.0, 'used_percentage': 99}, [40.0])
        self.assertEqual((w['used_percentage'], w['exhausted'], w['exhausted_at']), (100.0, True, 40.0))
        w = stats.with_exhaustion({'start': 10.0, 'end': 100.0, 'used_percentage': 42}, [])
        self.assertEqual((w['used_percentage'], w['exhausted'], w['exhausted_at']), (42, False, None))


class ExhaustedComputeTest(StatsTestBase):
    def test_session_limit_line_exhausts_only_the_five_hour_window(self):
        now = 1_700_020_000.0
        five_end = now + 3600
        self._status('s.json', {
            'five_hour': {'resets_at': five_end, 'used_percentage': 99},
            'seven_day': {'resets_at': now + 86400, 'used_percentage': 40},
        })
        hit = now - 600
        _write(os.path.join(self.proj, ID1 + '.jsonl'), [
            _assistant(hit - 60, 'm1', 'claude-sonnet-5', {'input': 10, 'output': 10}),
            _limit_error(hit, "You've hit your session limit · resets 3pm (Asia/Tokyo)"),
            _limit_error(hit + 120, "You've hit your session limit · resets 3pm (Asia/Tokyo)"),
        ])
        out = self.compute(now=now)
        five, seven = out['windows']['five_hour'], out['windows']['seven_day']
        self.assertEqual((five['used_percentage'], five['exhausted'], five['exhausted_at']), (100.0, True, hit))
        self.assertEqual((seven['used_percentage'], seven['exhausted'], seven['exhausted_at']), (40, False, None))
        # The rejected lines aren't calls.
        self.assertEqual(five['total']['calls'], 1)

    def test_hit_before_the_current_window_does_not_count(self):
        now = 1_700_020_000.0
        five_end = now + 3600
        self._status('s.json', {'five_hour': {'resets_at': five_end, 'used_percentage': 3}})
        _write(os.path.join(self.proj, ID1 + '.jsonl'), [
            _limit_error(five_end - stats.FIVE_HOUR_SECONDS - 60, "You've hit your session limit · resets 3pm"),
        ])
        five = self.compute(now=now)['windows']['five_hour']
        self.assertEqual((five['used_percentage'], five['exhausted']), (3, False))

    def test_hits_survive_the_incremental_cache(self):
        now = 1_700_020_000.0
        self._status('s.json', {'seven_day': {'resets_at': now + 86400, 'used_percentage': 98}})
        path = os.path.join(self.proj, ID1 + '.jsonl')
        _write(path, [_limit_error(now - 300, "You've hit your weekly limit · resets Sep 3 at 1am")])
        self.compute(now=now)
        _append(path, [_user(now - 100)])
        seven = self.compute(now=now)['windows']['seven_day']
        self.assertEqual((seven['exhausted'], seven['exhausted_at']), (True, now - 300))


if __name__ == '__main__':
    unittest.main()

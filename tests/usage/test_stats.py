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
    def test_no_status_files_defaults_to_now_and_none(self):
        now = 1_700_000_000.0
        win = stats.windows_from_status(self.status_dir, now)
        for key in ('five_hour', 'seven_day'):
            self.assertEqual(win[key]['end'], now)
            self.assertIsNone(win[key]['used_percentage'])

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
        self.assertEqual(win['five_hour']['end'], 1_700_030_000)
        self.assertEqual(win['five_hour']['used_percentage'], 9)
        self.assertEqual(win['seven_day']['end'], 1_700_040_000)
        self.assertEqual(win['seven_day']['used_percentage'], 8)

    def test_missing_individual_window_defaults_independently(self):
        now = 1_700_000_000.0
        self._status('s.json', {
            'seven_day': {'resets_at': 1_700_050_000, 'used_percentage': 3},
        }, mtime=now)
        win = stats.windows_from_status(self.status_dir, now)
        self.assertEqual(win['five_hour']['end'], now)
        self.assertIsNone(win['five_hour']['used_percentage'])
        self.assertEqual(win['seven_day']['end'], 1_700_050_000)
        self.assertEqual(win['seven_day']['used_percentage'], 3)

    def test_broken_status_file_is_skipped(self):
        now = 1_700_000_000.0
        p = os.path.join(self.status_dir, 'broken.json')
        with open(p, 'w', encoding='utf-8') as f:
            f.write('{not json')
        os.utime(p, (now, now))
        win = stats.windows_from_status(self.status_dir, now)
        self.assertEqual(win['five_hour']['end'], now)
        self.assertIsNone(win['five_hour']['used_percentage'])

    def test_resets_at_just_past_rolls_forward_one_period(self):
        """Right after a reset has passed, but before a fresh rate_limits payload arrives,
        the window must not stay stuck in the past (with `end` still before now) — it
        should roll forward by exactly one period, with usage marked unknown."""
        now = 1_700_000_000.0
        resets_at = now - 60  # the reset happened 1 minute ago
        self._status('s.json', {
            'five_hour': {'resets_at': resets_at, 'used_percentage': 42},
            'seven_day': {'resets_at': resets_at, 'used_percentage': 77},
        }, mtime=now)
        win = stats.windows_from_status(self.status_dir, now)
        self.assertEqual(win['five_hour']['end'], resets_at + stats.FIVE_HOUR_SECONDS)
        self.assertIsNone(win['five_hour']['used_percentage'])
        self.assertEqual(win['seven_day']['end'], resets_at + stats.SEVEN_DAY_SECONDS)
        self.assertIsNone(win['seven_day']['used_percentage'])

    def test_resets_at_far_in_past_rolls_forward_multiple_periods(self):
        now = 1_700_000_000.0
        resets_at = now - 2 * stats.FIVE_HOUR_SECONDS - 100
        self._status('s.json', {
            'five_hour': {'resets_at': resets_at, 'used_percentage': 50},
        }, mtime=now)
        win = stats.windows_from_status(self.status_dir, now)
        # 2 full periods plus a 100-second remainder → roll forward 3 periods.
        self.assertEqual(win['five_hour']['end'], resets_at + 3 * stats.FIVE_HOUR_SECONDS)
        self.assertGreaterEqual(win['five_hour']['end'], now)
        self.assertIsNone(win['five_hour']['used_percentage'])

    def test_resets_at_exactly_now_does_not_roll(self):
        now = 1_700_000_000.0
        self._status('s.json', {
            'five_hour': {'resets_at': now, 'used_percentage': 10},
        }, mtime=now)
        win = stats.windows_from_status(self.status_dir, now)
        self.assertEqual(win['five_hour']['end'], now)
        self.assertEqual(win['five_hour']['used_percentage'], 10)


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
        self.assertEqual(cache[self.path]['buckets'][str(bucket_key_1)]['calls'], 1)

        # Tamper with the existing bucket: if the next run re-read from the start,
        # it would revert to the original value (calls=1). The tampered value
        # surviving proves that only the appended part was read, from the saved offset.
        cache[self.path]['buckets'][str(bucket_key_1)]['calls'] = 999
        stats.save_cache(cache, self.cache_path)

        # Append a new line at a timestamp that falls in a different bucket (more than 10 minutes away).
        ts2 = self.ts1 + 700
        _append(self.path, [_assistant(ts2, 'm2', self.model, {'input': 20, 'output': 8})])

        self.compute(now=self.now)
        cache2 = stats.load_cache(self.cache_path)
        buckets = cache2[self.path]['buckets']
        bucket_key_2 = stats._bucket_key(ts2)
        self.assertNotEqual(bucket_key_1, bucket_key_2)
        self.assertEqual(buckets[str(bucket_key_1)]['calls'], 999)   # tampered value survives == not re-read
        self.assertEqual(buckets[str(bucket_key_2)]['calls'], 1)     # only the appended line was newly added
        self.assertEqual(cache2[self.path]['offset'], os.path.getsize(self.path))

    def test_truncated_file_is_reread_from_scratch(self):
        self.compute(now=self.now)
        # File shrinks (not expected in practice, but treated as a corruption case) → re-read from offset 0.
        _write(self.path, [])
        out = self.compute(now=self.now)
        cache = stats.load_cache(self.cache_path)
        self.assertEqual(cache[self.path]['offset'], 0)
        self.assertEqual(cache[self.path]['buckets'], {})

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
        cache[self.path]['buckets'][str(bucket_key_1)]['calls'] = 999
        cache[self.path]['schema_version'] = stats.STATS_SCHEMA_VERSION - 1
        stats.save_cache(cache, self.cache_path)

        self.compute(now=self.now)
        cache2 = stats.load_cache(self.cache_path)
        self.assertEqual(cache2[self.path]['schema_version'], stats.STATS_SCHEMA_VERSION)
        self.assertEqual(cache2[self.path]['buckets'][str(bucket_key_1)]['calls'], 1)   # not 999: fully re-read

    def test_corrupted_entry_for_one_file_is_reread(self):
        self.compute(now=self.now)
        cache = stats.load_cache(self.cache_path)
        cache[self.path] = {'offset': 'not-an-int', 'garbage': True}
        stats.save_cache(cache, self.cache_path)
        out = self.compute(now=self.now)
        cache2 = stats.load_cache(self.cache_path)
        self.assertEqual(cache2[self.path]['offset'], os.path.getsize(self.path))
        bucket_key_1 = stats._bucket_key(self.ts1)
        self.assertEqual(cache2[self.path]['buckets'][str(bucket_key_1)]['calls'], 1)


if __name__ == '__main__':
    unittest.main()

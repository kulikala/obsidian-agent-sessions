import unittest
from unittest import mock

from agentsessions.efficiency import cache


class ShrinkTest(unittest.TestCase):
    def record(self):
        calls = [{'id': 'm%d' % i, 'ts': 1200.0 + i * 60, 'in': 1, 'cr': 10, 'cw': 2, 'cw1h': 2, 'out': 3,
                  'th': 0, 'vis': 1, 'ctx': 13 + i, 'text_off': i,
                  'tools': [{'n': 'Read', 'k': 'read', 'p': 'a.py', 'id': 't%d' % i, 'off': i, 'chars': 9}],
                  'edits': []} for i in range(30)]
        return {'calls': calls, 'results': [{'est': 5}, {'est': 5000}]}

    def test_small_records_are_kept(self):
        rec = self.record()
        self.assertIs(cache.shrink(rec), rec)

    def test_large_records_are_merged_into_ten_minute_buckets(self):
        with mock.patch.object(cache, 'MAX_RECORD_BYTES', 100):
            out = cache.shrink(self.record())
        self.assertTrue(out['coarse'])
        self.assertEqual(len(out['calls']), 3)            # 30 calls a minute apart, 10-minute buckets
        self.assertEqual(sum(c['cr'] for c in out['calls']), 300)
        self.assertEqual(out['calls'][0]['ctx'], 13 + 9)
        self.assertNotIn('off', out['calls'][0]['tools'][0])
        self.assertEqual(out['results'], [{'est': 5000}])


if __name__ == '__main__':
    unittest.main()

import unittest

from agentsessions.sessions import activity


class TestSpansFromTimes(unittest.TestCase):
    def test_gap_splits_spans(self):
        # 10:00, 10:10, 10:20 | (40 min) | 11:00
        times = [0, 600, 1200, 3600]
        self.assertEqual(activity.spans_from_times(times, gap=1800),
                         [[0, 1200], [3600, 3660]])

    def test_gap_is_inclusive(self):
        # exactly 30 minutes apart starts a new span
        self.assertEqual(activity.spans_from_times([0, 1800, 1860], gap=1800),
                         [[0, 60], [1800, 1860]])

    def test_short_span_is_extended_to_one_minute(self):
        self.assertEqual(activity.spans_from_times([100.0], gap=1800), [[100.0, 160.0]])
        self.assertEqual(activity.spans_from_times([100.0, 130.0], gap=1800), [[100.0, 160.0]])

    def test_unsorted_and_empty(self):
        self.assertEqual(activity.spans_from_times([1200, 0, 600], gap=1800), [[0, 1200]])
        self.assertEqual(activity.spans_from_times([]), [])


class TestClipSpans(unittest.TestCase):
    def test_clip(self):
        spans = [[0, 100], [150, 250], [300, 400]]
        self.assertEqual(activity.clip_spans(spans, 50, 200), [[50, 100], [150, 200]])

    def test_drops_empty(self):
        self.assertEqual(activity.clip_spans([[0, 100]], 100, 200), [])


class TestClaudeTimes(unittest.TestCase):
    def test_reads_user_and_assistant_lines_only(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'a.jsonl')
            with open(p, 'w') as f:
                f.write('{"type":"user","timestamp":"2026-09-24T01:00:00.000Z"}\n')
                f.write('{"type":"assistant","timestamp":"2026-09-24T01:00:30Z"}\n')
                f.write('{"type":"system","timestamp":"2026-09-24T05:00:00Z"}\n')
                f.write('not json {"type":"user"}\n')
            got = activity.claude_times(p)
        self.assertEqual(len(got), 2)
        self.assertEqual(got[1] - got[0], 30)
        self.assertEqual(activity.claude_times('/nonexistent/x.jsonl'), [])


if __name__ == '__main__':
    unittest.main()

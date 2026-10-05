import json
import os
import tempfile
import unittest

from agentsessions.sessions import activity


class TestJoinTurns(unittest.TestCase):
    def test_joins_turns_closer_than_the_gap(self):
        # turn ends 600, next prompt at 1200 (gap 600 < 1800): one block
        self.assertEqual(activity.join_turns([[0, 600], [1200, 1500]], gap=1800), [[0, 1500]])

    def test_gap_is_exclusive_of_the_limit(self):
        # exactly the gap apart starts a new block
        self.assertEqual(activity.join_turns([[0, 600], [2400, 2700]], gap=1800), [[0, 600], [2400, 2700]])

    def test_short_block_is_extended_to_one_minute(self):
        self.assertEqual(activity.join_turns([[100.0, 100.0]]), [[100.0, 160.0]])
        self.assertEqual(activity.join_turns([[100.0, 130.0]]), [[100.0, 160.0]])

    def test_unsorted_overlapping_and_empty(self):
        self.assertEqual(activity.join_turns([[1200, 1500], [0, 1300]], gap=1800), [[0, 1500]])
        self.assertEqual(activity.join_turns([]), [])


class TestExtendIfLive(unittest.TestCase):
    def test_a_turn_still_being_written_ends_now(self):
        self.assertEqual(activity.extend_if_live([[0, 100], [500, 990]], now=1000), [[0, 100], [500, 1000]])

    def test_a_finished_turn_is_left_alone(self):
        turns = [[0, 100], [500, 600]]
        self.assertEqual(activity.extend_if_live(turns, now=5000), turns)
        self.assertEqual(activity.extend_if_live([], now=1), [])


class TestClipSpans(unittest.TestCase):
    def test_clip(self):
        self.assertEqual(activity.clip_spans([[0, 100], [150, 250], [300, 400]], 50, 200), [[50, 100], [150, 200]])

    def test_drops_empty(self):
        self.assertEqual(activity.clip_spans([[0, 100]], 100, 200), [])


class TestTurnBuilder(unittest.TestCase):
    def test_activity_before_any_prompt_is_ignored_when_a_prompt_follows(self):
        b = activity.TurnBuilder()
        b.activity(1)
        b.prompt(10)
        b.activity(20)
        self.assertEqual(b.finish(), [[10, 20]])

    def test_a_transcript_with_no_prompt_is_one_turn(self):
        b = activity.TurnBuilder()
        b.activity(5)
        b.activity(9)
        self.assertEqual(b.finish(), [[5, 9]])


def line(kind, hms, **extra):
    d = {'type': kind, 'timestamp': '2026-09-24T%s.000Z' % hms}
    d.update(extra)
    return json.dumps(d, separators=(',', ':'))


def write(path, lines):
    with open(path, 'w') as f:
        f.write('\n'.join(lines) + '\n')


def epoch(hms):
    return activity.parse_utc('2026-09-24T' + hms)


class TestClaudeTurns(unittest.TestCase):
    def turns(self, lines):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'a.jsonl')
            write(p, lines)
            return activity.claude_turns(p)

    def test_turn_runs_from_the_prompt_to_the_last_agent_record(self):
        got = self.turns([
            line('user', '01:00:00', message={'role': 'user', 'content': 'do it'}),
            line('assistant', '01:00:30', message={'role': 'assistant', 'content': [{'type': 'tool_use', 'name': 'Bash'}]}),
            # a tool result is the agent still working, not a new prompt
            line('user', '01:03:00', message={'role': 'user', 'content': [{'type': 'tool_result', 'content': 'ok'}]}),
            line('assistant', '01:04:00', message={'role': 'assistant', 'content': [{'type': 'text', 'text': 'done'}]}),
            line('user', '01:30:00', message={'role': 'user', 'content': [{'type': 'text', 'text': 'next'}]}),
            line('assistant', '01:31:00', message={'role': 'assistant', 'content': 'ok'}),
        ])
        self.assertEqual(got, [[epoch('01:00:00'), epoch('01:04:00')], [epoch('01:30:00'), epoch('01:31:00')]])

    def test_meta_sidechain_and_command_output_do_not_start_turns(self):
        got = self.turns([
            line('user', '01:00:00', message={'role': 'user', 'content': 'go'}),
            line('user', '01:01:00', isMeta=True, message={'role': 'user', 'content': 'meta text'}),
            line('user', '01:02:00', isSidechain=True, message={'role': 'user', 'content': 'sub-agent prompt'}),
            line('user', '01:03:00', message={'role': 'user', 'content': '<local-command-stdout>x</local-command-stdout>'}),
            line('system', '05:00:00'),
        ])
        self.assertEqual(got, [[epoch('01:00:00'), epoch('01:03:00')]])

    def test_a_task_notification_wakes_the_agent_and_starts_a_turn(self):
        got = self.turns([
            line('user', '01:00:00', message={'role': 'user', 'content': 'go'}),
            line('assistant', '01:01:00', message={'role': 'assistant', 'content': 'started'}),
            line('user', '03:00:00', message={'role': 'user', 'content': '<task-notification>done</task-notification>'}),
            line('assistant', '03:01:00', message={'role': 'assistant', 'content': 'handled'}),
        ])
        self.assertEqual(got, [[epoch('01:00:00'), epoch('01:01:00')], [epoch('03:00:00'), epoch('03:01:00')]])

    def test_unreadable_file(self):
        self.assertEqual(activity.claude_turns('/nonexistent/x.jsonl'), [])


class TestCache(unittest.TestCase):
    def test_hit_miss_and_invalidation(self):
        c = {}
        calls = []

        def compute():
            calls.append(1)
            return [[1.0, 2.0]]

        self.assertEqual(activity.cached_turns(c, 'p', 10, 5.0, compute), [[1.0, 2.0]])
        self.assertEqual(activity.cached_turns(c, 'p', 10, 5.0, compute), [[1.0, 2.0]])
        self.assertEqual(len(calls), 1)                                   # hit
        activity.cached_turns(c, 'p', 11, 5.0, compute)                   # size changed
        activity.cached_turns(c, 'p', 11, 6.0, compute)                   # mtime changed
        self.assertEqual(len(calls), 3)
        activity.cached_turns(c, 'p', 11, 6.0, compute, trust=False)      # racy: never trusted
        self.assertEqual(len(calls), 4)
        c['p']['version'] = activity.ACTIVITY_VERSION + 1                  # another algorithm version
        activity.cached_turns(c, 'p', 11, 6.0, compute)
        self.assertEqual(len(calls), 5)

    def test_round_trip_on_disk(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'activity-cache.json')
            self.assertEqual(activity.load_cache(path), {})
            c = {'p': {'version': activity.ACTIVITY_VERSION, 'size': 1, 'mtime': 2.0, 'turns': [[1, 2]]}}
            activity.save_cache(c, path)
            self.assertEqual(activity.load_cache(path), c)


if __name__ == '__main__':
    unittest.main()

import json
import os
import tempfile
import unittest

from agentsessions.sessions import activity


def turn(start, end, prompt='p', kind='prompt'):
    return [start, end, prompt, kind]


def tdict(start, end, prompt='p', kind='prompt'):
    return {'start': start, 'end': end, 'prompt': prompt, 'kind': kind}


class TestJoinTurns(unittest.TestCase):
    def test_joins_turns_closer_than_the_gap_and_keeps_them_in_order(self):
        # turn ends 600, next prompt at 1200 (gap 600 < 1800): one block holding both turns
        self.assertEqual(
            activity.join_turns([turn(0, 600, 'a'), turn(1200, 1500, 'b', 'notification')], gap=1800),
            [{'start': 0, 'end': 1500, 'turns': [tdict(0, 600, 'a'), tdict(1200, 1500, 'b', 'notification')]}])

    def test_gap_is_exclusive_of_the_limit(self):
        # exactly the gap apart starts a new block
        got = activity.join_turns([turn(0, 600), turn(2400, 2700)], gap=1800)
        self.assertEqual([(b['start'], b['end']) for b in got], [(0, 600), (2400, 2700)])

    def test_short_block_is_extended_to_one_minute_but_its_turn_keeps_true_times(self):
        got = activity.join_turns([turn(100.0, 130.0)])
        self.assertEqual((got[0]['start'], got[0]['end']), (100.0, 160.0))
        self.assertEqual((got[0]['turns'][0]['start'], got[0]['turns'][0]['end']), (100.0, 130.0))

    def test_unsorted_overlapping_and_empty(self):
        got = activity.join_turns([turn(1200, 1500), turn(0, 1300)], gap=1800)
        self.assertEqual([(b['start'], b['end'], len(b['turns'])) for b in got], [(0, 1500, 2)])
        self.assertEqual(activity.join_turns([]), [])


class TestExtendIfLive(unittest.TestCase):
    def test_a_turn_still_being_written_ends_now(self):
        got = activity.extend_if_live([turn(0, 100), turn(500, 990)], now=1000)
        self.assertEqual([t[1] for t in got], [100, 1000])

    def test_a_finished_turn_is_left_alone(self):
        turns = [turn(0, 100), turn(500, 600)]
        self.assertEqual(activity.extend_if_live(turns, now=5000), turns)
        self.assertEqual(activity.extend_if_live([], now=1), [])


class TestClipSpans(unittest.TestCase):
    def blk(self, a, b, turns=()):
        return {'start': a, 'end': b, 'turns': list(turns)}

    def test_clip_keeps_only_the_turns_that_touch_what_is_left(self):
        blocks = [self.blk(0, 100, [tdict(0, 40), tdict(60, 100)]), self.blk(150, 250), self.blk(300, 400)]
        got = activity.clip_spans(blocks, 50, 200)
        self.assertEqual([(b['start'], b['end']) for b in got], [(50, 100), (150, 200)])
        self.assertEqual(got[0]['turns'], [tdict(60, 100)])

    def test_drops_empty(self):
        self.assertEqual(activity.clip_spans([self.blk(0, 100)], 100, 200), [])


class TestTurnBuilder(unittest.TestCase):
    def test_activity_before_any_prompt_is_ignored_when_a_prompt_follows(self):
        b = activity.TurnBuilder()
        b.activity(1)
        b.prompt(10)
        b.activity(20)
        self.assertEqual(b.finish(), [turn(10, 20, '')])

    def test_a_long_silence_inside_a_turn_starts_a_new_turn(self):
        b = activity.TurnBuilder()
        b.prompt(0)
        b.activity(600)
        b.activity(600 + 8 * 3600)          # the agent resumed hours later without a prompt
        b.activity(600 + 8 * 3600 + 300)
        self.assertEqual(b.finish(), [turn(0, 600, '', 'prompt'), turn(600 + 8 * 3600, 600 + 8 * 3600 + 300, '', 'resume')])

    def test_a_transcript_with_no_prompt_is_one_turn(self):
        b = activity.TurnBuilder()
        b.activity(5)
        b.activity(9)
        self.assertEqual([t[:2] for t in b.finish()], [[5, 9]])


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
        self.assertEqual(got, [[epoch('01:00:00'), epoch('01:04:00'), 'do it', 'prompt'],
                               [epoch('01:30:00'), epoch('01:31:00'), 'next', 'prompt']])

    def test_meta_sidechain_and_command_output_do_not_start_turns(self):
        got = self.turns([
            line('user', '01:00:00', message={'role': 'user', 'content': 'go'}),
            line('user', '01:01:00', isMeta=True, message={'role': 'user', 'content': 'meta text'}),
            line('user', '01:02:00', isSidechain=True, message={'role': 'user', 'content': 'sub-agent prompt'}),
            line('user', '01:03:00', message={'role': 'user', 'content': '<local-command-stdout>x</local-command-stdout>'}),
            line('system', '05:00:00'),
        ])
        self.assertEqual(got, [[epoch('01:00:00'), epoch('01:03:00'), 'go', 'prompt']])

    def test_a_task_notification_wakes_the_agent_and_starts_a_turn(self):
        got = self.turns([
            line('user', '01:00:00', message={'role': 'user', 'content': 'go'}),
            line('assistant', '01:01:00', message={'role': 'assistant', 'content': 'started'}),
            line('user', '03:00:00', message={'role': 'user', 'content': '<task-notification>done</task-notification>'}),
            line('assistant', '03:01:00', message={'role': 'assistant', 'content': 'handled'}),
        ])
        self.assertEqual(got, [[epoch('01:00:00'), epoch('01:01:00'), 'go', 'prompt'],
                               [epoch('03:00:00'), epoch('03:01:00'), 'done', 'notification']])

    def test_assistant_output_resuming_after_a_long_gap_without_a_prompt(self):
        got = self.turns([
            line('user', '02:00:00', message={'role': 'user', 'content': 'go'}),
            line('assistant', '02:29:00', message={'role': 'assistant', 'content': 'working'}),
            # eight hours later the assistant continues (resumed session), no prompt in between
            line('assistant', '10:33:00', message={'role': 'assistant', 'content': 'again'}),
            line('assistant', '10:40:00', message={'role': 'assistant', 'content': 'more'}),
        ])
        self.assertEqual(got, [[epoch('02:00:00'), epoch('02:29:00'), 'go', 'prompt'],
                               [epoch('10:33:00'), epoch('10:40:00'), '', 'resume']])

    def test_kinds_and_prompt_text(self):
        got = self.turns([
            line('user', '03:00:00', message={'role': 'user', 'content': '<task-notification>done</task-notification>'}),
            line('user', '04:00:00', message={'role': 'user', 'content': 'Another Claude session sent a message: hi'}),
            line('user', '05:00:00', message={'role': 'user', 'content': '<command-name>/foo</command-name>'}),
            line('user', '06:00:00', origin={'kind': 'task-notification'}, message={'role': 'user', 'content': 'x y'}),
            line('user', '07:00:00', message={'role': 'user', 'content': [{'type': 'text', 'text': 'z' * 500}]}),
        ])
        self.assertEqual([t[3] for t in got], ['notification', 'notification', 'prompt', 'notification', 'prompt'])
        self.assertEqual(got[0][2], 'done')
        self.assertEqual(len(got[4][2]), activity.PROMPT_CHARS)

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

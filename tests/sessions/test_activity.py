import json
import os
import tempfile
import unittest

from agentsessions.sessions import activity


def turn(start, end, prompt='p', kind='prompt', reply='', segments=None):
    return [start, end, prompt, kind, reply, segments if segments is not None else [[start, end]]]


def tdict(start, end, prompt='p', kind='prompt', reply='', active=None):
    return {'start': start, 'end': end, 'active': end - start if active is None else active,
            'prompt': prompt, 'kind': kind, 'reply': reply}


def core(turns):
    return [t[:4] for t in turns]


class TestJoinTurns(unittest.TestCase):
    def test_joins_turns_closer_than_the_gap_and_lists_only_human_turns(self):
        # turn 1 ends 600, turn 2 starts at 1200 (gap 600 < 1800): one block; a sub-agent run and
        # activity nobody started count as work but aren't listed
        got = activity.join_turns([turn(0, 600, 'a', reply='first'), turn(1200, 1500, 'b', 'answer', 'second'),
                                   turn(1000, 2500, '', 'subagent'), turn(2600, 2700, '', 'resume')], gap=1800)
        self.assertEqual(got, [{'start': 0, 'end': 2700, 'turns': [
            tdict(0, 600, 'a', reply='first'), tdict(1200, 1500, 'b', 'answer', 'second')]}])

    def test_a_turns_segments_are_separate_work_not_the_hours_between_them(self):
        # one human turn with activity at 0-600 and again at 10 000-10 300 (idle in between)
        t = turn(0, 10300, 'long', segments=[[0, 600], [10000, 10300]])
        got = activity.join_turns([t], gap=1800)
        self.assertEqual([(b['start'], b['end']) for b in got], [(0, 600), (10000, 10300)])
        self.assertEqual([x['active'] for b in got for x in b['turns']], [600, 300])
        # a gap setting wide enough joins them again into one block listing the turn once
        joined = activity.join_turns([t], gap=3 * 3600)
        self.assertEqual([(b['start'], b['end'], len(b['turns']), b['turns'][0]['active']) for b in joined],
                         [(0, 10300, 1, 900)])

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


class TestRawRuns(unittest.TestCase):
    def test_runs_carry_their_turn_and_sub_agent_runs_have_none(self):
        turns = [turn(0, 10300, 'long', segments=[[0, 600], [10000, 10300]]),
                 turn(20000, 20100, '', 'subagent')]
        turn_list, runs = activity.raw_runs(turns, 0, 30000)
        self.assertEqual(turn_list, [{'start': 0, 'end': 10300, 'prompt': 'long', 'kind': 'prompt', 'reply': ''}])
        self.assertEqual(runs, [{'start': 0, 'end': 600, 'turn': 0}, {'start': 10000, 'end': 10300, 'turn': 0},
                                {'start': 20000, 'end': 20100, 'turn': None}])

    def test_a_run_crossing_the_edge_is_returned_whole_and_others_are_left_out(self):
        turns = [turn(0, 100, 'a'), turn(500, 900, 'b'), turn(2000, 2100, 'c')]
        turn_list, runs = activity.raw_runs(turns, 600, 1000)
        self.assertEqual([t['prompt'] for t in turn_list], ['b'])
        self.assertEqual(runs, [{'start': 500, 'end': 900, 'turn': 500}])

    def test_a_zero_length_run_counts_when_it_lies_in_the_range(self):
        _t, runs = activity.raw_runs([turn(700, 700, 'x')], 600, 1000)
        self.assertEqual(len(runs), 1)
        self.assertEqual(activity.raw_runs([turn(500, 500, 'x')], 600, 1000)[1], [])


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
        self.assertEqual(core(b.finish()), [turn(10, 20, '')[:4]])

    def test_a_long_silence_inside_a_turn_opens_a_new_segment_of_the_same_turn(self):
        b = activity.TurnBuilder()
        b.prompt(0)
        b.activity(600)
        b.activity(600 + 8 * 3600)          # the agent carried on hours later without a prompt
        b.activity(600 + 8 * 3600 + 300)
        turns = b.finish()
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0][5], [[0, 600], [600 + 8 * 3600, 600 + 8 * 3600 + 300]])
        self.assertEqual(turns[0][1], 600 + 8 * 3600 + 300)

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
        self.assertEqual(core(got), [[epoch('01:00:00'), epoch('01:04:00'), 'do it', 'prompt'],
                               [epoch('01:30:00'), epoch('01:31:00'), 'next', 'prompt']])

    def test_meta_sidechain_and_command_output_do_not_start_turns(self):
        got = self.turns([
            line('user', '01:00:00', message={'role': 'user', 'content': 'go'}),
            line('user', '01:01:00', isMeta=True, message={'role': 'user', 'content': 'meta text'}),
            line('user', '01:02:00', isSidechain=True, message={'role': 'user', 'content': 'sub-agent prompt'}),
            line('user', '01:03:00', message={'role': 'user', 'content': '<local-command-stdout>x</local-command-stdout>'}),
            line('system', '05:00:00'),
        ])
        # meta and command-output lines are skipped; sub-agent work still extends the turn
        self.assertEqual(core(got), [[epoch('01:00:00'), epoch('01:02:00'), 'go', 'prompt']])

    def test_a_notification_continues_the_current_turn_and_does_not_start_one(self):
        got = self.turns([
            line('user', '01:00:00', origin={'kind': 'human'}, message={'role': 'user', 'content': 'go'}),
            line('assistant', '01:01:00', message={'role': 'assistant', 'content': 'started'}),
            line('user', '01:20:00', message={'role': 'user', 'content': '<task-notification>done</task-notification>'}),
            line('user', '01:21:00', message={'role': 'user', 'content': 'Another Claude session sent a message:\n<teammate-message>x</teammate-message>'}),
            line('user', '01:22:00', origin={'kind': 'task-notification'}, message={'role': 'user', 'content': 'x y'}),
            line('assistant', '01:23:00', message={'role': 'assistant', 'content': 'handled'}),
        ])
        self.assertEqual(core(got), [[epoch('01:00:00'), epoch('01:23:00'), 'go', 'prompt']])

    def test_assistant_output_resuming_after_a_long_gap_continues_the_turn_as_a_new_segment(self):
        got = self.turns([
            line('user', '02:00:00', message={'role': 'user', 'content': 'go'}),
            line('assistant', '02:29:00', message={'role': 'assistant', 'content': 'working'}),
            # eight hours later the assistant continues (resumed session), no prompt in between
            line('assistant', '10:33:00', message={'role': 'assistant', 'content': 'again'}),
            line('assistant', '10:40:00', message={'role': 'assistant', 'content': 'more'}),
        ])
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0][5], [[epoch('02:00:00'), epoch('02:29:00')], [epoch('10:33:00'), epoch('10:40:00')]])

    def test_the_answer_to_a_question_starts_a_turn_the_question_ends_one(self):
        # the shape of a real transcript: a typed prompt, notifications, an AskUserQuestion, its answer
        ask = {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'toolu_1', 'name': 'AskUserQuestion', 'input': {}}]}
        answer = {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'toolu_1',
                  'content': 'Your questions have been answered: "Which?"="Keep it". You can now continue.'}]}
        got = self.turns([
            line('user', '10:34:31', origin={'kind': 'human'}, message={'role': 'user', 'content': 'the logic is wrong'}),
            line('assistant', '10:34:52', message={'role': 'assistant', 'content': [{'type': 'tool_use', 'name': 'Bash'}]}),
            line('user', '10:35:03', message={'role': 'user', 'content': [{'type': 'tool_result', 'content': 'ok'}]}),
            line('user', '10:38:43', message={'role': 'user', 'content': 'Another Claude session sent a message:\n<teammate-message>x</teammate-message>'}),
            line('assistant', '10:41:06', message=ask),
            line('user', '10:45:41', toolUseResult={'answers': {'Which?': 'Keep it'}}, message=answer),
            line('assistant', '10:46:49', message={'role': 'assistant', 'content': [{'type': 'text', 'text': 'Kept as is.'}]}),
            line('user', '10:52:09', origin={'kind': 'human'}, message={'role': 'user', 'content': 'that is all wrong'}),
        ])
        self.assertEqual(core(got), [
            [epoch('10:34:31'), epoch('10:41:06'), 'the logic is wrong', 'prompt'],
            [epoch('10:45:41'), epoch('10:46:49'), 'Keep it', 'answer'],
            [epoch('10:52:09'), epoch('10:52:09'), 'that is all wrong', 'prompt'],
        ])
        self.assertEqual(got[1][4], 'Kept as is.')

    def test_an_answer_is_read_from_the_tool_result_text_when_there_is_no_tool_use_result(self):
        answer = {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 't',
                  'content': 'Your questions have been answered: "A"="x", "B"="y". Continue.'}]}
        got = self.turns([line('user', '01:00:00', message=answer)])
        self.assertEqual(core(got), [[epoch('01:00:00'), epoch('01:00:00'), 'x; y', 'answer']])

    def test_each_turn_keeps_the_agents_last_answer_from_the_main_thread(self):
        got = self.turns([
            line('user', '01:00:00', message={'role': 'user', 'content': 'go'}),
            line('assistant', '01:00:10', message={'role': 'assistant', 'content': [{'type': 'text', 'text': 'working on it'}]}),
            line('assistant', '01:00:20', message={'role': 'assistant', 'content': [{'type': 'tool_use', 'name': 'Bash'}]}),
            line('assistant', '01:00:30', isSidechain=True, message={'role': 'assistant', 'content': [{'type': 'text', 'text': 'sub-agent chatter'}]}),
            line('assistant', '01:01:00', message={'role': 'assistant', 'content': [{'type': 'text', 'text': 'all done ' + 'x' * 600}]}),
            line('user', '02:00:00', message={'role': 'user', 'content': 'again'}),
        ])
        self.assertTrue(got[0][4].startswith('all done'))
        self.assertEqual(len(got[0][4]), activity.REPLY_CHARS)
        self.assertEqual(got[1][4], '')

    def test_only_the_persons_own_input_starts_a_turn(self):
        got = self.turns([
            line('user', '03:00:00', message={'role': 'user', 'content': '<task-notification>done</task-notification>'}),
            line('user', '04:00:00', message={'role': 'user', 'content': 'Another Claude session sent a message: hi'}),
            line('user', '05:00:00', message={'role': 'user', 'content': '<command-name>/foo</command-name>'}),
            line('user', '06:00:00', origin={'kind': 'task-notification'}, message={'role': 'user', 'content': 'x y'}),
            line('user', '06:30:00', message={'role': 'user', 'content': 'This session is being continued from a previous conversation'}),
            line('user', '07:00:00', message={'role': 'user', 'content': [{'type': 'text', 'text': 'z' * 500}]}),
        ])
        self.assertEqual([(t[2][:3], t[3]) for t in got], [('/fo', 'prompt'), ('zzz', 'prompt')])
        self.assertEqual(len(got[1][2]), activity.PROMPT_CHARS)

    def test_a_slash_command_reads_as_one_line(self):
        got = self.turns([
            line('user', '18:42:00', message={'role': 'user', 'content':
                  '<command-name>/model</command-name>\n<command-message>model</command-message>\n'
                  '<command-args>best</command-args>'}),
            line('user', '18:43:00', message={'role': 'user', 'content':
                  '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>'}),
        ])
        self.assertEqual([(t[2], t[3]) for t in got], [('/model best', 'prompt'), ('/clear', 'prompt')])

    def test_command_caveat_and_output_never_create_or_resume_a_turn(self):
        got = self.turns([
            line('user', '18:42:00', message={'role': 'user', 'content': '<command-name>/model</command-name><command-args>best</command-args>'}),
            line('user', '18:42:00', isMeta=True, message={'role': 'user', 'content': '<local-command-caveat>Caveat: x</local-command-caveat>'}),
            # a stray output line stamped hours later must not become a "resume" turn
            line('user', '21:30:00', message={'role': 'user', 'content': '<local-command-stdout>Set model</local-command-stdout>'}),
            line('user', '18:42:30', message={'role': 'user', 'content': '<command-name>/effort</command-name><command-args>high</command-args>'}),
        ])
        self.assertEqual([(t[2], t[3]) for t in got], [('/model best', 'prompt'), ('/effort high', 'prompt')])
        self.assertEqual(got[0][1], epoch('18:42:00'))

    def test_unreadable_file(self):
        self.assertEqual(activity.claude_turns('/nonexistent/x.jsonl'), [])


class TestSubagents(unittest.TestCase):
    def test_files_are_found_at_any_depth_next_to_the_session_file(self):
        with tempfile.TemporaryDirectory() as d:
            main = os.path.join(d, 'abc.jsonl')
            write(main, [line('user', '01:00:00')])
            os.makedirs(os.path.join(d, 'abc', 'subagents', 'deep'))
            a = os.path.join(d, 'abc', 'subagents', 'agent-1.jsonl')
            b = os.path.join(d, 'abc', 'subagents', 'deep', 'agent-2.jsonl')
            write(a, [line('user', '01:00:00')])
            write(b, [line('user', '01:00:00')])
            write(os.path.join(d, 'abc', 'notes.txt'), ['x'])
            self.assertEqual(activity.subagent_files(main), sorted([a, b]))
            self.assertEqual(activity.subagent_files(os.path.join(d, 'none.jsonl')), [])

    def test_a_run_is_first_to_last_record_split_at_long_silences(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'agent.jsonl')
            write(p, [
                line('user', '04:00:00', isSidechain=True), line('assistant', '04:10:00', isSidechain=True),
                line('assistant', '04:20:00', isSidechain=True),
                line('assistant', '06:00:00', isSidechain=True), line('assistant', '06:05:00', isSidechain=True),
            ])
            self.assertEqual([r[:2] for r in activity.subagent_runs(p)],
                             [[epoch('04:00:00'), epoch('04:20:00')], [epoch('06:00:00'), epoch('06:05:00')]])
            self.assertEqual({r[3] for r in activity.subagent_runs(p)}, {'subagent'})


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

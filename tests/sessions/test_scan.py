import json, os, tempfile, unittest
from unittest import mock

from agentsessions.sessions import scan as scan_module
from agentsessions.sessions.scan import (apply_goal_status, list_transcripts, read_head, scan, scan_names,
                                         scan_names_and_goals)

ID1 = '11111111-1111-1111-1111-111111111111'
ID2 = '22222222-2222-2222-2222-222222222222'
ID3 = '33333333-3333-3333-3333-333333333333'
ID4 = '44444444-4444-4444-4444-444444444444'
ID5 = '55555555-5555-5555-5555-555555555555'
ID6 = '66666666-6666-6666-6666-666666666666'


def write_jsonl(path, records):
    with open(path, 'w') as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n')


class TestScan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.proj = os.path.join(self.tmp.name, '-Users-k-vault')
        os.makedirs(os.path.join(self.proj, 'sub'))
        # Named session. custom-title appears twice; the later one is the current name.
        write_jsonl(os.path.join(self.proj, ID1 + '.jsonl'), [
            {'type': 'system', 'cwd': '/Users/k/vault', 'content': 'x'},
            {'type': 'user', 'isMeta': True, 'message': {'role': 'user', 'content': '<command>'}},
            {'type': 'user', 'message': {'role': 'user', 'content': 'first question here\nsecond line'}},
            {'type': 'custom-title', 'customTitle': 'RIM: old name', 'sessionId': ID1},
            {'type': 'custom-title', 'customTitle': 'RIM: new name', 'sessionId': ID1},
        ])
        # Unnamed, has a message (array content), plus a broken line.
        p2 = os.path.join(self.proj, ID2 + '.jsonl')
        write_jsonl(p2, [
            {'type': 'user', 'cwd': '/Users/k/work', 'message': {'role': 'user', 'content': [
                {'type': 'tool_result', 'content': 'x'},
                {'type': 'text', 'text': 'body text after the tool result'}]}},
        ])
        with open(p2, 'a') as f:
            f.write('{broken\n')
        # Unnamed, no message -> excluded.
        write_jsonl(os.path.join(self.proj, ID3 + '.jsonl'), [
            {'type': 'system', 'cwd': '/Users/k/work'},
        ])
        # Subfolders are not scanned.
        write_jsonl(os.path.join(self.proj, 'sub', ID1 + '.jsonl'), [
            {'type': 'custom-title', 'customTitle': 'sub', 'sessionId': ID1},
        ])
        # Names that aren't UUIDs are excluded.
        write_jsonl(os.path.join(self.proj, 'notes.jsonl'), [{'type': 'user', 'message': {'role': 'user', 'content': 'x'}}])
        # Headless SDK launch (entrypoint other than 'cli') -> child.
        write_jsonl(os.path.join(self.proj, ID4 + '.jsonl'), [
            {'type': 'user', 'entrypoint': 'sdk-cli', 'cwd': '/x', 'message': {'role': 'user', 'content': 'child q'}},
        ])
        # Skill agent (agent-setting line comes first). Still a child even though entrypoint is 'cli'.
        write_jsonl(os.path.join(self.proj, ID5 + '.jsonl'), [
            {'type': 'agent-setting', 'agentSetting': 'some-skill', 'sessionId': ID5},
            {'type': 'user', 'entrypoint': 'cli', 'cwd': '/y', 'message': {'role': 'user', 'content': 'agent q'}},
        ])
        # Background launch (sessionKind is 'bg'). entrypoint is 'cli' and there's no
        # agent-setting line, but it's still a child.
        write_jsonl(os.path.join(self.proj, ID6 + '.jsonl'), [
            {'type': 'user', 'entrypoint': 'cli', 'sessionKind': 'bg', 'cwd': '/z', 'message': {'role': 'user', 'content': 'bg q'}},
        ])

    def tearDown(self):
        self.tmp.cleanup()

    def test_list_transcripts(self):
        paths = list_transcripts(self.tmp.name)
        self.assertEqual([os.path.basename(p) for p in paths],
                          sorted([ID1 + '.jsonl', ID2 + '.jsonl', ID3 + '.jsonl', ID4 + '.jsonl', ID5 + '.jsonl', ID6 + '.jsonl']))

    def test_scan_names_last_wins(self):
        names = scan_names(list_transcripts(self.tmp.name))
        self.assertEqual(names, {ID1: 'RIM: new name'})

    def test_scan_names_empty(self):
        self.assertEqual(scan_names([]), {})

    def test_read_head_string_content_skips_meta(self):
        cwd, prompt = read_head(os.path.join(self.proj, ID1 + '.jsonl'))
        self.assertEqual(cwd, '/Users/k/vault')
        self.assertEqual(prompt, 'first question here')

    def test_read_head_array_content_and_broken_line(self):
        cwd, prompt = read_head(os.path.join(self.proj, ID2 + '.jsonl'))
        self.assertEqual(cwd, '/Users/k/work')
        self.assertEqual(prompt, 'body text after the tool result')

    def test_scan(self):
        sessions = scan(list_transcripts(self.tmp.name))
        self.assertEqual(set(sessions), {ID1, ID2, ID4, ID5, ID6})
        self.assertEqual(sessions[ID1].name, 'RIM: new name')
        self.assertIsNone(sessions[ID2].name)
        self.assertEqual(sessions[ID2].first_prompt, 'body text after the tool result')
        self.assertGreater(sessions[ID1].mtime, 0)

    def test_scan_child_from_entrypoint(self):
        sessions = scan(list_transcripts(self.tmp.name))
        self.assertTrue(sessions[ID4].child)

    def test_scan_child_from_agent_setting(self):
        sessions = scan(list_transcripts(self.tmp.name))
        self.assertTrue(sessions[ID5].child)

    def test_scan_child_from_session_kind_bg(self):
        sessions = scan(list_transcripts(self.tmp.name))
        self.assertTrue(sessions[ID6].child)

    def test_scan_child_false_without_entrypoint(self):
        sessions = scan(list_transcripts(self.tmp.name))
        self.assertFalse(sessions[ID2].child)

    def test_scan_names_pure_python_fallback_when_neither_rg_nor_grep_available(self):
        with mock.patch('agentsessions.sessions.scan.shutil.which', return_value=None):
            self.assertEqual(scan_names(list_transcripts(self.tmp.name)), {ID1: 'RIM: new name'})

    def test_title_grep_cmd_prefers_rg(self):
        with mock.patch('agentsessions.sessions.scan.shutil.which',
                        side_effect=lambda name: '/usr/bin/rg' if name == 'rg' else None):
            cmd = scan_module._title_grep_cmd()
        self.assertEqual(cmd[0], '/usr/bin/rg')

    def test_title_grep_cmd_uses_grep_found_via_path_when_rg_missing(self):
        # `grep` is found via PATH (shutil.which), never hard-coded to /usr/bin/grep —
        # some minimal environments have it somewhere else, or not at all.
        with mock.patch('agentsessions.sessions.scan.shutil.which',
                        side_effect=lambda name: '/opt/bin/grep' if name == 'grep' else None):
            cmd = scan_module._title_grep_cmd()
        self.assertEqual(cmd[0], '/opt/bin/grep')

    def test_title_grep_cmd_none_when_neither_available(self):
        with mock.patch('agentsessions.sessions.scan.shutil.which', return_value=None):
            self.assertIsNone(scan_module._title_grep_cmd())


def goal_line(ts, **attachment):
    return {'parentUuid': None, 'isSidechain': False, 'type': 'attachment', 'timestamp': ts,
            'attachment': dict({'type': 'goal_status'}, **attachment)}


T0 = '2026-10-01T00:00:00.000Z'
T1 = '2026-10-01T00:10:00.000Z'
T2 = '2026-10-01T00:20:00.000Z'
T3 = '2026-10-01T00:30:00.000Z'
E0 = 1790812800.0   # T0 in epoch seconds


class TestGoal(unittest.TestCase):
    """`/goal` as Claude Code records it: attachment lines of type `goal_status`."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.proj = os.path.join(self.tmp.name, '-Users-k-vault')
        os.makedirs(self.proj)

    def tearDown(self):
        self.tmp.cleanup()

    def goals(self, records, python=False):
        write_jsonl(os.path.join(self.proj, ID1 + '.jsonl'),
                    [{'type': 'user', 'cwd': '/x', 'message': {'role': 'user', 'content': 'q'}}] + records)
        paths = list_transcripts(self.tmp.name)
        if python:
            with mock.patch('agentsessions.sessions.scan.shutil.which', return_value=None):
                return scan_names_and_goals(paths)[1].get(ID1)
        return scan_names_and_goals(paths)[1].get(ID1)

    def test_no_goal(self):
        self.assertIsNone(self.goals([]))

    def test_set(self):
        g = self.goals([goal_line(T0, met=False, sentinel=True, condition='finish the plan')])
        self.assertEqual(g, {'condition': 'finish the plan', 'met': False, 'reason': None,
                             'since': E0, 'updated': E0})

    def test_unmet_evaluation_keeps_since_and_carries_the_reason(self):
        g = self.goals([
            goal_line(T0, met=False, sentinel=True, condition='c'),
            goal_line(T1, met=False, condition='c', reason='T-12 onward not started'),
        ])
        self.assertFalse(g['met'])
        self.assertEqual(g['reason'], 'T-12 onward not started')
        self.assertEqual(g['since'], E0)
        self.assertEqual(g['updated'], E0 + 600)

    def test_met(self):
        g = self.goals([
            goal_line(T0, met=False, sentinel=True, condition='c'),
            goal_line(T1, met=False, condition='c', reason='not yet'),
            goal_line(T2, met=True, condition='c', reason='all done', iterations=2, durationMs=1, tokens=1),
        ])
        self.assertTrue(g['met'])
        self.assertEqual(g['reason'], 'all done')
        self.assertEqual(g['since'], E0)
        self.assertNotIn('failed', g)

    def test_cleared(self):
        # `/goal clear` appends a sentinel with met: true.
        self.assertIsNone(self.goals([
            goal_line(T0, met=False, sentinel=True, condition='c'),
            goal_line(T1, met=True, sentinel=True, condition='c'),
        ]))

    def test_replaced_by_a_new_goal(self):
        g = self.goals([
            goal_line(T0, met=False, sentinel=True, condition='old'),
            goal_line(T1, met=False, condition='old', reason='not yet'),
            goal_line(T2, met=False, sentinel=True, condition='new'),
        ])
        self.assertEqual(g['condition'], 'new')
        self.assertIsNone(g['reason'])
        self.assertEqual(g['since'], E0 + 1200)

    def test_new_goal_after_a_met_one(self):
        g = self.goals([
            goal_line(T0, met=False, sentinel=True, condition='c'),
            goal_line(T1, met=True, condition='c', reason='done'),
            goal_line(T2, met=False, sentinel=True, condition='c'),
        ])
        self.assertFalse(g['met'])
        self.assertEqual(g['since'], E0 + 1200)

    def test_resent_sentinel_keeps_since(self):
        # Claude Code re-sends the sentinel for the goal still active (on resume, after compaction).
        g = self.goals([
            goal_line(T0, met=False, sentinel=True, condition='c'),
            goal_line(T1, met=False, condition='c', reason='not yet'),
            goal_line(T3, met=False, sentinel=True, condition='c'),
        ])
        self.assertEqual(g['since'], E0)
        self.assertEqual(g['reason'], 'not yet')

    def test_failed(self):
        g = self.goals([
            goal_line(T0, met=False, sentinel=True, condition='c'),
            goal_line(T1, met=False, failed=True, condition='c', reason='cannot be done'),
        ])
        self.assertFalse(g['met'])
        self.assertTrue(g['failed'])

    def test_reason_is_cut(self):
        g = self.goals([goal_line(T0, met=False, condition='c', reason='x' * 5000)])
        self.assertEqual(len(g['reason']), scan_module.GOAL_REASON_CHARS)

    def test_quoted_text_is_not_a_goal(self):
        # A tool result quoting a goal line has it escaped inside a string, never as a bare key.
        quoted = json.dumps(goal_line(T0, met=False, sentinel=True, condition='c'))
        self.assertIsNone(self.goals([{'type': 'user', 'message': {'role': 'user', 'content': quoted}}]))

    def test_python_fallback_agrees(self):
        records = [
            goal_line(T0, met=False, sentinel=True, condition='c'),
            goal_line(T1, met=True, condition='c', reason='done'),
        ]
        self.assertEqual(self.goals(records, python=True), self.goals(records))

    def test_scan_sets_session_goal_and_names_still_work(self):
        self.goals([{'type': 'custom-title', 'customTitle': 'A: b', 'sessionId': ID1},
                    goal_line(T0, met=False, sentinel=True, condition='c')])
        s = scan(list_transcripts(self.tmp.name))[ID1]
        self.assertEqual(s.name, 'A: b')
        self.assertEqual(s.goal['condition'], 'c')

    def test_apply_ignores_other_attachments(self):
        g = {'condition': 'c', 'met': False, 'reason': None, 'since': 1.0, 'updated': 1.0}
        self.assertIs(apply_goal_status(g, {'type': 'attachment', 'attachment': {'type': 'file'}}), g)


class TestLastActivity(unittest.TestCase):
    """Last-activity time is the timestamp of the last user message or assistant
    response; status/telemetry rows and the file's own mtime aren't used for it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.proj = os.path.join(self.tmp.name, 'proj')
        os.makedirs(self.proj)

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, sid, records):
        p = os.path.join(self.proj, sid + '.jsonl')
        write_jsonl(p, records)
        os.utime(p, (2_000_000_000, 2_000_000_000))   # mtime is set to year 2033, so it's obvious if it's mistakenly used
        return p

    def test_uses_last_user_or_assistant_timestamp(self):
        self._write(ID1, [
            {'type': 'user', 'timestamp': '2026-09-01T00:00:00.000Z', 'cwd': '/a',
             'message': {'role': 'user', 'content': 'q'}},
            {'type': 'assistant', 'timestamp': '2026-09-01T00:00:10.500Z',
             'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'a'}]}},
            # Everything after this point is just a status/telemetry update and shouldn't count
            {'type': 'user', 'isMeta': True, 'timestamp': '2026-09-01T01:00:00.000Z',
             'message': {'role': 'user', 'content': 'meta'}},
            {'type': 'user', 'timestamp': '2026-09-01T02:00:00.000Z',
             'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'x', 'content': 'r'}]}},
            {'type': 'user', 'isSidechain': True, 'timestamp': '2026-09-01T03:00:00.000Z',
             'message': {'role': 'user', 'content': 'sub'}},
            {'type': 'cost-state', 'timestamp': '2026-09-01T04:00:00.000Z', 'totalCostUSD': 0.1},
            {'type': 'last-prompt', 'lastPrompt': 'q'},
        ])
        sessions = scan(list_transcripts(self.tmp.name))
        self.assertEqual(sessions[ID1].mtime, 1788220810.5)   # 2026-09-01T00:00:10.5Z

    def test_falls_back_to_mtime_without_activity(self):
        self._write(ID2, [
            {'type': 'user', 'cwd': '/a', 'message': {'role': 'user', 'content': 'no timestamp'}},
        ])
        sessions = scan(list_transcripts(self.tmp.name))
        self.assertEqual(sessions[ID2].mtime, 2_000_000_000)

    def test_tail_read_crosses_chunk_boundary(self):
        from agentsessions.sessions.scan import read_last_activity
        big = 'x' * 500
        p = self._write(ID3, [
            {'type': 'assistant', 'timestamp': '2026-09-02T00:00:00Z',
             'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': big}]}},
            {'type': 'cost-state', 'note': big},
            {'type': 'cost-state', 'note': big},
        ])
        self.assertEqual(read_last_activity(p, chunk=64), 1788307200.0)
        self.assertIsNone(read_last_activity(p, chunk=64, limit=200))

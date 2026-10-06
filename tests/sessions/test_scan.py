import json, os, tempfile, unittest
from unittest import mock

from agentsessions.sessions import scan as scan_module
from agentsessions.sessions.scan import list_transcripts, scan_names, read_head, scan

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


class TestAfterCompact(unittest.TestCase):
    """`read_after_compact`: whether the last compaction has been followed by anything the
    model answered, judged on the lines Claude Code writes for `/compact` and the local
    commands after it."""

    PROMPT = {'type': 'user', 'message': {'role': 'user', 'content': 'do the thing'}}
    REPLY = {'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'ok'}]}}
    COMPACT = [
        {'type': 'system', 'subtype': 'compact_boundary', 'content': 'Conversation compacted'},
        {'type': 'user', 'isCompactSummary': True,
         'message': {'role': 'user', 'content': 'This session is being continued from a previous conversation'}},
        {'type': 'user', 'isMeta': True,
         'message': {'role': 'user', 'content': '<local-command-caveat>Caveat</local-command-caveat>'}},
        {'type': 'user', 'message': {'role': 'user', 'content':
            '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'}},
        {'type': 'user', 'message': {'role': 'user', 'content': '<local-command-stdout>Compacted </local-command-stdout>'}},
        {'type': 'custom-title', 'customTitle': 'A: b'},
        {'type': 'last-prompt', 'lastPrompt': '/compact'},
    ]
    RENAME = [
        {'type': 'system', 'subtype': 'local_command', 'content':
            '<command-name>/rename</command-name>\n<command-args>A: c</command-args>'},
        {'type': 'system', 'subtype': 'local_command', 'content':
            '<local-command-stdout>Session renamed to: A: c</local-command-stdout>'},
        {'type': 'user', 'isMeta': True, 'message': {'role': 'user', 'content':
            '<system-reminder>The user named this session "A: c".</system-reminder>'}},
    ]
    MODEL = [
        {'type': 'user', 'message': {'role': 'user', 'content':
            '<command-name>/model</command-name>\n<command-args>opus</command-args>'}},
        {'type': 'user', 'message': {'role': 'user', 'content': '<local-command-stdout>Set model to Opus</local-command-stdout>'}},
    ]
    BASH = [
        {'type': 'user', 'message': {'role': 'user', 'content': '<bash-input>ls</bash-input>'}},
        {'type': 'user', 'message': {'role': 'user', 'content': '<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>'}},
    ]

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def _state(self, records, **kw):
        from agentsessions.sessions.scan import read_after_compact
        p = os.path.join(self.tmp.name, ID1 + '.jsonl')
        write_jsonl(p, records)
        return read_after_compact(p, **kw)

    def test_clean_right_after_compact(self):
        self.assertEqual(self._state([self.PROMPT, self.REPLY] + self.COMPACT), 'clean')

    def test_local_commands_keep_it_clean(self):
        self.assertEqual(self._state([self.PROMPT, self.REPLY] + self.COMPACT + self.RENAME + self.MODEL + self.BASH),
                         'clean')

    def test_prompt_without_reply_is_input(self):
        self.assertEqual(self._state(self.COMPACT + self.RENAME + [self.PROMPT]), 'input')

    def test_reply_after_compact_clears(self):
        self.assertIsNone(self._state(self.COMPACT + self.RENAME + [self.PROMPT, self.REPLY]))

    def test_command_that_runs_the_model_clears(self):
        review = [
            {'type': 'user', 'message': {'role': 'user', 'content': '<command-name>/review</command-name>'}},
            {'type': 'user', 'isMeta': True, 'message': {'role': 'user', 'content': 'Review this change.'}},
            self.REPLY,
        ]
        self.assertIsNone(self._state(self.COMPACT + review))

    def test_tool_result_clears(self):
        # Automatic compaction in the middle of a turn: the model carries on after the boundary.
        tool = {'type': 'user', 'message': {'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': 'x', 'content': 'r'}]}}
        self.assertIsNone(self._state(self.COMPACT[:2] + [tool]))

    def test_sidechain_lines_are_ignored(self):
        side = dict(self.REPLY, isSidechain=True)
        self.assertEqual(self._state(self.COMPACT + [side]), 'clean')

    def test_no_compaction(self):
        self.assertIsNone(self._state([self.PROMPT, self.REPLY] + self.RENAME))
        self.assertIsNone(self._state([self.PROMPT]))

    def test_scan_carries_it_and_caches_it(self):
        p = os.path.join(self.tmp.name, 'proj', ID1 + '.jsonl')
        os.makedirs(os.path.dirname(p))
        write_jsonl(p, [dict(self.PROMPT, cwd='/a'), self.REPLY] + self.COMPACT + self.RENAME)
        os.utime(p, (2_000_000_000, 2_000_000_000))
        cache = {}
        with mock.patch.object(scan_module.time, 'time', return_value=2_000_000_100):
            self.assertEqual(scan([p], cache)[ID1].after_compact, 'clean')
            self.assertEqual(cache[p]['after_compact'], 'clean')
            with mock.patch.object(scan_module, 'read_after_compact', side_effect=AssertionError):
                self.assertEqual(scan([p], cache)[ID1].after_compact, 'clean')

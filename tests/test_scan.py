import json, os, tempfile, unittest
from agentsessions.scan import list_transcripts, scan_names, read_head, scan

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
        # 名前付き。custom-title は2回、後の方が現在の名前
        write_jsonl(os.path.join(self.proj, ID1 + '.jsonl'), [
            {'type': 'system', 'cwd': '/Users/k/vault', 'content': 'x'},
            {'type': 'user', 'isMeta': True, 'message': {'role': 'user', 'content': '<command>'}},
            {'type': 'user', 'message': {'role': 'user', 'content': '最初の質問です\n二行目'}},
            {'type': 'custom-title', 'customTitle': '旧名', 'sessionId': ID1},
            {'type': 'custom-title', 'customTitle': 'RIM: 新名', 'sessionId': ID1},
        ])
        # 名前なし、発言あり（配列 content）、壊れた行つき
        p2 = os.path.join(self.proj, ID2 + '.jsonl')
        write_jsonl(p2, [
            {'type': 'user', 'cwd': '/Users/k/work', 'message': {'role': 'user', 'content': [
                {'type': 'tool_result', 'content': 'x'},
                {'type': 'text', 'text': 'ツール結果の後の本文'}]}},
        ])
        with open(p2, 'a') as f:
            f.write('{broken\n')
        # 名前なし、発言なし → 除外
        write_jsonl(os.path.join(self.proj, ID3 + '.jsonl'), [
            {'type': 'system', 'cwd': '/Users/k/work'},
        ])
        # サブフォルダは対象外
        write_jsonl(os.path.join(self.proj, 'sub', ID1 + '.jsonl'), [
            {'type': 'custom-title', 'customTitle': 'sub', 'sessionId': ID1},
        ])
        # UUID でない名前は対象外
        write_jsonl(os.path.join(self.proj, 'notes.jsonl'), [{'type': 'user', 'message': {'role': 'user', 'content': 'x'}}])
        # headless SDK 起動（entrypoint が cli 以外）→ child
        write_jsonl(os.path.join(self.proj, ID4 + '.jsonl'), [
            {'type': 'user', 'entrypoint': 'sdk-cli', 'cwd': '/x', 'message': {'role': 'user', 'content': 'child q'}},
        ])
        # skill agent（agent-setting が先頭）。entrypoint は cli でも child
        write_jsonl(os.path.join(self.proj, ID5 + '.jsonl'), [
            {'type': 'agent-setting', 'agentSetting': 'some-skill', 'sessionId': ID5},
            {'type': 'user', 'entrypoint': 'cli', 'cwd': '/y', 'message': {'role': 'user', 'content': 'agent q'}},
        ])
        # バックグラウンド起動（sessionKind が bg）。entrypoint は cli で agent-setting も無いが child
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
        self.assertEqual(names, {ID1: 'RIM: 新名'})

    def test_scan_names_empty(self):
        self.assertEqual(scan_names([]), {})

    def test_read_head_string_content_skips_meta(self):
        cwd, prompt = read_head(os.path.join(self.proj, ID1 + '.jsonl'))
        self.assertEqual(cwd, '/Users/k/vault')
        self.assertEqual(prompt, '最初の質問です')

    def test_read_head_array_content_and_broken_line(self):
        cwd, prompt = read_head(os.path.join(self.proj, ID2 + '.jsonl'))
        self.assertEqual(cwd, '/Users/k/work')
        self.assertEqual(prompt, 'ツール結果の後の本文')

    def test_scan(self):
        sessions = scan(list_transcripts(self.tmp.name))
        self.assertEqual(set(sessions), {ID1, ID2, ID4, ID5, ID6})
        self.assertEqual(sessions[ID1].name, 'RIM: 新名')
        self.assertIsNone(sessions[ID2].name)
        self.assertEqual(sessions[ID2].first_prompt, 'ツール結果の後の本文')
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

    def test_scan_names_grep_fallback(self):
        from unittest import mock
        with mock.patch('agentsessions.scan.shutil.which', return_value=None):
            self.assertEqual(scan_names(list_transcripts(self.tmp.name)), {ID1: 'RIM: 新名'})


class TestLastActivity(unittest.TestCase):
    """最終更新は最後のユーザー発言／assistant 応答の timestamp。更新通知の行や mtime は使わない。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.proj = os.path.join(self.tmp.name, 'proj')
        os.makedirs(self.proj)

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, sid, records):
        p = os.path.join(self.proj, sid + '.jsonl')
        write_jsonl(p, records)
        os.utime(p, (2_000_000_000, 2_000_000_000))   # mtime は 2033 年。使われれば分かる
        return p

    def test_uses_last_user_or_assistant_timestamp(self):
        self._write(ID1, [
            {'type': 'user', 'timestamp': '2026-09-01T00:00:00.000Z', 'cwd': '/a',
             'message': {'role': 'user', 'content': 'q'}},
            {'type': 'assistant', 'timestamp': '2026-09-01T00:00:10.500Z',
             'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'a'}]}},
            # 以降は更新通知：数えない
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
        from agentsessions.scan import read_last_activity
        big = 'x' * 500
        p = self._write(ID3, [
            {'type': 'assistant', 'timestamp': '2026-09-02T00:00:00Z',
             'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': big}]}},
            {'type': 'cost-state', 'note': big},
            {'type': 'cost-state', 'note': big},
        ])
        self.assertEqual(read_last_activity(p, chunk=64), 1788307200.0)
        self.assertIsNone(read_last_activity(p, chunk=64, limit=200))

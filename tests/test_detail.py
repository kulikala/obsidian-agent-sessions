import json, os, tempfile, unittest

from agentsessions.detail import Detail, clean_text, is_human_prompt, read_detail


def write_jsonl(path, records):
    with open(path, 'w') as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n')


def user(text, **kw):
    d = {'type': 'user', 'message': {'role': 'user', 'content': text}}
    d.update(kw)
    return d


def assistant(blocks, **kw):
    d = {'type': 'assistant', 'message': {'role': 'assistant', 'content': blocks}}
    d.update(kw)
    return d


class TestCleanText(unittest.TestCase):
    def test_strips_system_reminder(self):
        s = clean_text('本文\n<system-reminder>内部の注意</system-reminder>\n続き')
        self.assertEqual(s, '本文\n続き')

    def test_drops_bold_markers(self):
        self.assertEqual(clean_text('**置く場所**（1 段落）'), '置く場所（1 段落）')

    def test_strips_lone_tags(self):
        self.assertEqual(clean_text('<command-name>/compact</command-name>'), '/compact')


class TestIsHumanPrompt(unittest.TestCase):
    def test_origin_wins(self):
        self.assertTrue(is_human_prompt({'origin': {'kind': 'human'}}, '<x>'))
        self.assertFalse(is_human_prompt({'origin': {'kind': 'task-notification'}}, '普通の文'))

    def test_without_origin_uses_prefix(self):
        self.assertTrue(is_human_prompt({}, '直せ'))
        self.assertFalse(is_human_prompt({}, '<task-notification>…'))
        self.assertFalse(is_human_prompt({}, 'Another Claude session sent a message: …'))
        self.assertFalse(is_human_prompt({}, '[Request interrupted by user]'))


class TestReadDetail(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 't.jsonl')

    def tearDown(self):
        self.tmp.cleanup()

    def test_picks_last_human_prompt_and_last_text_answer(self):
        write_jsonl(self.path, [
            user('古い指示', origin={'kind': 'human'}),
            assistant([{'type': 'text', 'text': '古い応答'}]),
            user('新しい指示', origin={'kind': 'human'}),
            assistant([{'type': 'text', 'text': '新しい応答'}, {'type': 'tool_use', 'name': 'Edit'}]),
            assistant([{'type': 'tool_use', 'name': 'Bash'}]),          # テキスト無しは応答に使わない
            user([{'type': 'tool_result', 'tool_use_id': 'x', 'content': 'ok'}]),
            user('<task-notification>…</task-notification>', origin={'kind': 'task-notification'}),
        ])
        d = read_detail(self.path)
        self.assertEqual(d.last_user, '新しい指示')
        self.assertEqual(d.last_assistant, '新しい応答')
        self.assertEqual(d.tools, ['Bash'])

    def test_skips_sidechain_and_meta(self):
        write_jsonl(self.path, [
            user('本命の指示', origin={'kind': 'human'}),
            assistant([{'type': 'text', 'text': '本命の応答'}]),
            user('サブの指示', origin={'kind': 'human'}, isSidechain=True),
            assistant([{'type': 'text', 'text': 'サブの応答'}], isSidechain=True),
            user('メタ', origin={'kind': 'human'}, isMeta=True),
        ])
        d = read_detail(self.path)
        self.assertEqual(d.last_user, '本命の指示')
        self.assertEqual(d.last_assistant, '本命の応答')

    def test_empty_when_nothing_found(self):
        write_jsonl(self.path, [{'type': 'cost-state', 'totalCostUSD': 1}])
        self.assertEqual(read_detail(self.path), Detail())

    def test_crosses_chunk_boundary(self):
        big = 'y' * 400
        write_jsonl(self.path, [
            user('遠くの指示', origin={'kind': 'human'}),
            assistant([{'type': 'text', 'text': '遠くの応答'}]),
        ] + [{'type': 'cost-state', 'note': big} for _ in range(20)])
        d = read_detail(self.path, chunk=64)
        self.assertEqual(d.last_user, '遠くの指示')

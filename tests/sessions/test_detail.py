import json, os, tempfile, unittest

from agentsessions.sessions.detail import Detail, clean_text, is_human_prompt, read_detail


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


def command(name, message='', args=''):
    """A slash-command invocation line (a user line carrying `<command-name>` tags)."""
    return user(
        '<command-name>%s</command-name>\n'
        '          <command-message>%s</command-message>\n'
        '          <command-args>%s</command-args>' % (name, message, args))


class TestCleanText(unittest.TestCase):
    def test_strips_system_reminder(self):
        s = clean_text('body\n<system-reminder>internal note</system-reminder>\nmore text')
        self.assertEqual(s, 'body\nmore text')

    def test_drops_bold_markers(self):
        self.assertEqual(clean_text('**Location** (one paragraph)'), 'Location (one paragraph)')

    def test_strips_lone_tags(self):
        self.assertEqual(clean_text('<command-name>/compact</command-name>'), '/compact')


class TestIsHumanPrompt(unittest.TestCase):
    def test_origin_wins(self):
        self.assertTrue(is_human_prompt({'origin': {'kind': 'human'}}, '<x>'))
        self.assertFalse(is_human_prompt({'origin': {'kind': 'task-notification'}}, 'an ordinary sentence'))

    def test_without_origin_uses_prefix(self):
        self.assertTrue(is_human_prompt({}, 'fix it'))
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
            user('old instruction', origin={'kind': 'human'}),
            assistant([{'type': 'text', 'text': 'old response'}]),
            user('new instruction', origin={'kind': 'human'}),
            assistant([{'type': 'text', 'text': 'new response'}, {'type': 'tool_use', 'name': 'Edit'}]),
            assistant([{'type': 'tool_use', 'name': 'Bash'}]),          # a response with no text isn't used as the answer
            user([{'type': 'tool_result', 'tool_use_id': 'x', 'content': 'ok'}]),
            user('<task-notification>…</task-notification>', origin={'kind': 'task-notification'}),
        ])
        d = read_detail(self.path)
        self.assertEqual(d.last_user, 'new instruction')
        self.assertEqual(d.last_assistant, 'new response')
        self.assertEqual(d.tools, ['Bash'])

    def test_skips_sidechain_and_meta(self):
        write_jsonl(self.path, [
            user('main instruction', origin={'kind': 'human'}),
            assistant([{'type': 'text', 'text': 'main response'}]),
            user('sub instruction', origin={'kind': 'human'}, isSidechain=True),
            assistant([{'type': 'text', 'text': 'sub response'}], isSidechain=True),
            user('meta', origin={'kind': 'human'}, isMeta=True),
        ])
        d = read_detail(self.path)
        self.assertEqual(d.last_user, 'main instruction')
        self.assertEqual(d.last_assistant, 'main response')

    def test_empty_when_nothing_found(self):
        write_jsonl(self.path, [{'type': 'cost-state', 'totalCostUSD': 1}])
        self.assertEqual(read_detail(self.path), Detail())

    def test_crosses_chunk_boundary(self):
        big = 'y' * 400
        write_jsonl(self.path, [
            user('far instruction', origin={'kind': 'human'}),
            assistant([{'type': 'text', 'text': 'far response'}]),
        ] + [{'type': 'cost-state', 'note': big} for _ in range(20)])
        d = read_detail(self.path, chunk=64)
        self.assertEqual(d.last_user, 'far instruction')

    def test_last_command_without_a_following_human_prompt(self):
        write_jsonl(self.path, [
            user('main instruction', origin={'kind': 'human'}),
            assistant([{'type': 'text', 'text': 'main response'}]),
            command('/compact'),
        ])
        d = read_detail(self.path)
        self.assertEqual(d.last_command, '/compact')
        self.assertEqual(d.last_user, 'main instruction')
        self.assertEqual(d.last_assistant, 'main response')

    def test_last_command_after_a_human_prompt(self):
        write_jsonl(self.path, [
            user('distant instruction', origin={'kind': 'human'}),
            assistant([{'type': 'text', 'text': 'distant response'}]),
            user('recent instruction', origin={'kind': 'human'}),
            assistant([{'type': 'text', 'text': 'recent response'}]),
            command('/compact'),
        ])
        d = read_detail(self.path)
        self.assertEqual(d.last_command, '/compact')
        # The command line doesn't get mixed into last_user/last_assistant
        # (they stay the most recent human instruction/response)
        self.assertEqual(d.last_user, 'recent instruction')
        self.assertEqual(d.last_assistant, 'recent response')

    def test_last_command_is_none_when_no_command_was_run(self):
        write_jsonl(self.path, [
            user('instruction', origin={'kind': 'human'}),
            assistant([{'type': 'text', 'text': 'response'}]),
        ])
        d = read_detail(self.path)
        self.assertIsNone(d.last_command)

    def test_last_command_picks_the_most_recent_one(self):
        write_jsonl(self.path, [
            command('/rename', args='old name'),
            user('instruction', origin={'kind': 'human'}),
            assistant([{'type': 'text', 'text': 'response'}]),
            command('/compact'),
        ])
        d = read_detail(self.path)
        self.assertEqual(d.last_command, '/compact')

    def test_last_command_from_plain_slash_text_without_tags(self):
        write_jsonl(self.path, [
            user('/rename New Name', origin={'kind': 'human'}),
        ])
        d = read_detail(self.path)
        self.assertEqual(d.last_command, '/rename')

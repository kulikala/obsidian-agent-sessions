import unittest

from agentsessions.agents import opencode
from tests.agents.opencode_helpers import Fixture, make_db
from tests.agents.test_opencode_scan import S1, OpencodeCase


class TestDetail(OpencodeCase):
    def test_unknown_or_missing_path_gives_an_empty_detail(self):
        d = opencode.read_detail_for(None)
        self.assertEqual((d.last_user, d.last_assistant, d.tools, d.last_command), ('', '', [], None))
        d = opencode.read_detail_for('opencode:' + S1)   # no database at all
        self.assertEqual(d.last_user, '')

    def test_most_recent_exchange(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1)
            f.user(S1, 'old question', 1_000)
            f.assistant(S1, 'old answer', 2_000, tools=('read',))
            f.user(S1, 'fix the bug', 3_000)
            f.assistant(S1, '', 4_000, tools=('read', 'edit'), finish='tool-calls', model=('ollama', 'm1'))
            f.assistant(S1, 'Done, see the diff', 5_000, tools=('bash',), model=('ollama', 'm2'))
        d = opencode.read_detail_for('opencode:' + S1)
        self.assertEqual(d.last_user, 'fix the bug')
        self.assertEqual(d.last_assistant, 'Done, see the diff')
        self.assertEqual(d.tools, ['read', 'edit', 'bash'])
        self.assertIsNone(d.last_command)
        self.assertEqual(d.model, 'ollama/m2')

    def test_session_with_only_a_user_message(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1, model={'id': 'g', 'providerID': 'ollama'})
            f.user(S1, 'hello', 1_000)
        d = opencode.read_detail_for('opencode:' + S1)
        self.assertEqual((d.last_user, d.last_assistant, d.tools), ('hello', '', []))
        self.assertEqual(d.model, 'ollama/g')


if __name__ == '__main__':
    unittest.main()

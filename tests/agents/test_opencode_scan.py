import os
import tempfile
import unittest
from unittest import mock

from agentsessions.agents import opencode
from agentsessions.agents.opencode import db as ocdb
from tests.agents.opencode_helpers import Fixture, make_db

S1 = 'ses_aaaaaaaaaaaa01'
S2 = 'ses_aaaaaaaaaaaa02'


class OpencodeCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name
        patcher = mock.patch.dict(os.environ, {'XDG_DATA_HOME': self.tmp})
        patcher.start()
        self.addCleanup(patcher.stop)


class TestScan(OpencodeCase):
    def test_no_database_lists_nothing(self):
        self.assertEqual(opencode.list_transcripts(), [])
        self.assertEqual(opencode.scan(['opencode:ses_x']), {})
        self.assertIsNone(opencode.find_transcript(S1))

    def test_lists_top_level_unarchived_sessions_with_a_user_message(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1, updated=5_000)
            f.user(S1, 'hello there', 1_000)
            f.session('ses_child', parent_id=S1)
            f.user('ses_child', 'sub task', 1_000)
            f.session('ses_archived', archived=9)
            f.user('ses_archived', 'old', 1_000)
            f.session('ses_empty')       # created at TUI launch, never used
        self.assertEqual(opencode.list_transcripts(), ['opencode:' + S1])

    def test_row_fields(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1, directory='/work/a', title='Greeting request', created=1_000, updated=7_500,
                      model={'id': 'gemma4', 'providerID': 'ollama', 'variant': 'default'})
            f.user(S1, 'say hi', 1_000, extra_parts=[{'type': 'text', 'text': 'tool noise', 'synthetic': True}])
        out = opencode.scan(opencode.list_transcripts())
        s = out[S1]
        self.assertEqual((s.agent, s.id, s.cwd, s.name), ('opencode', S1, '/work/a', 'Greeting request'))
        self.assertEqual(s.first_prompt, 'say hi')
        self.assertEqual(s.mtime, 7.5)
        self.assertEqual(s.model, 'ollama/gemma4')
        self.assertEqual(s.path, 'opencode:' + S1)
        self.assertFalse(s.child)

    def test_default_title_means_no_name(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1, title='New session - 2026-09-30T01:02:03.000Z')
            f.user(S1, 'first words', 1_000)
        self.assertIsNone(opencode.scan(opencode.list_transcripts())[S1].name)

    def test_model_falls_back_to_latest_assistant_message(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1)
            f.user(S1, 'q', 1_000)
            f.assistant(S1, 'a', 2_000, model=('openai', 'gpt-x'))
        self.assertEqual(opencode.scan(opencode.list_transcripts())[S1].model, 'openai/gpt-x')

    def test_first_prompt_is_the_first_user_text_not_a_later_one(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1)
            f.user(S1, 'first', 1_000)
            f.assistant(S1, 'reply', 2_000)
            f.user(S1, 'second', 3_000)
        self.assertEqual(opencode.scan(opencode.list_transcripts())[S1].first_prompt, 'first')

    def test_scan_only_returns_the_requested_paths(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            for sid in (S1, S2):
                f.session(sid)
                f.user(sid, 'x', 1_000)
        self.assertEqual(list(opencode.scan(['opencode:' + S2])), [S2])

    def test_tolerates_missing_optional_columns(self):
        path = make_db(self.tmp, drop_columns=('parent_id', 'time_archived', 'model', 'permission'))
        with Fixture(path) as f:
            f.session(S1)
            f.user(S1, 'hi', 1_000)
            f.assistant(S1, 'yo', 2_000, model=('ollama', 'm'))
        s = opencode.scan(opencode.list_transcripts())[S1]
        self.assertEqual(s.model, 'ollama/m')

    def test_opencode_run_sessions_are_child(self):
        # `opencode run` creates its session denying `question` (nobody can answer).
        run_rules = [{'permission': 'question', 'pattern': '*', 'action': 'deny'},
                     {'permission': 'plan_enter', 'pattern': '*', 'action': 'deny'}]
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1, permission=run_rules)
            f.session(S2, permission=[{'permission': 'bash', 'pattern': '*', 'action': 'allow'}])
            f.session('ses_plain')
            for sid in (S1, S2, 'ses_plain'):
                f.user(sid, 'x', 1_000)
        out = opencode.scan(opencode.list_transcripts())
        self.assertEqual({sid: s.child for sid, s in out.items()},
                         {S1: True, S2: False, 'ses_plain': False})

    def test_garbage_permission_value_is_not_child(self):
        for value in (None, '', '{not json', '{"permission": "question"}', '[1, "x"]'):
            self.assertFalse(ocdb.is_non_interactive(value))

    def test_find_transcript(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1)
        self.assertEqual(opencode.find_transcript(S1), 'opencode:' + S1)
        self.assertIsNone(opencode.find_transcript('ses_nope'))
        self.assertIsNone(opencode.find_transcript('not-an-opencode-id'))

    def test_reading_leaves_the_data_directory_untouched(self):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1)
            f.user(S1, 'hi', 1_000)
        self.assertEqual(len(opencode.list_transcripts()), 1)
        self.assertEqual(sorted(os.listdir(os.path.dirname(path))), ['opencode.db'])

    def test_pseudo_path_roundtrip(self):
        self.assertEqual(ocdb.session_id_of(ocdb.pseudo_path(S1)), S1)
        self.assertIsNone(ocdb.session_id_of('/some/file.jsonl'))
        self.assertIsNone(ocdb.session_id_of('opencode:'))


if __name__ == '__main__':
    unittest.main()

import tempfile
import unittest

from agentsessions.agents.codex import detail
from tests.agents.codex_helpers import (
    assistant_message, function_call, rollout_path, session_meta, turn_context,
    user_message, write_rollout,
)

ID1 = '04000000-0000-0000-0000-000000000001'


class TestCodexDetail(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name

    def test_model_and_effort_come_from_most_recent_turn_context(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='gpt-5.6-terra', effort='low', ts='2026-09-24T01:30:30Z'),
            user_message('first prompt', '2026-09-24T01:30:31Z'),
            assistant_message('first reply', '2026-09-24T01:30:32Z'),
            turn_context(model='gpt-5.6-sol', effort='high', ts='2026-09-24T01:31:00Z'),
            user_message('second prompt', '2026-09-24T01:31:01Z'),
            assistant_message('second reply', '2026-09-24T01:31:02Z'),
        ])
        d = detail.read_detail(p)
        self.assertEqual(d.last_user, 'second prompt')
        self.assertEqual(d.last_assistant, 'second reply')
        self.assertEqual(d.model, 'gpt-5.6-sol')
        self.assertEqual(d.effort, 'high')

    def test_no_turn_context_leaves_model_and_effort_none(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            user_message('a prompt', '2026-09-24T01:30:31Z'),
            assistant_message('a reply', '2026-09-24T01:30:32Z'),
        ])
        d = detail.read_detail(p)
        self.assertIsNone(d.model)
        self.assertIsNone(d.effort)

    def test_tool_call_after_last_response_is_recorded_as_currently_running(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='gpt-5.6-terra'),
            user_message('do something', '2026-09-24T01:30:31Z'),
            assistant_message('on it', '2026-09-24T01:30:32Z'),
            function_call('shell', '2026-09-24T01:30:33Z'),
        ])
        d = detail.read_detail(p)
        self.assertIn('shell', d.tools)


if __name__ == '__main__':
    unittest.main()

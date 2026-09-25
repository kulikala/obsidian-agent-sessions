import tempfile
import unittest

from agentsessions.agents.codex import detail
from tests.agents.codex_helpers import (
    assistant_message, event_user_message, function_call, item_completed_user_message,
    rollout_path, session_meta, turn_context, user_message, write_rollout,
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
            event_user_message('first prompt', '2026-09-24T01:30:31Z'),
            assistant_message('first reply', '2026-09-24T01:30:32Z'),
            turn_context(model='gpt-5.6-sol', effort='high', ts='2026-09-24T01:31:00Z'),
            event_user_message('second prompt', '2026-09-24T01:31:01Z'),
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
            event_user_message('a prompt', '2026-09-24T01:30:31Z'),
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
            event_user_message('do something', '2026-09-24T01:30:31Z'),
            assistant_message('on it', '2026-09-24T01:30:32Z'),
            function_call('shell', '2026-09-24T01:30:33Z'),
        ])
        d = detail.read_detail(p)
        self.assertIn('shell', d.tools)

    def test_last_user_ignores_injected_response_item_uses_event_user_message(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            event_user_message('what the user actually typed', '2026-09-24T01:30:31Z'),
            assistant_message('an answer', '2026-09-24T01:30:32Z'),
            # A later response_item role=user (Codex's own reconstructed
            # context for the *next* model call) must never override last_user.
            user_message('# AGENTS.md instructions for /Users/x\n...', '2026-09-24T01:30:33Z'),
        ])
        d = detail.read_detail(p)
        self.assertEqual(d.last_user, 'what the user actually typed')

    def test_last_user_skips_filtered_candidates_for_an_earlier_real_one(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            event_user_message('the real last thing said', '2026-09-24T01:30:31Z'),
            assistant_message('ok', '2026-09-24T01:30:32Z'),
            event_user_message('/compact', '2026-09-24T01:30:33Z'),
        ])
        d = detail.read_detail(p)
        self.assertEqual(d.last_user, 'the real last thing said')

    def test_last_user_reads_item_completed_user_message_newer_cli_versions(self):
        # T-101: Codex CLI 0.156.1 has no user_message events at all, only
        # item_completed(UserMessage).
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            user_message('<environment_context>\ninjected', '2026-09-24T01:30:31Z'),
            item_completed_user_message('現在利用可能なツールを教えて。', '2026-09-24T01:30:32Z'),
            assistant_message('answer', '2026-09-24T01:30:33Z'),
        ])
        d = detail.read_detail(p)
        self.assertEqual(d.last_user, '現在利用可能なツールを教えて。')

    def test_last_user_falls_back_to_filtered_response_item_as_last_resort(self):
        # Neither item_completed(UserMessage) nor user_message at all.
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            user_message('<environment_context>\ninjected', '2026-09-24T01:30:31Z'),
            user_message('what tools are available?', '2026-09-24T01:30:32Z'),
        ])
        d = detail.read_detail(p)
        self.assertEqual(d.last_user, 'what tools are available?')


if __name__ == '__main__':
    unittest.main()

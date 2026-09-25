import tempfile
import unittest

from agentsessions.agents.codex import live
from agentsessions.sessions.model import Session
from tests.agents.codex_helpers import event, rollout_path, session_meta, write_rollout

ID1 = '02000000-0000-0000-0000-000000000001'
ID2 = '02000000-0000-0000-0000-000000000002'
ID3 = '02000000-0000-0000-0000-000000000003'


def _session(path, cwd='/work/x'):
    return Session(id='x', name=None, cwd=cwd, mtime=0.0, path=path, agent='codex')


class TestCodexLive(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name

    def test_busy_when_task_started_has_no_completion_after_it(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            event('task_started', '2026-09-24T01:30:31Z'),
        ])
        sessions = {ID1: _session(p)}
        result = live.live_sessions(sessions)
        self.assertEqual(result[ID1].status, 'busy')

    def test_idle_when_task_complete_follows_task_started(self):
        p = rollout_path(self.home, ID2)
        write_rollout(p, [
            session_meta(ID2, '/work/two'),
            event('task_started', '2026-09-24T01:30:31Z'),
            event('task_complete', '2026-09-24T01:30:40Z'),
        ])
        sessions = {ID2: _session(p)}
        result = live.live_sessions(sessions)
        self.assertNotIn(ID2, result)   # idle sessions are left out entirely

    def test_waiting_for_approval_event(self):
        p = rollout_path(self.home, ID3)
        write_rollout(p, [
            session_meta(ID3, '/work/three'),
            event('task_started', '2026-09-24T01:30:31Z'),
            event('exec_approval_request', '2026-09-24T01:30:35Z'),
        ])
        sessions = {ID3: _session(p)}
        result = live.live_sessions(sessions)
        self.assertEqual(result[ID3].status, 'waiting')
        self.assertEqual(result[ID3].waiting_for, 'exec_approval_request')

    def test_turn_aborted_is_idle(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            event('task_started', '2026-09-24T01:30:31Z'),
            event('turn_aborted', '2026-09-24T01:30:33Z'),
        ])
        sessions = {ID1: _session(p)}
        result = live.live_sessions(sessions)
        self.assertNotIn(ID1, result)


if __name__ == '__main__':
    unittest.main()

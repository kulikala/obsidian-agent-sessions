import json
import os
import time
import unittest
from unittest import mock

from agentsessions import config
from agentsessions.agents import opencode
from agentsessions.agents.opencode import live
from tests.agents.opencode_helpers import Fixture, make_db
from tests.agents.test_opencode_scan import S1, S2, OpencodeCase

DEAD_PID = 2 ** 22 + 12345   # beyond any real pid_max default; kill(pid, 0) fails


class TestLive(OpencodeCase):
    def setUp(self):
        super().setUp()
        self.status_dir = os.path.join(self.tmp, 'status')
        os.makedirs(self.status_dir)
        p = mock.patch.object(config, 'OPENCODE_STATUS_DIR', self.status_dir)
        p.start()
        self.addCleanup(p.stop)

    def _status(self, sid, status='busy', pid=None, waiting_for='', updated_at=123.5):
        with open(os.path.join(self.status_dir, sid + '.json'), 'w') as f:
            json.dump({'status': status, 'waiting_for': waiting_for, 'cwd': '/w',
                       'pid': os.getpid() if pid is None else pid, 'updated_at': updated_at}, f)

    def test_status_files_of_live_processes(self):
        self._status(S1, 'busy')
        self._status(S2, 'waiting', waiting_for='permission')
        out = opencode.live_sessions({})
        self.assertEqual(out[S1].status, 'busy')
        self.assertEqual(out[S1].pid, os.getpid())
        self.assertEqual(out[S1].updated_at, 123.5)
        self.assertEqual((out[S2].status, out[S2].waiting_for), ('waiting', 'permission'))

    def test_idle_is_reported(self):
        self._status(S1, 'idle')
        self.assertEqual(opencode.live_sessions({})[S1].status, 'idle')

    def test_dead_pid_file_is_ignored_and_removed(self):
        self._status(S1, 'busy', pid=DEAD_PID)
        self.assertEqual(opencode.live_sessions({}), {})
        self.assertFalse(os.path.exists(os.path.join(self.status_dir, S1 + '.json')))

    def test_garbage_and_unknown_statuses_are_skipped(self):
        with open(os.path.join(self.status_dir, S1 + '.json'), 'w') as f:
            f.write('{not json')
        self._status(S2, 'exploding')
        with open(os.path.join(self.status_dir, '.hidden.json'), 'w') as f:
            f.write('{}')
        self.assertEqual(opencode.live_sessions({}), {})

    def test_missing_directory(self):
        os.rmdir(self.status_dir)
        self.assertEqual(opencode.live_sessions({}), {})

    def _unfinished(self, updated_ms):
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1, updated=updated_ms)
            f.user(S1, 'work on it', updated_ms - 100)
            f.assistant(S1, '', updated_ms, completed=False)
        return opencode.scan(opencode.list_transcripts())

    def test_fallback_unfinished_assistant_message_with_a_running_process_is_busy(self):
        scanned = self._unfinished(int(time.time() * 1000))
        with mock.patch.object(live, '_opencode_pids', return_value=[4242]):
            out = opencode.live_sessions(scanned)
        self.assertEqual((out[S1].status, out[S1].pid), ('busy', 4242))

    def test_fallback_needs_a_process(self):
        scanned = self._unfinished(int(time.time() * 1000))
        with mock.patch.object(live, '_opencode_pids', return_value=[]):
            self.assertEqual(opencode.live_sessions(scanned), {})

    def test_fallback_needs_recent_activity(self):
        stale = self._unfinished(int((time.time() - 3600) * 1000))
        with mock.patch.object(live, '_opencode_pids', return_value=[4242]):
            self.assertEqual(opencode.live_sessions(stale), {})

    def test_fallback_ignores_a_finished_turn(self):
        path = make_db(self.tmp)
        now = int(time.time() * 1000)
        with Fixture(path) as f:
            f.session(S1, updated=now)
            f.user(S1, 'q', now - 100)
            f.assistant(S1, 'done', now - 50)
        scanned = opencode.scan(opencode.list_transcripts())
        with mock.patch.object(live, '_opencode_pids', return_value=[4242]):
            self.assertEqual(opencode.live_sessions(scanned), {})

    def test_status_file_wins_over_fallback(self):
        scanned = self._unfinished(int(time.time() * 1000))
        self._status(S1, 'idle')
        with mock.patch.object(live, '_opencode_pids', return_value=[4242]):
            self.assertEqual(opencode.live_sessions(scanned)[S1].status, 'idle')

    def test_without_a_scan_the_recent_sessions_come_from_one_cheap_query(self):
        self._unfinished(int(time.time() * 1000))
        with mock.patch.object(live, '_opencode_pids', return_value=[4242]), \
                mock.patch.object(opencode, 'scan', side_effect=AssertionError('no scan')), \
                mock.patch.object(opencode._scan, 'eligible_sessions', side_effect=AssertionError('no scan')):
            out = opencode.live_sessions()
        self.assertEqual((out[S1].status, out[S1].pid), ('busy', 4242))

    def test_cheap_query_skips_old_and_sub_agent_sessions(self):
        path = make_db(self.tmp)
        now = int(time.time() * 1000)
        with Fixture(path) as f:
            f.session(S1, updated=now - 3_600_000)
            f.user(S1, 'q', now - 3_600_100)
            f.assistant(S1, '', now - 3_600_000, completed=False)
            f.session(S2, updated=now, parent_id=S1)
            f.user(S2, 'q', now - 100)
            f.assistant(S2, '', now, completed=False)
        with mock.patch.object(live, '_opencode_pids', return_value=[4242]):
            self.assertEqual(opencode.live_sessions(), {})


if __name__ == '__main__':
    unittest.main()

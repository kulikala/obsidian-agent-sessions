import json
import os
import unittest
from unittest import mock

from agentsessions import config, paths
from agentsessions.agents import opencode
from agentsessions.agents.opencode import resolve as ocresolve
from tests.agents.opencode_helpers import Fixture, make_db
from tests.agents.test_opencode_scan import S1, S2, OpencodeCase

S3 = 'ses_aaaaaaaaaaaa03'


class TestResolve(OpencodeCase):
    def setUp(self):
        super().setUp()
        self.status_dir = os.path.join(self.tmp, 'status')
        os.makedirs(self.status_dir)
        self.path = make_db(self.tmp)

    def _resolve(self, pid=0, since=5.0, cwd='/work/x', already=None):
        with mock.patch.object(ocresolve, '_ps_tree', return_value=[]):
            return opencode.resolve.resolve(pid, since, cwd, already_linked=already,
                                            status_dir=self.status_dir)

    def test_no_database(self):
        os.unlink(self.path)
        self.assertEqual(self._resolve(), (None, None))

    def test_the_one_matching_session_is_found(self):
        with Fixture(self.path) as f:
            f.session(S1, directory='/work/x', created=6_000)
            f.session(S3, directory='/work/other', created=10_000)
        self.assertEqual(self._resolve(), (S1, 'opencode:' + S1))

    def test_more_than_one_candidate_is_ambiguous_and_resolves_to_nothing(self):
        with Fixture(self.path) as f:
            f.session(S1, directory='/work/x', created=6_000)
            f.session(S2, directory='/work/x', created=9_000)
        self.assertEqual(self._resolve(), (None, None))
        # once one of them is linked (to another tab), the other is unambiguous
        self.assertEqual(self._resolve(already={S1}), (S2, 'opencode:' + S2))

    def test_opencode_run_sessions_are_skipped(self):
        deny_question = [{'permission': 'question', 'pattern': '*', 'action': 'deny'}]
        with Fixture(self.path) as f:
            f.session(S1, directory='/work/x', created=6_000, permission=deny_question)
            f.session(S2, directory='/work/x', created=9_000)
        self.assertEqual(self._resolve(), (S2, 'opencode:' + S2))
        with Fixture(self.path) as f:
            f.conn.execute('DELETE FROM session WHERE id = ?', (S2,))
        self.assertEqual(self._resolve(), (None, None))

    def test_session_row_without_messages_counts(self):
        with Fixture(self.path) as f:
            f.session(S1, directory='/work/x', created=6_000)
        self.assertEqual(self._resolve()[0], S1)

    def test_since_child_and_already_linked_are_excluded(self):
        with Fixture(self.path) as f:
            f.session(S1, directory='/work/x', created=4_999)                   # before `since`
            f.session(S2, directory='/work/x', created=6_000, parent_id=S1)     # a sub-agent's
            f.session(S3, directory='/work/x', created=7_000)
        self.assertEqual(self._resolve(already={S3}), (None, None))
        self.assertEqual(self._resolve()[0], S3)

    def test_windows_directory_matches_however_it_is_spelled(self):
        with Fixture(self.path) as f:
            f.session(S1, directory='C:\\Users\\Me\\Vault', created=6_000)
            f.session(S2, directory='C:\\Users\\Me\\Other', created=7_000)
        with mock.patch.object(paths, 'IS_WINDOWS', True):
            self.assertEqual(self._resolve(cwd='c:/users/me/vault/')[0], S1)
        with mock.patch.object(paths, 'IS_WINDOWS', False):
            self.assertEqual(self._resolve(cwd='c:/users/me/vault/'), (None, None))

    def test_status_file_of_the_process_tree_is_exact(self):
        with Fixture(self.path) as f:
            f.session(S1, directory='/work/x', created=6_000)
            f.session(S2, directory='/work/x', created=9_000)   # newer, but not ours
        with open(os.path.join(self.status_dir, S1 + '.json'), 'w') as fh:
            json.dump({'status': 'busy', 'pid': os.getpid()}, fh)
        with mock.patch.object(ocresolve, '_ps_tree', return_value=[(os.getpid(), 77)]):
            got = opencode.resolve.resolve(77, 5.0, '/work/x', already_linked=set(), status_dir=self.status_dir)
        self.assertEqual(got, (S1, 'opencode:' + S1))


if __name__ == '__main__':
    unittest.main()

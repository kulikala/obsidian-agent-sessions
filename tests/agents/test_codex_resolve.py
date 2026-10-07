import tempfile
import unittest
from unittest import mock

from agentsessions import paths, procs
from agentsessions.agents.codex import resolve
from tests.agents.codex_helpers import rollout_path, session_meta, user_message, write_rollout

ID1 = '05000000-0000-0000-0000-000000000001'
ID2 = '05000000-0000-0000-0000-000000000002'


class TestChildPids(unittest.TestCase):
    def test_finds_all_descendants(self):
        # 1 -> 2 -> 4, 1 -> 3
        procs = [(2, 1), (3, 1), (4, 2), (99, 50)]
        self.assertEqual(set(resolve.child_pids(1, procs)), {1, 2, 3, 4})

    def test_root_with_no_children(self):
        self.assertEqual(resolve.child_pids(7, [(2, 1)]), [7])


class TestParseLsofFn(unittest.TestCase):
    def test_extracts_only_name_lines(self):
        text = 'p1234\nfcwd\nn/Users/x/project\nftxt\nn/bin/zsh\nf10\nn/dev/null\n'
        self.assertEqual(resolve.parse_lsof_fn(text),
                          ['/Users/x/project', '/bin/zsh', '/dev/null'])

    def test_empty_input(self):
        self.assertEqual(resolve.parse_lsof_fn(''), [])


class TestPickFallback(unittest.TestCase):
    def test_picks_newest_matching_cwd_and_source(self):
        candidates = [
            ('old', '/p/old.jsonl', 100.0, '/work/x', 'cli'),
            ('new', '/p/new.jsonl', 200.0, '/work/x', 'cli'),
            ('wrong-cwd', '/p/w.jsonl', 300.0, '/work/y', 'cli'),
            ('wrong-source', '/p/s.jsonl', 400.0, '/work/x', 'vscode'),
        ]
        picked = resolve.pick_fallback(candidates, since=50.0, cwd='/work/x', already_linked=set())
        self.assertEqual(picked, ('new', '/p/new.jsonl'))

    def test_excludes_already_linked(self):
        candidates = [('claimed', '/p/c.jsonl', 200.0, '/work/x', 'cli')]
        picked = resolve.pick_fallback(candidates, since=0.0, cwd='/work/x', already_linked={'claimed'})
        self.assertIsNone(picked)

    def test_windows_cwd_matches_however_it_is_spelled(self):
        candidates = [('win', 'C:\\c\\w.jsonl', 200.0, 'C:\\Users\\Me\\Vault', 'cli')]
        with mock.patch.object(paths, 'IS_WINDOWS', True):
            picked = resolve.pick_fallback(candidates, since=0.0, cwd='c:/users/me/vault/', already_linked=set())
        self.assertEqual(picked, ('win', 'C:\\c\\w.jsonl'))
        with mock.patch.object(paths, 'IS_WINDOWS', False):
            self.assertIsNone(resolve.pick_fallback(candidates, since=0.0, cwd='c:/users/me/vault/', already_linked=set()))

    def test_excludes_before_since(self):
        candidates = [('too-old', '/p/o.jsonl', 10.0, '/work/x', 'cli')]
        picked = resolve.pick_fallback(candidates, since=50.0, cwd='/work/x', already_linked=set())
        self.assertIsNone(picked)


class TestWindowsProcesses(unittest.TestCase):
    def test_rollout_path_shape_with_backslashes(self):
        self.assertTrue(resolve._ROLLOUT_PATH_RE.search(
            'C:\\Users\\a\\.codex\\sessions\\2026\\10\\06\\rollout-2026-10-06T01-02-03-x.jsonl'))
        self.assertTrue(resolve._ROLLOUT_PATH_RE.search('/h/.codex/sessions/2026/10/06/rollout-x.jsonl'))
        self.assertFalse(resolve._ROLLOUT_PATH_RE.search('C:\\Users\\a\\notes\\rollout-x.jsonl'))

    def test_process_tree_comes_from_the_platform_table(self):
        with mock.patch.object(procs, 'parent_table', return_value={10: 1, 11: 10}):
            self.assertEqual(sorted(resolve._ps_tree()), [(10, 1), (11, 10)])
        with mock.patch.object(procs, 'parent_table', return_value=None):
            self.assertEqual(resolve._ps_tree(), [])

    def test_no_open_file_inspection_on_windows(self):
        with mock.patch.object(procs, 'IS_WINDOWS', True), \
                mock.patch.object(resolve, '_open_paths', side_effect=AssertionError('not on Windows')):
            self.assertIsNone(resolve.rollout_open_by(1234))


class TestResolveEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name

    def test_falls_back_to_session_meta_when_no_open_fd_found(self):
        p = rollout_path(self.home, ID1, ts='2026-09-24T01-30-30')
        write_rollout(p, [
            session_meta(ID1, '/work/proj', source='cli', ts='2026-09-24T01:30:30.000Z'),
            user_message('hi', '2026-09-24T01:30:31Z'),
        ])
        # pid 999999999 realistically has no open fds matching a rollout, so this
        # exercises the fallback path deterministically without mocking `ps`/`lsof`.
        thread, transcript = resolve.resolve(999999999, since=1700000000.0, cwd='/work/proj', home=self.home)
        self.assertEqual(thread, ID1)
        self.assertEqual(transcript, p)

    def test_returns_none_none_when_nothing_matches(self):
        thread, transcript = resolve.resolve(999999999, since=1700000000.0, cwd='/no/such/cwd', home=self.home)
        self.assertIsNone(thread)
        self.assertIsNone(transcript)

    def test_already_linked_thread_is_skipped_even_if_otherwise_matching(self):
        p = rollout_path(self.home, ID2, ts='2026-09-24T01-30-30')
        write_rollout(p, [
            session_meta(ID2, '/work/proj', source='cli', ts='2026-09-24T01:30:30.000Z'),
            user_message('hi', '2026-09-24T01:30:31Z'),
        ])
        thread, transcript = resolve.resolve(999999999, since=0.0, cwd='/work/proj', home=self.home,
                                              already_linked={ID2})
        self.assertIsNone(thread)


class TestNewThread(unittest.TestCase):
    """`/new` or `/clear` in a linked tab: a thread the same process started after `since`."""

    SINCE = 1790213400.0   # 2026-09-24T01:30:00Z

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name

    def _rollout(self, thread, ts='2026-09-24T01:31:00.000Z', **meta):
        p = rollout_path(self.home, thread, ts=ts[:19].replace(':', '-'))
        rec = session_meta(thread, '/work/proj', ts=ts)
        rec['payload'].update(meta)
        write_rollout(p, [rec, user_message('hi', ts)])
        return p

    def _new(self, open_by_child, already=None):
        """Codex at pid 77 with a child 78 that has `open_by_child` open."""
        with mock.patch.object(procs, 'IS_WINDOWS', False), \
                mock.patch.object(resolve, '_ps_tree', return_value=[(78, 77)]), \
                mock.patch.object(resolve, '_open_paths', side_effect=lambda pid: open_by_child if pid == 78 else []):
            return resolve.new_thread(77, self.SINCE, home=self.home, already_linked=already)

    def test_the_new_thread_open_in_the_process_is_found(self):
        old = self._rollout(ID1, ts='2026-09-24T01:20:00.000Z')
        new = self._rollout(ID2)
        self.assertEqual(self._new([old, new], already={ID1}), (ID2, new))

    def test_linked_threads_and_threads_of_other_processes_do_not_count(self):
        new = self._rollout(ID2)
        self.assertEqual(self._new([new], already={ID2}), (None, None))
        self.assertEqual(self._new([]), (None, None))

    def test_a_resumed_thread_began_before_since(self):
        old = self._rollout(ID1, ts='2026-09-24T01:20:00.000Z')
        self.assertEqual(self._new([old]), (None, None))

    def test_a_fork_and_a_headless_thread_do_not_count(self):
        fork = self._rollout(ID1, forked_from_id=ID2)
        other = self._rollout(ID2, source='exec')
        self.assertEqual(self._new([fork, other]), (None, None))

    def test_the_newest_wins(self):
        first = self._rollout(ID1, ts='2026-09-24T01:31:00.000Z')
        second = self._rollout(ID2, ts='2026-09-24T01:32:00.000Z')
        self.assertEqual(self._new([first, second])[0], ID2)

    def test_windows_asks_the_restart_manager_who_has_the_file_open(self):
        new = self._rollout(ID2)
        with mock.patch.object(procs, 'IS_WINDOWS', True), \
                mock.patch.object(resolve, '_ps_tree', return_value=[(78, 77)]), \
                mock.patch.object(resolve, '_open_paths', side_effect=AssertionError('not on Windows')):
            with mock.patch.object(procs, 'file_users', return_value=[78]):
                self.assertEqual(resolve.new_thread(77, self.SINCE, home=self.home), (ID2, new))
            with mock.patch.object(procs, 'file_users', return_value=[5]):
                self.assertEqual(resolve.new_thread(77, self.SINCE, home=self.home), (None, None))
            with mock.patch.object(procs, 'file_users', return_value=None):
                self.assertEqual(resolve.new_thread(77, self.SINCE, home=self.home), (None, None))


if __name__ == '__main__':
    unittest.main()

import tempfile
import unittest

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

    def test_excludes_before_since(self):
        candidates = [('too-old', '/p/o.jsonl', 10.0, '/work/x', 'cli')]
        picked = resolve.pick_fallback(candidates, since=50.0, cwd='/work/x', already_linked=set())
        self.assertIsNone(picked)


class TestResolveEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
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


if __name__ == '__main__':
    unittest.main()

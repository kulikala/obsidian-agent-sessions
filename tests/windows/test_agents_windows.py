"""Codex and OpenCode on native Windows: process trees, folder matching, SQLite paths.

Runs only on Windows (CI's windows-latest job); everywhere else the module is skipped.
"""
import os
import sqlite3
import sys
import tempfile
import unittest

from agentsessions import paths, procs
from agentsessions.agents.codex import resolve as codex_resolve
from agentsessions.agents.opencode import db as opencode_db
from agentsessions.agents.opencode import live as opencode_live
from tests.agents.codex_helpers import rollout_path, session_meta, write_rollout

ON_WINDOWS = sys.platform == 'win32'
THREAD = '02000000-0000-0000-0000-0000000000a1'


@unittest.skipUnless(ON_WINDOWS, 'Windows only')
class WindowsAgentsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_process_tree_holds_this_python_and_its_parent(self) -> None:
        tree = dict(codex_resolve._ps_tree())
        self.assertIn(os.getpid(), tree)
        self.assertIn(os.getpid(), codex_resolve.child_pids(tree[os.getpid()], list(tree.items())))

    def test_restart_manager_names_the_process_holding_a_file(self) -> None:
        path = os.path.join(self.tmp.name, 'open.jsonl')
        with open(path, 'w') as held:
            held.write('x')
            held.flush()
            self.assertIn(os.getpid(), procs.file_users(path) or [])
        self.assertNotIn(os.getpid(), procs.file_users(path) or [])

    def test_no_opencode_is_not_an_error(self) -> None:
        self.assertIsInstance(opencode_live._opencode_pids(), list)
        self.assertTrue(opencode_live.is_opencode_program('opencode.exe'))

    def test_this_folder_however_it_is_spelled(self) -> None:
        cwd = os.getcwd()
        for other in (cwd.lower(), cwd.upper() + '\\', cwd.replace('\\', '/'), '\\\\?\\' + cwd):
            self.assertTrue(paths.same_folder(cwd, other), other)

    def test_sqlite_opens_a_drive_path_read_only_without_a_copy(self) -> None:
        folder = os.path.join(self.tmp.name, 'open code')
        os.makedirs(folder)
        path = os.path.join(folder, opencode_db.DB_FILENAME)
        conn = sqlite3.connect(path)
        conn.execute('CREATE TABLE session (id TEXT)')
        conn.commit()
        conn.close()
        d = opencode_db.open_db(path)
        self.assertIsNotNone(d)
        try:
            self.assertIsNone(d._tmpdir)
            self.assertEqual(d.query('SELECT count(*) AS n FROM session')[0]['n'], 0)
        finally:
            d.close()

    def test_codex_resolve_matches_a_differently_spelled_cwd(self) -> None:
        home = self.tmp.name
        p = rollout_path(home, THREAD)
        write_rollout(p, [session_meta(THREAD, 'C:\\Work\\Proj')])
        self.assertEqual(codex_resolve.resolve(os.getpid(), 0.0, 'c:/work/proj/', home=home), (THREAD, p))


if __name__ == '__main__':
    unittest.main()

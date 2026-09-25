import os
import sqlite3
import tempfile
import unittest
from unittest import mock

import importlib

from agentsessions.agents.codex import rollout
from agentsessions.agents.codex import names as names_mod
# NB: `agentsessions.agents.codex` (the package __init__) binds the name `scan` to
# its own wrapper *function*, shadowing the `scan` *submodule* of the same name --
# so the submodule is fetched by its full dotted path, not `from ...codex import scan`.
scan = importlib.import_module('agentsessions.agents.codex.scan')
from tests.agents.codex_helpers import (
    assistant_message, rollout_path, session_meta, turn_context, user_message,
    write_rollout,
)

ID1 = '01000000-0000-0000-0000-000000000001'
ID2 = '01000000-0000-0000-0000-000000000002'
ID3 = '01000000-0000-0000-0000-000000000003'


class TestCodexScan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name

    def test_list_transcripts_finds_rollouts_by_uuid_suffix(self):
        p1 = rollout_path(self.home, ID1)
        write_rollout(p1, [session_meta(ID1, '/work/one')])
        not_a_rollout = os.path.join(self.home, 'sessions', '2026', '09', '24', 'not-a-rollout.jsonl')
        write_rollout(not_a_rollout, [{'x': 1}])
        found = rollout.list_transcripts(self.home)
        self.assertEqual(found, [p1])

    def test_scan_reads_cwd_and_first_user_message_and_child_flag(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one', source='vscode'),
            turn_context(),
            user_message('hello from codex\nsecond line', '2026-09-24T01:30:31Z'),
            assistant_message('hi there', '2026-09-24T01:30:32Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertIn(ID1, result)
        s = result[ID1]
        self.assertEqual(s.cwd, '/work/one')
        self.assertEqual(s.first_prompt, 'hello from codex')
        self.assertTrue(s.child)   # source == 'vscode' != 'cli'
        self.assertEqual(s.agent, 'codex')
        self.assertIsNone(s.name)   # no /rename in this fixture's sqlite (none provided)

    def test_scan_drops_sessions_with_no_prompt_and_no_name(self):
        p = rollout_path(self.home, ID2)
        write_rollout(p, [session_meta(ID2, '/work/two')])   # no response_item at all
        result = scan.scan([p], home=self.home)
        self.assertNotIn(ID2, result)

    def test_scan_child_false_for_source_cli(self):
        p = rollout_path(self.home, ID3)
        write_rollout(p, [
            session_meta(ID3, '/work/three', source='cli'),
            user_message('a cli-originated prompt', '2026-09-24T01:30:31Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertFalse(result[ID3].child)

    def test_scan_uses_renamed_name_from_sqlite_over_first_prompt(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            user_message('the raw first prompt', '2026-09-24T01:30:31Z'),
        ])
        db = os.path.join(self.home, names_mod.DB_FILENAME)
        conn = sqlite3.connect(db)
        conn.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT)')
        conn.execute('INSERT INTO threads (id, name) VALUES (?, ?)', (ID1, 'My Renamed Thread'))
        conn.commit()
        conn.close()
        result = scan.scan([p], home=self.home)
        self.assertEqual(result[ID1].name, 'My Renamed Thread')

    def test_scan_reuses_cache_when_mtime_size_match_and_not_racy(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [session_meta(ID1, '/work/one'), user_message('hi', '2026-09-24T01:30:31Z')])
        st = os.stat(p)
        old_mtime = st.st_mtime - 100   # outside the RACY_WINDOW
        os.utime(p, (old_mtime, old_mtime))
        st = os.stat(p)
        cache = {p: {'mtime': st.st_mtime, 'size': st.st_size,
                     'head': {'cwd': '/cached/cwd', 'prompt': 'cached prompt', 'child': True, 'source': 'vscode'},
                     'last_activity': 12345.0}}
        result = scan.scan([p], cache=cache, home=self.home)
        self.assertEqual(result[ID1].cwd, '/cached/cwd')
        self.assertEqual(result[ID1].first_prompt, 'cached prompt')
        self.assertEqual(result[ID1].mtime, 12345.0)

    def test_codex_home_env_override(self):
        with mock.patch.dict(os.environ, {'CODEX_HOME': '/custom/codex/home'}):
            self.assertEqual(rollout.codex_home(), '/custom/codex/home')


if __name__ == '__main__':
    unittest.main()

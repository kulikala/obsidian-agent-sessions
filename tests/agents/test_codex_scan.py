import os
import sqlite3
import tempfile
import unittest
from unittest import mock

import importlib

from agentsessions import config
from agentsessions.agents.codex import rollout
from agentsessions.agents.codex import names as names_mod
# NB: `agentsessions.agents.codex` (the package __init__) binds the name `scan` to
# its own wrapper *function*, shadowing the `scan` *submodule* of the same name --
# so the submodule is fetched by its full dotted path, not `from ...codex import scan`.
scan = importlib.import_module('agentsessions.agents.codex.scan')
from tests.agents.codex_helpers import (
    assistant_message, event_user_message, item_completed_user_message, rollout_path,
    session_meta, turn_context, turn_context_old_format, user_message, write_rollout,
)

ID1 = '01000000-0000-0000-0000-000000000001'
ID2 = '01000000-0000-0000-0000-000000000002'
ID3 = '01000000-0000-0000-0000-000000000003'


class TestCodexScan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        # T-105's last-known-name fallback persists to a file on disk by
        # default (config.CODEX_NAMES_CACHE_PATH) -- isolate it per test so
        # one test's sqlite entry can't leak into another's (fixed IDs are
        # reused across tests in this file) or into this machine's real cache.
        self._names_cache_patch = mock.patch.object(
            config, 'CODEX_NAMES_CACHE_PATH', os.path.join(self.home, 'codex-names-cache.json'))
        self._names_cache_patch.start()
        self.addCleanup(self._names_cache_patch.stop)

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
            event_user_message('hello from codex\nsecond line', '2026-09-24T01:30:31Z'),
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

    def test_scan_keeps_untitled_session_with_no_name_and_no_prompt(self):
        # Unlike Claude, a Codex session with nothing left after filtering is
        # still shown (untitled), not dropped -- see agents.codex.scan.scan's
        # docstring and plan/reports/T-95.md.
        p = rollout_path(self.home, ID2)
        write_rollout(p, [session_meta(ID2, '/work/two')])   # no user content at all
        result = scan.scan([p], home=self.home)
        self.assertIn(ID2, result)
        self.assertIsNone(result[ID2].name)
        self.assertEqual(result[ID2].first_prompt, '')

    def test_scan_child_false_for_source_cli(self):
        p = rollout_path(self.home, ID3)
        write_rollout(p, [
            session_meta(ID3, '/work/three', source='cli'),
            event_user_message('a cli-originated prompt', '2026-09-24T01:30:31Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertFalse(result[ID3].child)

    def test_scan_uses_renamed_name_from_sqlite_over_first_prompt(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            event_user_message('the raw first prompt', '2026-09-24T01:30:31Z'),
        ])
        db = os.path.join(self.home, names_mod.DB_FILENAME)
        conn = sqlite3.connect(db)
        conn.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)')
        conn.execute('INSERT INTO threads (id, name, title) VALUES (?, ?, ?)',
                     (ID1, 'My Renamed Thread', 'the raw first prompt'))
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
                     'schema_version': scan.SCAN_SCHEMA_VERSION,
                     'head': {'cwd': '/cached/cwd', 'prompt': 'cached prompt', 'child': True, 'source': 'vscode'},
                     'last_activity': 12345.0}}
        result = scan.scan([p], cache=cache, home=self.home)
        self.assertEqual(result[ID1].cwd, '/cached/cwd')
        self.assertEqual(result[ID1].first_prompt, 'cached prompt')
        self.assertEqual(result[ID1].mtime, 12345.0)

    def test_stale_schema_version_forces_a_fresh_read_not_the_cached_value(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [session_meta(ID1, '/work/one'), event_user_message('real prompt', '2026-09-24T01:30:31Z')])
        st = os.stat(p)
        old_mtime = st.st_mtime - 100
        os.utime(p, (old_mtime, old_mtime))
        st = os.stat(p)
        cache = {p: {'mtime': st.st_mtime, 'size': st.st_size,
                     'schema_version': scan.SCAN_SCHEMA_VERSION - 1,   # stale on purpose
                     'head': {'cwd': '/stale/cwd', 'prompt': 'stale prompt', 'child': True, 'source': 'vscode'},
                     'last_activity': 12345.0}}
        result = scan.scan([p], cache=cache, home=self.home)
        self.assertEqual(result[ID1].cwd, '/work/one')
        self.assertEqual(result[ID1].first_prompt, 'real prompt')
        self.assertEqual(cache[p]['schema_version'], scan.SCAN_SCHEMA_VERSION)   # re-written with the current version

    def test_codex_home_env_override(self):
        with mock.patch.dict(os.environ, {'CODEX_HOME': '/custom/codex/home'}):
            self.assertEqual(rollout.codex_home(), '/custom/codex/home')


class TestCodexPromptFiltering(unittest.TestCase):
    """The bug this covers: a Codex session's displayed name was showing
    injected context (e.g. "# AGENTS.md instructions for /Users/...") or a bare
    slash command (e.g. "/exit") instead of what the user actually typed --
    both real, observed cases (see plan/reports/T-95.md)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        # T-105's last-known-name fallback persists to a file on disk by
        # default (config.CODEX_NAMES_CACHE_PATH) -- isolate it per test so
        # one test's sqlite entry can't leak into another's (fixed IDs are
        # reused across tests in this file) or into this machine's real cache.
        self._names_cache_patch = mock.patch.object(
            config, 'CODEX_NAMES_CACHE_PATH', os.path.join(self.home, 'codex-names-cache.json'))
        self._names_cache_patch.start()
        self.addCleanup(self._names_cache_patch.stop)

    def test_injected_response_item_is_ignored_even_if_it_comes_first(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            # An injected `<recommended_plugins>`-style response_item, exactly
            # the shape real data shows preceding the real prompt.
            user_message('<recommended_plugins>\nSome injected text.', '2026-09-24T01:30:31Z'),
            event_user_message('Reply with the single word: ok', '2026-09-24T01:30:32Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertEqual(result[ID1].first_prompt, 'Reply with the single word: ok')

    def test_agents_md_injection_marker_is_skipped(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            event_user_message('# AGENTS.md instructions for /Users/kuli/project\n...', '2026-09-24T01:30:31Z'),
            event_user_message('DRAFT.md', '2026-09-24T01:30:32Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertEqual(result[ID1].first_prompt, 'DRAFT.md')

    def test_environment_context_marker_is_skipped(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            event_user_message('<environment_context>\n<cwd>/work/one</cwd>\n</environment_context>',
                                '2026-09-24T01:30:31Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertEqual(result[ID1].first_prompt, '')
        self.assertIsNone(result[ID1].name)

    def test_slash_command_only_session_is_untitled_not_dropped(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            event_user_message('/exit', '2026-09-24T01:30:31Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertIn(ID1, result)
        self.assertEqual(result[ID1].first_prompt, '')
        self.assertIsNone(result[ID1].name)

    def test_real_prompt_that_happens_to_follow_a_slash_command_is_used(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            event_user_message('/compact', '2026-09-24T01:30:31Z'),
            event_user_message('now continue with the refactor', '2026-09-24T01:30:32Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertEqual(result[ID1].first_prompt, 'now continue with the refactor')


class TestCodexNewerCliVersion(unittest.TestCase):
    """T-101: a real report -- Codex CLI 0.156.1 (codex-tui, source=cli) writes
    neither `event_msg.user_message` nor a cleanly-recoverable `response_item`
    alone; the literal typed text only shows up in `event_msg.item_completed`
    with `item.type == 'UserMessage'`. bc41b97 only recognized `user_message`,
    so these sessions got no name at all (json scan showed the raw id)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        # T-105's last-known-name fallback persists to a file on disk by
        # default (config.CODEX_NAMES_CACHE_PATH) -- isolate it per test so
        # one test's sqlite entry can't leak into another's (fixed IDs are
        # reused across tests in this file) or into this machine's real cache.
        self._names_cache_patch = mock.patch.object(
            config, 'CODEX_NAMES_CACHE_PATH', os.path.join(self.home, 'codex-names-cache.json'))
        self._names_cache_patch.start()
        self.addCleanup(self._names_cache_patch.stop)

    def test_item_completed_user_message_is_used_when_theres_no_user_message_event(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one', source='cli'),
            turn_context(),
            user_message('<environment_context>\n<cwd>/work/one</cwd>', '2026-09-24T01:30:31Z'),
            item_completed_user_message('現在利用可能なツールを教えて。', '2026-09-24T01:30:32Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertEqual(result[ID1].first_prompt, '現在利用可能なツールを教えて。')

    def test_item_completed_user_message_outranks_a_filtered_response_item(self):
        # Both present: item_completed must win even though the (filtered-out,
        # so irrelevant) response_item appears earlier in the file.
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            user_message('# AGENTS.md instructions for /Users/x\n...', '2026-09-24T01:30:31Z'),
            item_completed_user_message('the real question', '2026-09-24T01:30:32Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertEqual(result[ID1].first_prompt, 'the real question')

    def test_filtered_response_item_is_the_last_resort_when_nothing_else_exists(self):
        # Neither item_completed(UserMessage) nor user_message at all -- only
        # response_item, which must still be tried (filtered) rather than give up.
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            user_message('<environment_context>\ninjected', '2026-09-24T01:30:31Z'),
            user_message('what tools are available?', '2026-09-24T01:30:32Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertEqual(result[ID1].first_prompt, 'what tools are available?')

    def test_threads_title_outranks_rollout_extraction(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            item_completed_user_message('rollout-derived text', '2026-09-24T01:30:31Z'),
        ])
        db = os.path.join(self.home, names_mod.DB_FILENAME)
        conn = sqlite3.connect(db)
        conn.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)')
        conn.execute('INSERT INTO threads (id, title) VALUES (?, ?)', (ID1, 'sqlite title wins'))
        conn.commit()
        conn.close()
        result = scan.scan([p], home=self.home)
        self.assertEqual(result[ID1].first_prompt, 'sqlite title wins')
        self.assertIsNone(result[ID1].name)   # title isn't a /rename -- session stays unnamed

    def test_empty_threads_title_falls_back_to_rollout_extraction(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            item_completed_user_message('rollout-derived text', '2026-09-24T01:30:31Z'),
        ])
        db = os.path.join(self.home, names_mod.DB_FILENAME)
        conn = sqlite3.connect(db)
        conn.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)')
        conn.execute('INSERT INTO threads (id, title) VALUES (?, ?)', (ID1, ''))
        conn.commit()
        conn.close()
        result = scan.scan([p], home=self.home)
        self.assertEqual(result[ID1].first_prompt, 'rollout-derived text')


class TestCodexModelEffort(unittest.TestCase):
    """T-107: the session manager wants model/effort for Codex rows, the same
    way it already has them for Claude (via statusLine)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        self._names_cache_patch = mock.patch.object(
            config, 'CODEX_NAMES_CACHE_PATH', os.path.join(self.home, 'codex-names-cache.json'))
        self._names_cache_patch.start()
        self.addCleanup(self._names_cache_patch.stop)

    def test_model_and_effort_come_from_the_last_turn_context(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='gpt-5.6-luna', effort='low', ts='2026-09-24T01:30:30Z'),
            event_user_message('first', '2026-09-24T01:30:31Z'),
            turn_context(model='gpt-5.6-sol', effort='high', ts='2026-09-24T01:31:00Z'),
            event_user_message('second', '2026-09-24T01:31:01Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertEqual(result[ID1].model, 'gpt-5.6-sol')
        self.assertEqual(result[ID1].effort, 'high')

    def test_older_rollout_falls_back_to_collaboration_mode_reasoning_effort(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context_old_format(model='gpt-5.6-luna', reasoning_effort='medium'),
            event_user_message('hi', '2026-09-24T01:30:31Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertEqual(result[ID1].model, 'gpt-5.6-luna')
        self.assertEqual(result[ID1].effort, 'medium')

    def test_no_turn_context_leaves_both_none(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            event_user_message('hi', '2026-09-24T01:30:31Z'),
        ])
        result = scan.scan([p], home=self.home)
        self.assertIsNone(result[ID1].model)
        self.assertIsNone(result[ID1].effort)

    def test_model_effort_round_trip_through_cache(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='gpt-5.6-luna', effort='low'),
            event_user_message('hi', '2026-09-24T01:30:31Z'),
        ])
        st = os.stat(p)
        old_mtime = st.st_mtime - 100
        os.utime(p, (old_mtime, old_mtime))
        cache = {}
        first = scan.scan([p], cache=cache, home=self.home)
        self.assertEqual(first[ID1].model, 'gpt-5.6-luna')
        self.assertEqual(cache[p]['model'], 'gpt-5.6-luna')
        self.assertEqual(cache[p]['effort'], 'low')

        # second call: cache hit, no re-read, same values returned from the cache
        second = scan.scan([p], cache=cache, home=self.home)
        self.assertEqual(second[ID1].model, 'gpt-5.6-luna')
        self.assertEqual(second[ID1].effort, 'low')

    def test_stale_schema_version_forces_model_effort_to_be_reread(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [
            session_meta(ID1, '/work/one'),
            turn_context(model='gpt-5.6-sol', effort='high'),
            event_user_message('hi', '2026-09-24T01:30:31Z'),
        ])
        st = os.stat(p)
        old_mtime = st.st_mtime - 100
        os.utime(p, (old_mtime, old_mtime))
        st = os.stat(p)
        cache = {p: {'mtime': st.st_mtime, 'size': st.st_size,
                     'schema_version': scan.SCAN_SCHEMA_VERSION - 1,
                     'head': {'cwd': '/work/one', 'prompt': 'hi', 'child': False, 'source': 'cli'},
                     'last_activity': 12345.0}}   # pre-T-107 entry: no model/effort keys at all
        result = scan.scan([p], cache=cache, home=self.home)
        self.assertEqual(result[ID1].model, 'gpt-5.6-sol')
        self.assertEqual(result[ID1].effort, 'high')


if __name__ == '__main__':
    unittest.main()

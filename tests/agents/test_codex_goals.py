import importlib
import os
import sqlite3
import tempfile
import unittest
from unittest import mock

from agentsessions import config
from agentsessions.agents.codex import goals, rollout
from tests.agents.codex_helpers import event_user_message, rollout_path, session_meta, write_rollout

# `agentsessions.agents.codex.scan` is shadowed by the package's own `scan` function.
scan = importlib.import_module('agentsessions.agents.codex.scan')

ID1 = '08000000-0000-0000-0000-000000000001'
ID2 = '08000000-0000-0000-0000-000000000002'
ID3 = '08000000-0000-0000-0000-000000000003'

# `thread_goals` as Codex creates it in `goals_1.sqlite` (codex-cli 0.160.1).
THREAD_GOALS_SCHEMA = """
CREATE TABLE thread_goals (
    thread_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
        'active',
        'paused',
        'blocked',
        'usage_limited',
        'budget_limited',
        'complete'
    )),
    token_budget INTEGER,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
)
"""


def write_goals_db(home: str, rows) -> str:
    """A WAL-mode `goals_1.sqlite` with `rows` = [(thread_id, objective, status, created_at_ms,
    updated_at_ms), ...]."""
    db = os.path.join(home, goals.DB_FILENAME)
    conn = sqlite3.connect(db)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute(THREAD_GOALS_SCHEMA)
    conn.executemany(
        'INSERT INTO thread_goals (thread_id, goal_id, objective, status, token_budget, tokens_used,'
        ' time_used_seconds, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, NULL, 10083, 30, ?, ?)',
        [(tid, 'd88fc81c-906c-4361-9d0f-fc166f0e3ff7', obj, st, c, u) for tid, obj, st, c, u in rows])
    conn.commit()
    conn.close()
    return db


class TestGoalFromRow(unittest.TestCase):
    def test_active(self):
        self.assertEqual(goals.goal_from_row('Ship it', 'active', 1791346396911, 1791346396911), {
            'condition': 'Ship it', 'met': False, 'reason': None,
            'since': 1791346396.911, 'updated': 1791346396.911, 'status': 'active'})

    def test_complete_is_met(self):
        g = goals.goal_from_row('Ship it', 'complete', 1791346396911, 1791346427007)
        self.assertTrue(g['met'])
        self.assertNotIn('failed', g)
        self.assertEqual(g['updated'], 1791346427.007)

    def test_paused_is_its_own_state_not_a_failure(self):
        g = goals.goal_from_row('Ship it', 'paused', 1000, 2000)
        self.assertEqual(g['status'], 'paused')
        self.assertFalse(g['met'])
        self.assertNotIn('failed', g)

    def test_stopped_statuses_are_failed(self):
        for status in ('blocked', 'usage_limited', 'budget_limited'):
            g = goals.goal_from_row('Ship it', status, 1000, 2000)
            self.assertFalse(g['met'], status)
            self.assertTrue(g['failed'], status)
            self.assertEqual(g['status'], status)

    def test_unknown_status_or_empty_objective_is_no_goal(self):
        self.assertIsNone(goals.goal_from_row('Ship it', 'archived', 1000, 2000))
        self.assertIsNone(goals.goal_from_row('', 'active', 1000, 2000))


class TestLookupThreadGoals(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name

    def test_no_database_is_no_goals(self):
        self.assertEqual(goals.lookup_thread_goals(self.home, [ID1]), {})

    def test_reads_only_the_requested_threads(self):
        write_goals_db(self.home, [
            (ID1, 'Create hello.txt', 'complete', 1791346396911, 1791346427007),
            (ID2, 'Count slowly', 'paused', 1791346521879, 1791346529218),
            (ID3, 'Not asked for', 'active', 1000, 1000),
        ])
        result = goals.lookup_thread_goals(self.home, [ID1, ID2])
        self.assertEqual(set(result), {ID1, ID2})
        self.assertTrue(result[ID1]['met'])
        self.assertEqual(result[ID2]['status'], 'paused')
        self.assertNotIn('failed', result[ID2])

    def test_reads_a_database_without_wal_files(self):
        db = write_goals_db(self.home, [(ID1, 'Create hello.txt', 'active', 1000, 2000)])
        for suffix in ('-wal', '-shm'):
            if os.path.exists(db + suffix):
                os.remove(db + suffix)
        self.assertEqual(goals.lookup_thread_goals(self.home, [ID1])[ID1]['condition'], 'Create hello.txt')

    def test_follows_sqlite_home(self):
        other = os.path.join(self.home, 'db')
        os.makedirs(other)
        write_goals_db(other, [(ID1, 'Create hello.txt', 'active', 1000, 2000)])
        with open(os.path.join(self.home, 'config.toml'), 'w', encoding='utf-8') as f:
            f.write('sqlite_home = "db"\n')
        self.assertIn(ID1, goals.lookup_thread_goals(self.home, [ID1]))

    def test_a_database_without_the_table_is_no_goals(self):
        sqlite3.connect(os.path.join(self.home, goals.DB_FILENAME)).close()
        self.assertEqual(goals.lookup_thread_goals(self.home, [ID1]), {})


class TestShownGoal(unittest.TestCase):
    def test_complete_goal_shows_until_a_later_prompt(self):
        g = goals.goal_from_row('Ship it', 'complete', 1000_000, 2000_000)
        self.assertIs(goals.shown_goal(g, None), g)
        self.assertIs(goals.shown_goal(g, 1999.5), g)    # typed while the goal ran
        self.assertIsNone(goals.shown_goal(g, 2000.5))

    def test_other_statuses_stay_until_resumed_cleared_or_replaced(self):
        for status in ('active', 'paused', 'blocked', 'usage_limited', 'budget_limited'):
            g = goals.goal_from_row('Ship it', status, 1000_000, 2000_000)
            self.assertIs(goals.shown_goal(g, 9999.0), g, status)
        self.assertIsNone(goals.shown_goal(None, 9999.0))


# Rollout lines as codex-cli 0.160.1 writes them.
def typed_prompt_lines(text, ts):
    """A prompt the user typed: a `response_item` role=user message and its
    `item_completed`(UserMessage)."""
    return [
        {'timestamp': ts, 'type': 'response_item', 'payload': {
            'type': 'message', 'id': 'msg_1', 'role': 'user',
            'content': [{'type': 'input_text', 'text': text}]}},
        {'timestamp': ts, 'type': 'event_msg', 'payload': {
            'type': 'item_completed', 'thread_id': ID1, 'turn_id': 't1',
            'item': {'type': 'UserMessage', 'id': 'u1', 'content': [{'type': 'text', 'text': text}]}}},
    ]


def goal_continuation_line(ts):
    return {'timestamp': ts, 'type': 'response_item', 'payload': {
        'type': 'message', 'id': 'msg_2', 'role': 'user', 'content': [{'type': 'input_text', 'text':
            '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n'
            '</codex_internal_context>'}]}}


def update_goal_call_line(ts):
    return {'timestamp': ts, 'type': 'response_item', 'payload': {
        'type': 'function_call', 'id': 'fc_1', 'name': 'update_goal',
        'arguments': '{"status":"complete"}', 'call_id': 'call_1'}}


class TestReadLastUserPrompt(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name

    def test_finds_the_latest_typed_prompt_and_skips_codex_own_messages(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [session_meta(ID1, '/work/one'),
                          *typed_prompt_lines('Say OK.', '2026-10-07T04:24:00.757Z'),
                          goal_continuation_line('2026-10-07T04:24:05.000Z'),
                          update_goal_call_line('2026-10-07T04:24:06.686Z'),
                          {'timestamp': '2026-10-07T04:24:07.000Z', 'type': 'response_item', 'payload': {
                              'type': 'message', 'role': 'user',
                              'content': [{'type': 'input_text', 'text': '<turn_aborted>\nThe user interrupted'}]}}])
        self.assertAlmostEqual(rollout.read_last_user_prompt(p), rollout.parse_ts('2026-10-07T04:24:00.757Z'))

    def test_none_without_a_typed_prompt(self):
        p = rollout_path(self.home, ID1)
        write_rollout(p, [session_meta(ID1, '/work/one'), goal_continuation_line('2026-10-07T04:24:05.000Z')])
        self.assertIsNone(rollout.read_last_user_prompt(p))


class TestScanCarriesTheGoal(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name
        patcher = mock.patch.object(config, 'CODEX_NAMES_CACHE_PATH', os.path.join(self.home, 'names.json'))
        patcher.start()
        self.addCleanup(patcher.stop)

    def _rollout(self, sid):
        p = rollout_path(self.home, sid)
        write_rollout(p, [session_meta(sid, '/work/one'),
                          event_user_message('hello', '2026-10-07T04:13:05Z')])
        return p

    def test_goal_set_and_cleared(self):
        p1, p2 = self._rollout(ID1), self._rollout(ID2)
        db = write_goals_db(self.home, [(ID1, 'Create hello.txt', 'active', 1000, 2000)])
        result = scan.scan([p1, p2], cache={}, home=self.home)
        self.assertEqual(result[ID1].goal['condition'], 'Create hello.txt')
        self.assertIsNone(result[ID2].goal)

        # `/goal clear` deletes the row without touching the rollout; the next scan drops the goal
        # even when the rollout's head comes from the cache.
        cache = {}
        scan.scan([p1], cache=cache, home=self.home)
        conn = sqlite3.connect(db)
        conn.execute('DELETE FROM thread_goals WHERE thread_id = ?', (ID1,))
        conn.commit()
        conn.close()
        with mock.patch.object(scan, 'RACY_WINDOW', 0):
            self.assertIsNone(scan.scan([p1], cache=cache, home=self.home)[ID1].goal)


    def test_complete_goal_cleared_by_the_next_typed_prompt(self):
        verdict_ms = int(rollout.parse_ts('2026-10-07T04:24:16.344Z') * 1000)
        p = rollout_path(self.home, ID1)
        records = [session_meta(ID1, '/work/one'),
                   *typed_prompt_lines('Say OK.', '2026-10-07T04:24:00.757Z'),
                   update_goal_call_line('2026-10-07T04:24:16.300Z')]
        write_rollout(p, records)
        write_goals_db(self.home, [(ID1, 'Create bye.txt', 'complete', verdict_ms - 60000, verdict_ms)])
        cache = {}
        with mock.patch.object(scan, 'RACY_WINDOW', 0):
            self.assertTrue(scan.scan([p], cache=cache, home=self.home)[ID1].goal['met'])
            self.assertIn('last_prompt', cache[p])
            write_rollout(p, records + typed_prompt_lines('Say DONE.', '2026-10-07T04:24:41.256Z'))
            os.utime(p, (0, os.stat(p).st_mtime + 5))
            self.assertIsNone(scan.scan([p], cache=cache, home=self.home)[ID1].goal)
            # The same answer from the cached entry.
            self.assertIsNone(scan.scan([p], cache=cache, home=self.home)[ID1].goal)


if __name__ == '__main__':
    unittest.main()

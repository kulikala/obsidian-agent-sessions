import json
import os
import shutil
import stat
import tempfile
import unittest
from unittest import mock

from agentsessions.usage import claude_usage


class ParseTest(unittest.TestCase):
    def test_reads_the_two_windows_and_skips_the_rest(self):
        event = {'type': 'assistant', 'usage_report': {'rate_limits': {'limits': [
            {'kind': 'session', 'percent': 3, 'resets_at': '2026-10-16T15:10:00.118423+00:00', 'scope': None},
            {'kind': 'weekly_all', 'percent': 7, 'resets_at': '2026-10-21T16:00:00Z', 'scope': None},
            {'kind': 'weekly_scoped', 'percent': 0, 'resets_at': '2026-10-21T16:00:00Z', 'scope': {'model': {}}},
            {'kind': 'session', 'percent': 'x', 'resets_at': None},
        ]}}}
        out = claude_usage.parse_stream('{"type":"system"}\nnot json\n' + json.dumps(event) + '\n')
        self.assertEqual(out['five_hour']['used_percentage'], 3.0)
        self.assertAlmostEqual(out['five_hour']['resets_at'], 1792163400.118423, places=3)
        self.assertEqual(out['seven_day'], {'used_percentage': 7.0, 'resets_at': 1792598400.0})

    def test_a_window_that_is_not_running_has_no_reset(self):
        out = claude_usage.parse_limits([{'kind': 'session', 'percent': 0, 'resets_at': None}])
        self.assertEqual(out, {'five_hour': {'used_percentage': 0.0, 'resets_at': None}})

    def test_an_unreadable_reset_time_drops_the_entry(self):
        self.assertEqual(claude_usage.parse_limits([{'kind': 'session', 'percent': 5, 'resets_at': 'soon'}]), {})

    def test_nothing_recognisable_is_no_reading(self):
        self.assertEqual(claude_usage.parse_stream(''), {})
        self.assertEqual(claude_usage.parse_stream('{"usage_report": {"rate_limits": {"limits": null}}}'), {})


class FindClaudeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='agent-sessions-claude-usage-')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _exe(self, folder):
        os.makedirs(folder, exist_ok=True)
        p = os.path.join(folder, 'claude')
        with open(p, 'w') as f:
            f.write('#!/bin/sh\n')
        os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR)
        return p

    @unittest.skipIf(os.name == 'nt', 'POSIX executable bits')
    def test_set_path_then_login_path(self):
        login = self._exe(os.path.join(self.tmp, 'login'))
        set_path = self._exe(os.path.join(self.tmp, 'set'))
        env = {'AGENT_SESSIONS_CLAUDE_BIN': set_path, 'AGENT_SESSIONS_LOGIN_PATH': os.path.dirname(login),
               'PATH': '/nonexistent', 'HOME': self.tmp}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(claude_usage.find_claude(), set_path)
            del os.environ['AGENT_SESSIONS_CLAUDE_BIN']
            self.assertEqual(claude_usage.find_claude(), login)

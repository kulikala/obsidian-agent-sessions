import io
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from agentsessions import procs
from agentsessions.cli import json_cmd, json_output


class PpidOutputTests(unittest.TestCase):
    def test_current_process_reports_its_real_parent(self):
        got = json_output.ppid_output([os.getpid()])
        self.assertEqual(got, {'parents': {str(os.getpid()): os.getppid()}})

    def test_a_pid_that_is_not_running_is_left_out(self):
        with mock.patch.object(procs, 'parent_table', return_value={10: 1}):
            self.assertEqual(json_output.ppid_output([10, 99999999]), {'parents': {'10': 1}})

    def test_unreadable_table_is_null(self):
        with mock.patch.object(procs, 'parent_table', return_value=None):
            self.assertEqual(json_output.ppid_output([10]), {'parents': None})


class DaemonLinksTests(unittest.TestCase):
    def test_a_claude_session_linked_to_its_first_daemon_id_is_relabeled(self):
        entries = {
            'real': {'agent': 'claude', 'cwd': '/v', 'daemon': 'tab'},
            'plain': {'agent': 'claude', 'cwd': '/v'},
            'self': {'agent': 'claude', 'cwd': '/v', 'daemon': 'self'},
        }
        fake = mock.Mock(sessions=entries)
        with mock.patch.object(json_output.store, 'load', return_value=fake):
            self.assertEqual(json_output._daemon_links(), {'tab': 'real'})


class PpidCommandTests(unittest.TestCase):
    def run_cmd(self, args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = json_cmd.main(args)
        return code, out.getvalue(), err.getvalue()

    def test_prints_json_map(self):
        with mock.patch.object(procs, 'parent_table', return_value={7: 3, 8: 7}):
            code, out, _ = self.run_cmd(['ppid', '7', '8'])
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), '{"parents": {"7": 3, "8": 7}}')

    def test_needs_a_pid(self):
        code, _, err = self.run_cmd(['ppid'])
        self.assertEqual(code, 2)
        self.assertIn('ppid', err)

    def test_rejects_a_non_numeric_pid(self):
        code, _, _ = self.run_cmd(['ppid', 'abc'])
        self.assertEqual(code, 2)


if __name__ == '__main__':
    unittest.main()

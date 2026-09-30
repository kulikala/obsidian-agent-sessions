import json
import os
import tempfile
import unittest

from agentsessions.agents import launch


class TestBuildArgv(unittest.TestCase):
    def test_claude_gets_its_id_name_and_remote_control_as_flags(self):
        self.assertEqual(launch.build_argv('claude', '/c', 'ID'), ['/c', '--session-id', 'ID'])
        self.assertEqual(launch.build_argv('claude', '/c', 'ID', name='N', remote_control=True),
                         ['/c', '--session-id', 'ID', '--name', 'N', '--remote-control=N'])
        self.assertEqual(launch.build_argv('claude', '/c', 'ID', remote_control=True),
                         ['/c', '--session-id', 'ID', '--remote-control'])

    def test_a_first_message_goes_after_a_double_dash_so_it_is_never_read_as_a_flag(self):
        self.assertEqual(launch.build_argv('claude', '/c', 'ID', prompt='-x hi'),
                         ['/c', '--session-id', 'ID', '--', '-x hi'])
        self.assertEqual(launch.build_argv('codex', '/x', 'ID', prompt='hi'), ['/x', '--', 'hi'])

    def test_codex_takes_no_id_or_name(self):
        self.assertEqual(launch.build_argv('codex', '/x', 'ID', name='N'), ['/x'])

    def test_opencode_direct_and_through_ollama(self):
        self.assertEqual(launch.build_argv('opencode', '/o', 'ID', name='N'), ['/o'])
        self.assertEqual(launch.build_argv('opencode', '/o', 'ID', prompt='hi'), ['/o', '--prompt', 'hi'])
        self.assertEqual(launch.build_argv('opencode', '/o', 'ID', ollama_bin='/ol', ollama_model='m'),
                         ['/ol', 'launch', 'opencode', '--model', 'm', '-y', '--'])
        self.assertEqual(launch.build_argv('opencode', '/o', 'ID', prompt='hi', ollama_bin='/ol', ollama_model='m'),
                         ['/ol', 'launch', 'opencode', '--model', 'm', '-y', '--', '--prompt', 'hi'])


class TestBuildEnv(unittest.TestCase):
    CALLER = {
        'PATH': '/usr/bin', 'HOME': '/h', 'LANG': 'C', 'USER': 'u', 'TMPDIR': '/t', 'CLAUDE_CONFIG_DIR': '/cc',
        'CLAUDECODE': '1', 'CLAUDE_PID': '9', 'CLAUDE_EFFORT': 'high', 'AGENT_SESSIONS_ID': 'me',
        'CLAUDE_CODE_SESSION_ID': 's', 'CLAUDE_CODE_ENTRYPOINT': 'cli', 'CLAUDE_PLUGIN_ROOT': '/p',
        'CODEX_THREAD_ID': 't', 'OPENCODE_PID': '7', 'SSH_AUTH_SOCK': '/ssh',
    }

    def test_nothing_that_marks_the_caller_as_a_session_is_passed_on(self):
        env = launch.build_env('claude', self.CALLER, {}, '/bin/claude', None, None)
        self.assertEqual(set(env), {'PATH', 'HOME', 'LANG', 'USER', 'TMPDIR', 'CLAUDE_CONFIG_DIR'})

    def test_order_is_login_env_editor_vault_then_the_agents_own_variables(self):
        env = launch.build_env('claude', self.CALLER, {'VISUAL': 'mine', 'X': '1'}, '/opt/c/claude', '/vault', '/shim')
        self.assertEqual(env['VISUAL'], 'mine')   # the user's setting wins over the shim
        self.assertEqual(env['X'], '1')
        self.assertEqual(env['AGENT_SESSIONS_VAULT'], '/vault')

    def test_opencode_reads_only_editor_so_it_gets_both(self):
        self.assertEqual(launch.editor_env('opencode', '/s'), {'VISUAL': '/s', 'EDITOR': '/s'})
        self.assertEqual(launch.editor_env('codex', '/s'), {'VISUAL': '/s'})
        self.assertEqual(launch.editor_env('claude', None), {})

    def test_the_binarys_directory_leads_path(self):
        env = launch.build_env('codex', {'PATH': '/usr/bin'}, {}, '/opt/node/bin/codex', None, None)
        self.assertEqual(env['PATH'], '/opt/node/bin:/usr/bin')
        env = launch.build_env('codex', {}, {}, '/opt/node/bin/codex', None, None)
        self.assertEqual(env['PATH'], '/opt/node/bin')


class TestFindBinary(unittest.TestCase):
    def test_the_configured_path_is_used_as_is(self):
        self.assertEqual(launch.find_binary('claude', '/x/claude', '/nonexistent'), '/x/claude')

    def test_otherwise_it_is_looked_up_on_the_given_path(self):
        with tempfile.TemporaryDirectory() as d:
            exe = os.path.join(d, 'codex')
            with open(exe, 'w') as f:
                f.write('#!/bin/sh\n')
            os.chmod(exe, 0o755)
            self.assertEqual(launch.find_binary('codex', '', d), exe)

    def test_a_missing_binary_is_reported_in_words(self):
        with self.assertRaises(launch.LaunchError) as cm:
            launch.find_binary('opencode', '', '/nonexistent')
        self.assertIn('opencode was not found', str(cm.exception))


class TestReadLaunchConfig(unittest.TestCase):
    def _read(self, data):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'ui.json')
            if data is not None:
                with open(path, 'w') as f:
                    f.write(data if isinstance(data, str) else json.dumps(data))
            return launch.read_launch_config(path)

    def test_reads_what_the_plugin_writes(self):
        cfg = self._read({'agentLaunch': {
            'claude': {'path': '/c', 'env': {'A': 'b'}},
            'opencode': {'path': '', 'env': {}, 'launchVia': 'ollama', 'ollamaModel': ' m '}}})
        self.assertEqual(cfg['claude'], {'path': '/c', 'env': {'A': 'b'}, 'launchVia': 'opencode', 'ollamaModel': ''})
        self.assertEqual(cfg['opencode']['launchVia'], 'ollama')
        self.assertEqual(cfg['opencode']['ollamaModel'], 'm')
        self.assertNotIn('codex', cfg)

    def test_missing_or_malformed_files_give_nothing(self):
        self.assertEqual(self._read(None), {})
        self.assertEqual(self._read('not json'), {})
        self.assertEqual(self._read([]), {})
        self.assertEqual(self._read({'agentLaunch': 'x'}), {})
        self.assertEqual(self._read({'agentLaunch': {'claude': 'x'}}), {})


if __name__ == '__main__':
    unittest.main()

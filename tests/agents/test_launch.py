import json
import os
import tempfile
import unittest

from agentsessions.agents import launch


class TestBuildArgv(unittest.TestCase):
    def test_claude_gets_its_id_name_and_remote_control_as_flags(self):
        self.assertEqual(launch.build_argv('claude', '/c', 'ID'), ['/c', '--session-id', 'ID'])
        self.assertEqual(launch.build_argv('claude', '/c', 'ID', name='N', remote_control=True),
                         ['/c', '--session-id', 'ID', '--name=N', '--remote-control=N'])
        self.assertEqual(launch.build_argv('claude', '/c', 'ID', remote_control=True),
                         ['/c', '--session-id', 'ID', '--remote-control'])

    def test_a_name_starting_with_a_dash_stays_the_value_of_name(self):
        self.assertEqual(launch.build_argv('claude', '/c', 'ID', name='-x: y'),
                         ['/c', '--session-id', 'ID', '--name=-x: y'])

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


class TestWindows(unittest.TestCase):
    CALLER = {'Path': 'C:\\Windows', 'SystemRoot': 'C:\\Windows', 'USERPROFILE': 'C:\\Users\\a',
              'LOCALAPPDATA': 'C:\\Users\\a\\AppData\\Local', 'APPDATA': 'C:\\Users\\a\\AppData\\Roaming',
              'PATHEXT': '.EXE;.CMD', 'ComSpec': 'C:\\Windows\\system32\\cmd.exe', 'TEMP': 'C:\\Users\\Jane Doe\\Temp',
              'PROCESSOR_ARCHITECTURE': 'ARM64', 'CLAUDECODE': '1', 'AGENT_SESSIONS_ID': 'x', 'CODEX_THREAD_ID': 't'}

    def test_the_system_variables_are_passed_on_but_no_session_marker(self):
        env = launch.build_env('codex', self.CALLER, {}, 'C:\\codex\\codex.exe', None, None, platform='win32')
        for key in ('SystemRoot', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT', 'ComSpec', 'TEMP',
                    'PROCESSOR_ARCHITECTURE'):
            self.assertEqual(env[key], self.CALLER[key], key)
        for key in ('CLAUDECODE', 'AGENT_SESSIONS_ID', 'CODEX_THREAD_ID'):
            self.assertNotIn(key, env)
        # `Path` keeps its spelling, with the binary's folder first.
        self.assertNotIn('PATH', env)
        self.assertTrue(env['Path'].startswith('C:\\codex'))

    def test_opencode_gets_temp_without_spaces(self):
        short = lambda folder: folder.replace('Jane Doe', 'JANEDO~1')
        env = launch.build_env('opencode', self.CALLER, {}, 'C:\\o\\opencode.exe', None, None,
                               platform='win32', short_folder=short)
        self.assertEqual(env['TEMP'], 'C:\\Users\\JANEDO~1\\Temp')
        env = launch.build_env('codex', self.CALLER, {}, 'C:\\c\\codex.exe', None, None,
                               platform='win32', short_folder=short)
        self.assertEqual(env['TEMP'], 'C:\\Users\\Jane Doe\\Temp')

    def test_codex_runs_without_the_shared_background_server(self):
        self.assertEqual(launch.build_argv('codex', 'C:\\c.exe', 'ID', codex_no_daemon=True), ['C:\\c.exe', '--no-daemon'])
        self.assertEqual(launch.build_argv('codex', 'C:\\c.exe', 'ID', prompt='hi', codex_no_daemon=True),
                         ['C:\\c.exe', '--no-daemon', '--', 'hi'])
        self.assertEqual(launch.build_argv('codex', '/x', 'ID'), ['/x'])

    def test_no_daemon_only_on_windows_and_only_when_codex_has_it(self):
        self.assertTrue(launch.help_lists_no_daemon('Options:\n      --no-daemon\n          Run without'))
        self.assertFalse(launch.help_lists_no_daemon('Options:\n      --no-alt-screen'))
        self.assertFalse(launch.codex_no_daemon('/no/such/codex', platform='darwin'))
        self.assertFalse(launch.codex_no_daemon('/no/such/codex', platform='win32'))
        with tempfile.TemporaryDirectory() as tmp:
            fake = os.path.join(tmp, 'codex')
            with open(fake, 'w') as f:
                f.write('#!/bin/sh\necho "      --no-daemon"\n')
            os.chmod(fake, 0o755)
            if os.name != 'nt':
                self.assertTrue(launch.codex_no_daemon(fake, platform='win32'))


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

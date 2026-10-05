import io
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from agentsessions.agents.opencode import plugin_js
from agentsessions.agents.opencode import setup as ocsetup
from agentsessions.cli import setup as cmd_setup


class TestOpencodeSetup(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name
        self.path = os.path.join(self.tmp, 'opencode', 'plugins', 'agent-sessions.js')

    def test_install_creates_the_file_with_the_marker_first(self):
        changes = ocsetup.install(self.path)
        self.assertEqual(len(changes), 2)   # the status plugin and the status line
        with open(self.path, encoding='utf-8') as f:
            text = f.read()
        self.assertEqual(text, plugin_js.PLUGIN_JS)
        self.assertTrue(text.startswith(plugin_js.MARKER))
        self.assertEqual(os.listdir(os.path.dirname(self.path)), ['agent-sessions.js'])

    def test_install_writes_the_status_line_beside_the_plugins_folder(self):
        ocsetup.install(self.path)
        line = os.path.join(self.tmp, 'opencode', 'agent-sessions-tui.jsx')
        self.assertEqual(ocsetup.tui_plugin_path(self.path), line)
        with open(line, encoding='utf-8') as f:
            self.assertEqual(f.read(), plugin_js.TUI_PLUGIN_JSX)
        # never inside plugins/, which OpenCode loads as server plugins
        self.assertEqual(os.listdir(os.path.dirname(self.path)), ['agent-sessions.js'])

    def test_the_status_line_source_is_a_tui_module(self):
        src = plugin_js.TUI_PLUGIN_JSX
        self.assertTrue(src.startswith(plugin_js.MARKER))
        self.assertIn('@jsxImportSource @opentui/solid', src)
        self.assertIn('app_bottom', src)
        self.assertIn('export default { id: "agent-sessions", tui }', src)
        self.assertNotIn('server', src.replace('server plugin', ''))

    def test_status_line_is_refreshed_and_removed_with_the_plugin(self):
        line = ocsetup.tui_plugin_path(self.path)
        ocsetup.install(self.path)
        with open(line, 'w', encoding='utf-8') as f:
            f.write(plugin_js.MARKER + ' (older version)\n')
        status, changes = ocsetup.apply(self.path)
        self.assertEqual((status, len(changes)), (ocsetup.UPDATED, 1))
        self.assertEqual(ocsetup.apply(self.path)[0], ocsetup.UNCHANGED)
        self.assertEqual(len(ocsetup.remove(self.path)), 2)
        self.assertFalse(os.path.exists(line))
        self.assertFalse(os.path.exists(self.path))

    def test_update_only_brings_the_status_line_to_an_older_install(self):
        line = ocsetup.tui_plugin_path(self.path)
        ocsetup.install(self.path)
        os.unlink(line)
        status, _ = ocsetup.apply(self.path, update_only=True)
        self.assertEqual(status, ocsetup.UPDATED)
        self.assertTrue(os.path.exists(line))

    def test_update_only_without_the_plugin_creates_neither_file(self):
        self.assertEqual(ocsetup.apply(self.path, update_only=True), (ocsetup.ABSENT, []))
        self.assertFalse(os.path.exists(ocsetup.tui_plugin_path(self.path)))

    def test_a_foreign_status_line_file_is_left_alone(self):
        line = ocsetup.tui_plugin_path(self.path)
        os.makedirs(os.path.dirname(line))
        with open(line, 'w') as f:
            f.write('mine\n')
        status, changes = ocsetup.apply(self.path)
        self.assertEqual(status, ocsetup.INSTALLED)
        self.assertIn(line, changes[-1])
        self.assertEqual(ocsetup.remove(self.path)[0].count(line), 0)
        with open(line) as f:
            self.assertEqual(f.read(), 'mine\n')

    def test_install_is_idempotent_and_updates_our_own_older_file(self):
        ocsetup.install(self.path)
        self.assertEqual(ocsetup.install(self.path), [])
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write(plugin_js.MARKER + ' (older version)\n')
        self.assertEqual(len(ocsetup.install(self.path)), 1)
        with open(self.path, encoding='utf-8') as f:
            self.assertEqual(f.read(), plugin_js.PLUGIN_JS)

    def test_a_file_that_is_not_ours_is_never_overwritten_or_removed(self):
        os.makedirs(os.path.dirname(self.path))
        with open(self.path, 'w') as f:
            f.write('export const Mine = async () => ({})\n')
        changes = ocsetup.install(self.path)
        self.assertIn(self.path, changes[0])
        self.assertEqual(ocsetup.remove(self.path), [])
        with open(self.path) as f:
            self.assertEqual(f.read(), 'export const Mine = async () => ({})\n')

    def test_remove_deletes_ours_and_ignores_a_missing_file(self):
        self.assertEqual(ocsetup.remove(self.path), [])
        ocsetup.install(self.path)
        self.assertEqual(len(ocsetup.remove(self.path)), 2)
        self.assertFalse(os.path.exists(self.path))
        self.assertFalse(os.path.exists(ocsetup.tui_plugin_path(self.path)))

    def test_dry_run_writes_and_deletes_nothing(self):
        self.assertEqual(len(ocsetup.install(self.path, dry_run=True)), 2)
        self.assertFalse(os.path.exists(self.path))
        ocsetup.install(self.path)
        self.assertEqual(len(ocsetup.remove(self.path, dry_run=True)), 2)
        self.assertTrue(os.path.exists(self.path))

    def test_default_path_honours_xdg_config_home(self):
        with mock.patch.dict(os.environ, {'XDG_CONFIG_HOME': self.tmp}):
            self.assertEqual(ocsetup.default_plugin_path(),
                             os.path.join(self.tmp, 'opencode', 'plugins', 'agent-sessions.js'))
        env = {k: v for k, v in os.environ.items() if k != 'XDG_CONFIG_HOME'}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(ocsetup.default_plugin_path(),
                             os.path.expanduser('~/.config/opencode/plugins/agent-sessions.js'))


class TestSetupCommand(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name
        self.settings = os.path.join(self.tmp, 'settings.json')
        p = mock.patch.dict(os.environ, {'XDG_CONFIG_HOME': os.path.join(self.tmp, 'xdg')})
        p.start()
        self.addCleanup(p.stop)
        self.plugin = os.path.join(self.tmp, 'xdg', 'opencode', 'plugins', 'agent-sessions.js')
        self.backup = os.path.join(self.tmp, 'opencode-tui-backup.json')

    def _run(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = cmd_setup.main(list(args) + ['--settings', self.settings,
                                                 '--keybindings', os.path.join(self.tmp, 'kb.json'),
                                                 '--config-toml', os.path.join(self.tmp, 'config.toml'),
                                                 '--opencode-tui-backup', self.backup,
                                                 '--vault', os.path.join(self.tmp, 'vault')])
        return rc, out.getvalue()

    def test_opencode_flag_installs_only_the_plugin(self):
        rc, out = self._run('--opencode')
        self.assertEqual(rc, 0)
        self.assertTrue(os.path.exists(self.plugin))
        self.assertFalse(os.path.exists(self.settings))     # Claude Code's settings untouched
        self.assertIn(self.plugin, out)
        rc, out = self._run('--opencode')
        self.assertEqual(rc, 0)

    def test_remove_also_removes_the_plugin(self):
        self._run('--opencode')
        rc, out = self._run('--remove')
        self.assertEqual(rc, 0)
        self.assertFalse(os.path.exists(self.plugin))

    def test_plain_setup_does_not_install_the_plugin(self):
        rc, _ = self._run()
        self.assertEqual(rc, 0)
        self.assertFalse(os.path.exists(self.plugin))

    def test_the_status_line_tells_what_happened(self):
        self.assertEqual(self._run('--opencode')[1].splitlines()[-1], 'opencode-plugin: installed')
        self.assertEqual(self._run('--opencode')[1].splitlines()[-1], 'opencode-plugin: unchanged')
        with open(self.plugin, 'w', encoding='utf-8') as f:
            f.write(plugin_js.MARKER + ' (older version)\n')
        self.assertEqual(self._run('--opencode')[1].splitlines()[-1], 'opencode-plugin: updated')
        with open(self.plugin, 'w', encoding='utf-8') as f:
            f.write('export const Mine = async () => ({})\n')
        rc, out = self._run('--opencode')
        self.assertEqual((rc, out.splitlines()[-1]), (0, 'opencode-plugin: foreign'))

    def test_update_only_never_creates_the_file(self):
        rc, out = self._run('--opencode', '--update-only')
        self.assertEqual((rc, out.splitlines()[-1]), (0, 'opencode-plugin: absent'))
        self.assertFalse(os.path.exists(self.plugin))
        self._run('--opencode')
        with open(self.plugin, 'w', encoding='utf-8') as f:
            f.write(plugin_js.MARKER + ' (older version)\n')
        rc, out = self._run('--opencode', '--update-only')
        self.assertEqual(out.splitlines()[-1], 'opencode-plugin: updated')
        with open(self.plugin, encoding='utf-8') as f:
            self.assertEqual(f.read(), plugin_js.PLUGIN_JS)

    def test_an_unwritable_folder_is_reported_not_raised(self):
        err = io.StringIO()
        with mock.patch('os.makedirs', side_effect=PermissionError('denied')), redirect_stderr(err):
            rc, out = self._run('--opencode')
        self.assertEqual(rc, 1)
        self.assertIn('denied', err.getvalue())
        self.assertEqual(out.splitlines()[-1], 'opencode-plugin: failed')

    def test_remove_opencode_removes_only_the_plugin(self):
        self._run('--opencode')
        with open(self.settings, 'w') as f:
            f.write('{"hooks": {}}')
        with open(self.settings) as f:
            before = f.read()
        rc, out = self._run('--remove-opencode')
        self.assertEqual(rc, 0)
        self.assertFalse(os.path.exists(self.plugin))
        self.assertEqual(out.splitlines()[-1], 'opencode-plugin: removed')
        with open(self.settings) as f:
            self.assertEqual(f.read(), before)
        self.assertEqual(self._run('--remove-opencode')[1].splitlines()[-1], 'opencode-plugin: absent')

    def test_remove_opencode_leaves_a_foreign_file(self):
        os.makedirs(os.path.dirname(self.plugin))
        with open(self.plugin, 'w') as f:
            f.write('export const Mine = async () => ({})\n')
        self._run('--remove-opencode')
        self.assertTrue(os.path.exists(self.plugin))

    def test_explicit_plugin_path(self):
        target = os.path.join(self.tmp, 'elsewhere.js')
        rc, _ = self._run('--opencode', '--opencode-plugin', target)
        self.assertEqual(rc, 0)
        self.assertTrue(os.path.exists(target))


NODE = shutil.which('node')


@unittest.skipUnless(NODE, 'node is not installed')
class TestPluginBehaviour(unittest.TestCase):
    """Runs the real plugin source under node with a scratch HOME, feeding it
    the events OpenCode delivers."""

    DRIVER = r'''
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.argv[2]).href);
const hooks = await mod.AgentSessionsStatus({ directory: "/work/proj" });
for (const e of JSON.parse(process.argv[3])) { await hooks.event({ event: e }); }
if (process.argv[4] === "dump") {
  // still inside the process: the plugin removes its files on exit
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.join(process.env.HOME, ".agents", "sessions", "opencode");
  const out = {};
  for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    out[n] = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
  }
  console.log(JSON.stringify(out));
}
'''

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name
        self.plugin = os.path.join(self.tmp, 'plugin.mjs')
        with open(self.plugin, 'w') as f:
            f.write(plugin_js.PLUGIN_JS)
        self.driver = os.path.join(self.tmp, 'driver.mjs')
        with open(self.driver, 'w') as f:
            f.write(self.DRIVER)

    def _node(self, events, mode='dump', node_args=()):
        env = dict(os.environ, HOME=self.tmp, USERPROFILE=self.tmp)
        r = subprocess.run([NODE, *node_args, self.driver, self.plugin, json.dumps(events), mode], env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr.decode())
        return r.stdout.decode()

    def _files_after(self, events):
        """`{filename: parsed json}` of the status files right after `events`."""
        return json.loads(self._node(events))

    def status(self, sid, status_type):
        return {'type': 'session.status', 'properties': {'sessionID': sid, 'status': {'type': status_type}}}

    def test_a_created_top_level_session_gets_an_idle_file_with_the_pid(self):
        ev = [{'type': 'session.created', 'properties': {'info': {'id': 'ses_a', 'directory': '/work/here'}}}]
        d = self._files_after(ev)['ses_a.json']
        self.assertEqual((d['status'], d['waiting_for'], d['cwd']), ('idle', '', '/work/here'))
        self.assertIsInstance(d['pid'], int)
        # a later busy is not undone by another created/updated for the same session
        ev += [self.status('ses_a', 'busy'), {'type': 'session.updated', 'properties': {'info': {'id': 'ses_a'}}}]
        self.assertEqual(self._files_after(ev)['ses_a.json']['status'], 'busy')

    def test_a_rename_windows_refuses_falls_back_to_writing_in_place(self):
        # As on Windows while a reader holds the file: every rename fails with EPERM.
        preload = os.path.join(self.tmp, 'windows.mjs')
        with open(preload, 'w') as f:
            f.write('import fs from "node:fs";\n'
                    'Object.defineProperty(process, "platform", { value: "win32" });\n'
                    'fs.renameSync = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };\n')
        out = self._node([self.status('ses_a', 'busy')], node_args=('--import', pathlib.Path(preload).as_uri()))
        self.assertEqual(json.loads(out), {'ses_a.json': mock.ANY})
        self.assertEqual(json.loads(out)['ses_a.json']['status'], 'busy')

    def test_created_sub_agent_sessions_get_no_file(self):
        ev = [{'type': 'session.created', 'properties': {'info': {'id': 'ses_kid', 'parentID': 'ses_a'}}}]
        self.assertEqual(self._files_after(ev), {})

    def test_busy_then_idle(self):
        files = self._files_after([self.status('ses_a', 'busy')])
        d = files['ses_a.json']
        self.assertEqual((d['status'], d['waiting_for'], d['cwd']), ('busy', '', '/work/proj'))
        self.assertIsInstance(d['pid'], int)
        self.assertIsInstance(d['updated_at'], float)
        files = self._files_after([self.status('ses_a', 'busy'), {'type': 'session.idle', 'properties': {'sessionID': 'ses_a'}}])
        self.assertEqual(files['ses_a.json']['status'], 'idle')

    def test_retry_counts_as_busy(self):
        self.assertEqual(self._files_after([self.status('ses_a', 'retry')])['ses_a.json']['status'], 'busy')

    def test_permission_waits_until_replied_and_busy_does_not_override(self):
        ev = [self.status('ses_a', 'busy'), {'type': 'permission.asked', 'properties': {'sessionID': 'ses_a'}},
              self.status('ses_a', 'busy')]
        d = self._files_after(ev)['ses_a.json']
        self.assertEqual((d['status'], d['waiting_for']), ('waiting', 'permission'))
        ev.append({'type': 'permission.replied', 'properties': {'sessionID': 'ses_a'}})
        self.assertEqual(self._files_after(ev)['ses_a.json']['status'], 'busy')

    def test_legacy_permission_event_and_question(self):
        d = self._files_after([{'type': 'permission.updated', 'properties': {'sessionID': 'ses_a'}}])['ses_a.json']
        self.assertEqual((d['status'], d['waiting_for']), ('waiting', 'permission'))
        ev = [{'type': 'question.asked', 'properties': {'sessionID': 'ses_a'}}]
        self.assertEqual(self._files_after(ev)['ses_a.json']['waiting_for'], 'question')
        ev.append({'type': 'question.rejected', 'properties': {'sessionID': 'ses_a'}})
        self.assertEqual(self._files_after(ev + [self.status('ses_a', 'busy')])['ses_a.json']['status'], 'busy')

    def test_deleted_session_removes_the_file(self):
        ev = [self.status('ses_a', 'busy'), {'type': 'session.deleted', 'properties': {'info': {'id': 'ses_a'}}}]
        self.assertEqual(self._files_after(ev), {})

    def test_sub_agent_sessions_are_ignored(self):
        ev = [{'type': 'session.created', 'properties': {'info': {'id': 'ses_kid', 'parentID': 'ses_a'}}},
              self.status('ses_kid', 'busy'), self.status('ses_a', 'busy')]
        self.assertEqual(list(self._files_after(ev)), ['ses_a.json'])

    def test_hostile_ids_and_junk_events_never_throw_or_escape(self):
        ev = [self.status('../../evil', 'busy'), {'type': 'session.status'}, None, {'properties': 3},
              self.status('ses_a', 'busy')]
        self.assertEqual(list(self._files_after(ev)), ['ses_a.json'])

    def test_files_are_removed_when_the_process_exits(self):
        self._node([self.status('ses_a', 'busy')], mode='quiet')
        status_dir = os.path.join(self.tmp, '.agents', 'sessions', 'opencode')
        self.assertEqual(os.listdir(status_dir), [])


if __name__ == '__main__':
    unittest.main()

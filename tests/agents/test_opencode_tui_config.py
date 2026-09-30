import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout

from agentsessions.agents.opencode import tui_config
from agentsessions.cli import setup as cmd_setup

MANAGED = {'input_submit': 'linefeed,ctrl+j', 'input_newline': 'return,shift+return,ctrl+return,alt+return'}


class TestTuiConfigRestore(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tui = os.path.join(self._tmp.name, 'opencode', 'tui.json')
        self.backup = os.path.join(self._tmp.name, 'backup.json')
        os.makedirs(os.path.dirname(self.tui))

    def _backup(self, **over):
        data = {'path': self.tui, 'input_submit': None, 'input_newline': None, 'managed': MANAGED,
                'created_keybinds': False, 'created_file': False}
        data.update(over)
        with open(self.backup, 'w') as f:
            json.dump(data, f)

    def _tui(self, obj, indent=2):
        with open(self.tui, 'w') as f:
            json.dump(obj, f, indent=indent)
            f.write('\n')

    def _read(self):
        with open(self.tui) as f:
            return json.load(f)

    def test_puts_previous_values_back_and_keeps_other_keys(self):
        self._tui({'theme': 'x', 'keybinds': {'leader': 'ctrl+x', **MANAGED}})
        self._backup(input_submit='return', input_newline='ctrl+j')
        changes = tui_config.restore(self.backup)
        self.assertEqual(len(changes), 1)
        self.assertEqual(self._read(), {'theme': 'x', 'keybinds': {'leader': 'ctrl+x', 'input_submit': 'return',
                                                                     'input_newline': 'ctrl+j'}})
        self.assertFalse(os.path.exists(self.backup))

    def test_deletes_keys_that_did_not_exist(self):
        self._tui({'theme': 'x', 'keybinds': {'leader': 'ctrl+x', **MANAGED}})
        self._backup()
        tui_config.restore(self.backup)
        self.assertEqual(self._read(), {'theme': 'x', 'keybinds': {'leader': 'ctrl+x'}})

    def test_removes_the_status_line_entry_and_keeps_the_users_plugins(self):
        self._tui({'plugin': ['acme', tui_config.PLUGIN_SPEC], 'keybinds': dict(MANAGED)})
        self._backup()
        tui_config.restore(self.backup)
        self.assertEqual(self._read(), {'plugin': ['acme'], 'keybinds': {}})

    def test_drops_the_plugin_array_when_the_entry_was_all_of_it(self):
        self._tui({'theme': 'x', 'plugin': [[tui_config.PLUGIN_SPEC, {}]], 'keybinds': dict(MANAGED)})
        self._backup(created_keybinds=True)
        tui_config.restore(self.backup)
        self.assertEqual(self._read(), {'theme': 'x'})

    def test_a_non_list_plugin_value_leaves_the_file_and_the_backup(self):
        self._tui({'plugin': 'x', 'keybinds': dict(MANAGED)})
        self._backup()
        changes = tui_config.restore(self.backup)
        self.assertEqual(len(changes), 1)
        self.assertEqual(self._read(), {'plugin': 'x', 'keybinds': dict(MANAGED)})
        self.assertTrue(os.path.exists(self.backup))

    def test_removes_what_it_created(self):
        self._tui({'keybinds': dict(MANAGED)})
        self._backup(created_keybinds=True, created_file=True)
        tui_config.restore(self.backup)
        self.assertFalse(os.path.exists(self.tui))

    def test_keeps_the_created_keybinds_object_only_when_it_is_not_empty(self):
        self._tui({'theme': 'x', 'keybinds': dict(MANAGED)})
        self._backup(created_keybinds=True)
        tui_config.restore(self.backup)
        self.assertEqual(self._read(), {'theme': 'x'})

    def test_leaves_a_value_the_user_changed_since(self):
        self._tui({'keybinds': {'input_submit': 'ctrl+s', 'input_newline': MANAGED['input_newline']}})
        self._backup()
        tui_config.restore(self.backup)
        self.assertEqual(self._read(), {'keybinds': {'input_submit': 'ctrl+s'}})

    def test_keeps_the_indent(self):
        self._tui({'keybinds': dict(MANAGED), 'a': 1}, indent=4)
        self._backup()
        tui_config.restore(self.backup)
        with open(self.tui) as f:
            self.assertIn('\n    "a": 1', f.read())

    def test_editor_open_only_backup_puts_the_previous_value_back(self):
        self._tui({'keybinds': {'leader': 'ctrl+x', 'editor_open': 'ctrl+g'}})
        self._backup(input_submit=None, input_newline=None, editor_open='<leader>o',
                     managed={'editor_open': 'ctrl+g'})
        changes = tui_config.restore(self.backup)
        self.assertEqual(len(changes), 1)
        self.assertEqual(self._read(), {'keybinds': {'leader': 'ctrl+x', 'editor_open': '<leader>o'}})
        self.assertFalse(os.path.exists(self.backup))

    def test_editor_open_with_no_previous_value_is_deleted_and_a_created_file_removed(self):
        self._tui({'keybinds': {'editor_open': 'alt+g'}})
        self._backup(editor_open=None, managed={'editor_open': 'alt+g'}, created_keybinds=True, created_file=True)
        tui_config.restore(self.backup)
        self.assertFalse(os.path.exists(self.tui))

    def test_all_three_keys_are_restored_together(self):
        self._tui({'keybinds': {**MANAGED, 'editor_open': 'ctrl+q'}})
        self._backup(input_submit='return', editor_open='<leader>o', managed={**MANAGED, 'editor_open': 'ctrl+q'})
        tui_config.restore(self.backup)
        self.assertEqual(self._read(), {'keybinds': {'input_submit': 'return', 'editor_open': '<leader>o'}})

    def test_an_editor_key_the_user_changed_since_stays(self):
        self._tui({'keybinds': {'editor_open': 'ctrl+e'}})
        self._backup(editor_open=None, managed={'editor_open': 'ctrl+g'})
        tui_config.restore(self.backup)
        self.assertEqual(self._read(), {'keybinds': {'editor_open': 'ctrl+e'}})

    def test_a_key_outside_managed_is_never_touched(self):
        self._tui({'keybinds': {'editor_open': 'ctrl+g', 'input_submit': 'ctrl+s'}})
        self._backup(editor_open=None, managed={'editor_open': 'ctrl+g'})
        tui_config.restore(self.backup)
        self.assertEqual(self._read(), {'keybinds': {'input_submit': 'ctrl+s'}})

    def test_jsonc_is_left_alone_and_the_backup_kept(self):
        text = '{\n  // mine\n  "keybinds": {"input_submit": "linefeed,ctrl+j"}\n}\n'
        with open(self.tui, 'w') as f:
            f.write(text)
        self._backup()
        changes = tui_config.restore(self.backup)
        self.assertEqual(len(changes), 1)
        with open(self.tui) as f:
            self.assertEqual(f.read(), text)
        self.assertTrue(os.path.exists(self.backup))

    def test_no_backup_is_a_no_op(self):
        self.assertEqual(tui_config.restore(self.backup), [])

    def test_dry_run_changes_nothing(self):
        self._tui({'keybinds': dict(MANAGED)})
        self._backup()
        self.assertEqual(len(tui_config.restore(self.backup, dry_run=True)), 1)
        self.assertEqual(self._read(), {'keybinds': MANAGED})
        self.assertTrue(os.path.exists(self.backup))


class TestSetupRemovesEditorKeys(unittest.TestCase):
    """`setup --remove` gives back all three agents' editor-key settings."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        d = self._tmp.name
        self.tui = os.path.join(d, 'tui.json')
        self.backup = os.path.join(d, 'backup.json')
        self.kb = os.path.join(d, 'kb.json')
        self.toml = os.path.join(d, 'c.toml')
        with open(self.tui, 'w') as f:
            json.dump({'keybinds': {'editor_open': 'ctrl+q'}}, f)
        with open(self.backup, 'w') as f:
            json.dump({'path': self.tui, 'editor_open': '<leader>o', 'managed': {'editor_open': 'ctrl+q'},
                       'created_keybinds': False, 'created_file': False}, f)
        with open(self.kb, 'w') as f:
            json.dump({'bindings': [{'context': 'Chat', 'bindings': {'ctrl+q': 'chat:externalEditor', 'ctrl+g': None}}]}, f)
        with open(self.toml, 'w') as f:
            f.write('[tui.keymap.global] # managed by Agent Sessions\n'
                    'open_external_editor = "ctrl-q" # managed by Agent Sessions\n')
        self.args = ['--settings', os.path.join(d, 's.json'), '--keybindings', self.kb, '--config-toml', self.toml,
                     '--opencode-plugin', os.path.join(d, 'plugin.js'), '--opencode-tui-backup', self.backup,
                     '--vault', os.path.join(d, 'vault')]

    def test_remove_restores_claude_codex_and_opencode(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cmd_setup.main(['--remove'] + self.args), 0)
        with open(self.kb) as f:
            self.assertEqual(json.load(f)['bindings'], [])
        with open(self.toml) as f:
            self.assertEqual(f.read(), '')
        with open(self.tui) as f:
            self.assertEqual(json.load(f), {'keybinds': {'editor_open': '<leader>o'}})
        self.assertFalse(os.path.exists(self.backup))

    def test_remove_opencode_touches_only_opencode(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cmd_setup.main(['--remove-opencode'] + self.args), 0)
        with open(self.tui) as f:
            self.assertEqual(json.load(f), {'keybinds': {'editor_open': '<leader>o'}})
        with open(self.kb) as f:
            self.assertEqual(len(json.load(f)['bindings']), 1)
        with open(self.toml) as f:
            self.assertIn('open_external_editor', f.read())


class TestSetupRemovesTui(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        d = self._tmp.name
        self.tui = os.path.join(d, 'tui.json')
        self.backup = os.path.join(d, 'backup.json')
        with open(self.tui, 'w') as f:
            json.dump({'keybinds': dict(MANAGED)}, f)
        with open(self.backup, 'w') as f:
            json.dump({'path': self.tui, 'input_submit': 'return', 'input_newline': None, 'managed': MANAGED,
                       'created_keybinds': False, 'created_file': False}, f)
        self.args = ['--settings', os.path.join(d, 's.json'), '--keybindings', os.path.join(d, 'kb.json'),
                     '--config-toml', os.path.join(d, 'c.toml'),
                     '--opencode-plugin', os.path.join(d, 'plugin.js'),
                     '--opencode-tui-backup', self.backup, '--vault', os.path.join(d, 'vault')]

    def _check(self):
        with open(self.tui) as f:
            self.assertEqual(json.load(f), {'keybinds': {'input_submit': 'return'}})
        self.assertFalse(os.path.exists(self.backup))

    def test_remove(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cmd_setup.main(['--remove'] + self.args), 0)
        self._check()

    def test_remove_opencode(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(cmd_setup.main(['--remove-opencode'] + self.args), 0)
        self._check()
        self.assertEqual(out.getvalue().splitlines()[-1], 'opencode-plugin: absent')


if __name__ == '__main__':
    unittest.main()

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
                     '--opencode-tui-backup', self.backup]

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

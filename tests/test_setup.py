import glob
import json
import os
import shutil
import tempfile
import unittest

from agentsessions import setup


class SetupTestBase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.path = os.path.join(self.tmpdir, 'settings.json')

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write(self, data):
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)

    def _read(self):
        with open(self.path, encoding='utf-8') as f:
            return json.load(f)

    def _backups(self):
        return glob.glob(self.path + '.bak-*')


class TestReplaceOldHook(SetupTestBase):
    def test_replaces_old_cs_command_and_leaves_others_alone(self):
        self._write({
            'statusLine': {'type': 'command', 'command': '"$HOME/bin/agent-sessions" status'},
            'hooks': {
                'Stop': [
                    {'matcher': '.*', 'hooks': [{'type': 'command', 'command': '"$HOME/bin/cs" hook'}]},
                ],
                'SessionEnd': [
                    {'matcher': '.*', 'hooks': [{'type': 'command', 'command': "$HOME/bin/cs hook"}]},
                ],
                'PreToolUse': [
                    {'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': 'curl https://claudebar.example/x'}]},
                ],
            },
        })
        changes, new_settings = setup.run(self.path)
        self.assertEqual(len(changes), 2)
        self.assertEqual(
            new_settings['hooks']['Stop'][0]['hooks'][0]['command'],
            '"$HOME/bin/agent-sessions" hook',
        )
        self.assertEqual(
            new_settings['hooks']['SessionEnd'][0]['hooks'][0]['command'],
            '"$HOME/bin/agent-sessions" hook',
        )
        self.assertEqual(
            new_settings['hooks']['PreToolUse'][0]['hooks'][0]['command'],
            'curl https://claudebar.example/x',
        )
        self.assertEqual(self._read(), new_settings)
        self.assertEqual(len(self._backups()), 1)

    def test_backup_contains_original_content(self):
        original = {
            'hooks': {'Stop': [{'matcher': '.*', 'hooks': [{'type': 'command', 'command': '"$HOME/bin/cs" hook'}]}]},
        }
        self._write(original)
        setup.run(self.path)
        [backup] = self._backups()
        with open(backup, encoding='utf-8') as f:
            self.assertEqual(json.load(f), original)


class TestAddWhenMissing(SetupTestBase):
    def test_adds_hook_entries_when_absent(self):
        self._write({})
        changes, new_settings = setup.run(self.path)
        self.assertEqual(
            new_settings['hooks']['Stop'],
            [{'matcher': '.*', 'hooks': [{'type': 'command', 'command': '"$HOME/bin/agent-sessions" hook'}]}],
        )
        self.assertEqual(
            new_settings['hooks']['SessionEnd'],
            [{'matcher': '.*', 'hooks': [{'type': 'command', 'command': '"$HOME/bin/agent-sessions" hook'}]}],
        )
        self.assertTrue(any('追加' in c for c in changes))

    def test_missing_settings_file_is_treated_as_empty_and_creates_no_backup(self):
        changes, new_settings = setup.run(self.path)
        self.assertTrue(os.path.exists(self.path))
        self.assertEqual(self._backups(), [])
        self.assertEqual(self._read(), new_settings)
        self.assertTrue(changes)


class TestStatusLine(SetupTestBase):
    def test_missing_status_line_is_set(self):
        self._write({})
        _, new_settings = setup.run(self.path)
        self.assertEqual(
            new_settings['statusLine'],
            {'type': 'command', 'command': '"$HOME/bin/agent-sessions" status'},
        )

    def test_null_status_line_is_set(self):
        self._write({'statusLine': None})
        _, new_settings = setup.run(self.path)
        self.assertEqual(new_settings['statusLine']['command'], '"$HOME/bin/agent-sessions" status')

    def test_old_cs_status_line_is_replaced(self):
        self._write({'statusLine': {'type': 'command', 'command': '"$HOME/bin/cs" status'}})
        _, new_settings = setup.run(self.path)
        self.assertEqual(new_settings['statusLine']['command'], '"$HOME/bin/agent-sessions" status')

    def test_already_current_status_line_is_untouched(self):
        current = {'type': 'command', 'command': '"$HOME/bin/agent-sessions" status'}
        self._write({'statusLine': current})
        changes, new_settings = setup.run(self.path)
        self.assertEqual(new_settings['statusLine'], current)
        self.assertFalse(any(c.startswith('statusLine') for c in changes))


class TestDryRun(SetupTestBase):
    def test_dry_run_reports_changes_without_writing(self):
        original = {'hooks': {'Stop': [{'matcher': '.*', 'hooks': [{'type': 'command', 'command': '"$HOME/bin/cs" hook'}]}]}}
        self._write(original)
        changes, new_settings = setup.run(self.path, dry_run=True)
        self.assertTrue(changes)
        self.assertNotEqual(new_settings, original)
        self.assertEqual(self._read(), original)
        self.assertEqual(self._backups(), [])


class TestIdempotent(SetupTestBase):
    def test_second_run_reports_no_changes(self):
        self._write({'hooks': {'Stop': [{'matcher': '.*', 'hooks': [{'type': 'command', 'command': '"$HOME/bin/cs" hook'}]}]}})
        setup.run(self.path)
        changes, _ = setup.run(self.path)
        self.assertEqual(changes, [])
        self.assertEqual(len(self._backups()), 1)  # 2 回目は書き込まないので backup も増えない


if __name__ == '__main__':
    unittest.main()

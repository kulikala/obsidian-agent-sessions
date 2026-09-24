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
        # Stop・SessionEnd の移行（2）＋ SessionStart・UserPromptSubmit の新規追加（2、T-77 追補）。
        self.assertEqual(len(changes), 4)
        self.assertEqual(
            new_settings['hooks']['Stop'][0]['hooks'][0]['command'],
            '"$HOME/bin/agent-sessions" hook',
        )
        self.assertEqual(
            new_settings['hooks']['SessionEnd'][0]['hooks'][0]['command'],
            '"$HOME/bin/agent-sessions" hook',
        )
        self.assertEqual(
            new_settings['hooks']['SessionStart'],
            [{'matcher': 'compact', 'hooks': [{'type': 'command', 'command': '"$HOME/bin/agent-sessions" hook'}]}],
        )
        self.assertEqual(
            new_settings['hooks']['UserPromptSubmit'],
            [{'matcher': '.*', 'hooks': [{'type': 'command', 'command': '"$HOME/bin/agent-sessions" hook'}]}],
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
        self.assertEqual(
            new_settings['hooks']['SessionStart'],
            [{'matcher': 'compact', 'hooks': [{'type': 'command', 'command': '"$HOME/bin/agent-sessions" hook'}]}],
        )
        self.assertEqual(
            new_settings['hooks']['UserPromptSubmit'],
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


class TestCompactedHooks(SetupTestBase):
    """T-77 追補：compacted の印に要る SessionStart（matcher=compact）・UserPromptSubmit。"""

    def test_session_start_gets_compact_matcher_not_catch_all(self):
        self._write({})
        _, new_settings = setup.run(self.path)
        self.assertEqual(new_settings['hooks']['SessionStart'][0]['matcher'], 'compact')

    def test_second_run_with_compact_matcher_already_present_reports_no_changes(self):
        self._write({})
        setup.run(self.path)
        changes, _ = setup.run(self.path)
        self.assertEqual(changes, [])

    def test_session_start_with_different_matcher_gets_a_second_entry(self):
        # 既存の SessionStart が別のマッチャー（例えば別ツールが足した startup 用）を
        # 持っていても、compact 用のエントリを別に足す（既存を壊さない）。
        self._write({
            'hooks': {
                'SessionStart': [
                    {'matcher': 'startup', 'hooks': [{'type': 'command', 'command': 'echo hi'}]},
                ],
            },
        })
        changes, new_settings = setup.run(self.path)
        self.assertTrue(any('SessionStart' in c for c in changes))
        matchers = [e['matcher'] for e in new_settings['hooks']['SessionStart']]
        self.assertEqual(sorted(matchers), ['compact', 'startup'])

    def test_user_prompt_submit_gets_catch_all_matcher(self):
        self._write({})
        _, new_settings = setup.run(self.path)
        self.assertEqual(new_settings['hooks']['UserPromptSubmit'][0]['matcher'], '.*')


class TestRunRemove(SetupTestBase):
    """T-83：`run()` の逆。自分が入れた hooks・statusLine だけ消す。"""

    def test_removes_everything_run_added(self):
        setup.run(self.path)
        changes, new_settings = setup.run_remove(self.path)
        self.assertTrue(changes)
        self.assertNotIn('hooks', new_settings)
        self.assertNotIn('statusLine', new_settings)
        self.assertEqual(self._read(), new_settings)
        self.assertEqual(len(self._backups()), 1)  # install は既存ファイルが無いので backup 無し、remove で 1

    def test_leaves_other_hooks_and_status_line_alone(self):
        self._write({
            'statusLine': {'type': 'command', 'command': 'other-tool status'},
            'hooks': {
                'Stop': [
                    {'matcher': '.*', 'hooks': [
                        {'type': 'command', 'command': '"$HOME/bin/agent-sessions" hook'},
                        {'type': 'command', 'command': 'other-tool hook'},
                    ]},
                ],
                'PreToolUse': [
                    {'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': 'curl https://x'}]},
                ],
            },
        })
        changes, new_settings = setup.run_remove(self.path)
        self.assertTrue(any('Stop' in c for c in changes))
        self.assertEqual(
            new_settings['hooks']['Stop'],
            [{'matcher': '.*', 'hooks': [{'type': 'command', 'command': 'other-tool hook'}]}],
        )
        self.assertEqual(
            new_settings['hooks']['PreToolUse'][0]['hooks'][0]['command'],
            'curl https://x',
        )
        self.assertEqual(new_settings['statusLine']['command'], 'other-tool status')

    def test_drops_hooks_key_entirely_when_nothing_left(self):
        self._write({
            'hooks': {'Stop': [{'matcher': '.*', 'hooks': [
                {'type': 'command', 'command': '"$HOME/bin/agent-sessions" hook'},
            ]}]},
        })
        _, new_settings = setup.run_remove(self.path)
        self.assertNotIn('hooks', new_settings)

    def test_no_op_when_nothing_to_remove(self):
        self._write({'hooks': {'PreToolUse': [
            {'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': 'curl https://x'}]},
        ]}})
        changes, new_settings = setup.run_remove(self.path)
        self.assertEqual(changes, [])
        self.assertEqual(self._backups(), [])  # 何も変えないので backup も作らない

    def test_missing_settings_file_is_a_no_op(self):
        changes, new_settings = setup.run_remove(self.path)
        self.assertEqual(changes, [])
        self.assertEqual(new_settings, {})
        self.assertFalse(os.path.exists(self.path))

    def test_idempotent_second_remove_reports_no_changes(self):
        setup.run(self.path)
        setup.run_remove(self.path)
        changes, _ = setup.run_remove(self.path)
        self.assertEqual(changes, [])

    def test_dry_run_reports_without_writing(self):
        setup.run(self.path)
        before = self._read()
        changes, new_settings = setup.run_remove(self.path, dry_run=True)
        self.assertTrue(changes)
        self.assertNotEqual(new_settings, before)
        self.assertEqual(self._read(), before)
        self.assertEqual(self._backups(), [])  # install も dry-run の remove も書いていない


if __name__ == '__main__':
    unittest.main()

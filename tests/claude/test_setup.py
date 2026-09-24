import glob
import json
import os
import shutil
import tempfile
import unittest

from agentsessions import i18n, setup


class SetupTestBase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.path = os.path.join(self.tmpdir, 'settings.json')

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write(self, data):
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)

    def _write_text(self, text):
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write(text)

    def _read(self):
        with open(self.path, encoding='utf-8') as f:
            return json.load(f)

    def _read_text(self):
        with open(self.path, encoding='utf-8') as f:
            return f.read()

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
        # 4 changes total: migrating Stop and SessionEnd (2) plus adding the new
        # SessionStart and UserPromptSubmit hooks (2).
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
        expected = i18n.t('setup.hook_added', event='Stop', matcher='.*',
                          command='"$HOME/bin/agent-sessions" hook')
        self.assertIn(expected, changes)

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

    def test_other_tools_status_line_containing_cs_substring_is_left_alone(self):
        # Regression: a naive `'cs' in command` check would wrongly treat any of these
        # as our old `cs` tool and overwrite them (ccstatusline, a "docs"-mentioning
        # command, etc). Only the literal old `bin/cs status` invocation should match.
        for command in ('npx ccstatusline@latest', 'node ./scripts/docs-status.js'):
            with self.subTest(command=command):
                self.tmp2 = tempfile.mkdtemp()
                path = os.path.join(self.tmp2, 'settings.json')
                current = {'type': 'command', 'command': command}
                with open(path, 'w', encoding='utf-8') as f:
                    json.dump({'statusLine': current}, f)
                changes, new_settings = setup.run(path)
                self.assertEqual(new_settings['statusLine'], current)
                self.assertFalse(any(c.startswith('statusLine') for c in changes))
                shutil.rmtree(self.tmp2, ignore_errors=True)


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
        self.assertEqual(len(self._backups()), 1)  # the second run writes nothing, so no extra backup is made


class TestCompactedHooks(SetupTestBase):
    """SessionStart (matcher=compact) and UserPromptSubmit are the hooks needed to mark a session as compacted."""

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
        # Even when an existing SessionStart entry already has a different matcher
        # (e.g. a 'startup' one added by another tool), a separate compact entry is
        # added alongside it (the existing entry is left intact).
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
    """The inverse of `run()`: removes only the hooks and statusLine entries that this tool added."""

    def test_removes_everything_run_added(self):
        setup.run(self.path)
        changes, new_settings = setup.run_remove(self.path)
        self.assertTrue(changes)
        self.assertNotIn('hooks', new_settings)
        self.assertNotIn('statusLine', new_settings)
        self.assertEqual(self._read(), new_settings)
        self.assertEqual(len(self._backups()), 1)  # install made no backup (no pre-existing file); remove makes 1

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
        self.assertEqual(self._backups(), [])  # nothing changes, so no backup is made either

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
        self.assertEqual(self._backups(), [])  # neither install nor the dry-run remove wrote anything


class TestUnreadableSettings(SetupTestBase):
    """A malformed settings.json must never be silently treated as `{}` and overwritten
    — that would discard whatever was really there. `run()`/`run_remove()` raise
    instead, writing nothing (see setup.SettingsUnreadable)."""

    def test_run_raises_on_broken_json_and_writes_nothing(self):
        self._write_text('{not json')
        with self.assertRaises(setup.SettingsUnreadable):
            setup.run(self.path)
        self.assertEqual(self._read_text(), '{not json')
        self.assertEqual(self._backups(), [])

    def test_run_remove_raises_on_broken_json_and_writes_nothing(self):
        self._write_text('{not json')
        with self.assertRaises(setup.SettingsUnreadable):
            setup.run_remove(self.path)
        self.assertEqual(self._read_text(), '{not json')
        self.assertEqual(self._backups(), [])

    def test_run_raises_when_json_is_not_an_object(self):
        self._write_text('[1, 2, 3]')
        with self.assertRaises(setup.SettingsUnreadable):
            setup.run(self.path)
        self.assertEqual(self._backups(), [])

    def test_run_remove_raises_when_json_is_not_an_object(self):
        self._write_text('[1, 2, 3]')
        with self.assertRaises(setup.SettingsUnreadable):
            setup.run_remove(self.path)
        self.assertEqual(self._backups(), [])

    def test_cmd_setup_reports_the_error_and_exits_nonzero(self):
        import io
        from contextlib import redirect_stderr

        from agentsessions import cmd_setup
        self._write_text('{not json')
        err = io.StringIO()
        with redirect_stderr(err):
            rc = cmd_setup.main(['--settings', self.path])
        self.assertNotEqual(rc, 0)
        self.assertIn(self.path, err.getvalue())
        self.assertEqual(self._read_text(), '{not json')
        self.assertEqual(self._backups(), [])


class TestBackupPreservesOriginalText(SetupTestBase):
    """The backup is a byte-faithful copy of what was on disk, not a re-serialization
    of the parsed JSON (which could reorder keys or change formatting)."""

    def test_run_backup_matches_original_bytes_exactly(self):
        original = '{\n  "hooks": {"Stop": [{"matcher": ".*", "hooks": [{"type": "command", "command": "\\"$HOME/bin/cs\\" hook"}]}]}\n}\n'
        self._write_text(original)
        setup.run(self.path)
        [backup] = self._backups()
        with open(backup, encoding='utf-8') as f:
            self.assertEqual(f.read(), original)

    def test_run_remove_backup_matches_original_bytes_exactly(self):
        setup.run(self.path)  # creates a well-formed, freshly-installed settings.json
        original = self._read_text()
        setup.run_remove(self.path)
        backups = self._backups()
        self.assertEqual(len(backups), 1)
        with open(backups[0], encoding='utf-8') as f:
            self.assertEqual(f.read(), original)


if __name__ == '__main__':
    unittest.main()

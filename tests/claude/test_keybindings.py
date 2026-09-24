import json
import os
import shutil
import tempfile
import unittest

from agentsessions import keybindings


class KeybindingsTestBase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.path = os.path.join(self.tmpdir, 'keybindings.json')

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


class TestMissingFile(KeybindingsTestBase):
    def test_missing_file_is_a_no_op(self):
        changed, warning = keybindings.remove_enter_keys(self.path)
        self.assertFalse(changed)
        self.assertIsNone(warning)
        self.assertFalse(os.path.exists(self.path))


class TestBrokenFile(KeybindingsTestBase):
    def test_invalid_json_is_left_untouched(self):
        self._write_text('{not json')
        changed, warning = keybindings.remove_enter_keys(self.path)
        self.assertFalse(changed)
        self.assertIsNotNone(warning)
        with open(self.path, encoding='utf-8') as f:
            self.assertEqual(f.read(), '{not json')

    def test_missing_bindings_array_is_left_untouched(self):
        self._write({'foo': 'bar'})
        changed, warning = keybindings.remove_enter_keys(self.path)
        self.assertFalse(changed)
        self.assertIsNotNone(warning)


class TestRemoval(KeybindingsTestBase):
    def test_removes_both_keys_and_drops_empty_chat_block(self):
        self._write({
            'bindings': [
                {'context': 'Chat', 'bindings': {'enter': 'chat:newline', 'meta+enter': 'chat:submit'}},
            ],
        })
        changed, warning = keybindings.remove_enter_keys(self.path)
        self.assertTrue(changed)
        self.assertIsNone(warning)
        data = self._read()
        self.assertEqual(data['bindings'], [])

    def test_leaves_other_keys_in_chat_block(self):
        self._write({
            'bindings': [
                {'context': 'Chat', 'bindings': {
                    'enter': 'chat:newline', 'meta+enter': 'chat:submit', 'ctrl+k': 'chat:clear',
                }},
            ],
        })
        changed, warning = keybindings.remove_enter_keys(self.path)
        self.assertTrue(changed)
        self.assertIsNone(warning)
        data = self._read()
        self.assertEqual(data['bindings'], [{'context': 'Chat', 'bindings': {'ctrl+k': 'chat:clear'}}])

    def test_leaves_other_contexts_alone(self):
        self._write({
            'bindings': [
                {'context': 'Chat', 'bindings': {'enter': 'chat:newline', 'meta+enter': 'chat:submit'}},
                {'context': 'Global', 'bindings': {'ctrl+q': 'quit'}},
            ],
        })
        keybindings.remove_enter_keys(self.path)
        data = self._read()
        self.assertEqual(data['bindings'], [{'context': 'Global', 'bindings': {'ctrl+q': 'quit'}}])

    def test_mismatched_value_is_left_and_warned(self):
        self._write({
            'bindings': [
                {'context': 'Chat', 'bindings': {'enter': 'chat:custom-thing', 'meta+enter': 'chat:submit'}},
            ],
        })
        changed, warning = keybindings.remove_enter_keys(self.path)
        self.assertTrue(changed)  # meta+enter is removed
        self.assertIsNotNone(warning)
        data = self._read()
        self.assertEqual(data['bindings'][0]['bindings'], {'enter': 'chat:custom-thing'})

    def test_no_chat_block_is_a_no_op_and_leaves_the_file_untouched(self):
        original = '{"bindings": [{"context": "Global", "bindings": {"ctrl+q": "quit"}}]}'
        self._write_text(original)
        before_mtime = os.stat(self.path).st_mtime_ns
        changed, warning = keybindings.remove_enter_keys(self.path)
        self.assertFalse(changed)
        self.assertIsNone(warning)
        with open(self.path, encoding='utf-8') as f:
            self.assertEqual(f.read(), original)  # not rewritten at all
        self.assertEqual(os.stat(self.path).st_mtime_ns, before_mtime)

    def test_chat_block_with_no_matching_keys_is_a_no_op_and_writes_nothing(self):
        # A Chat block exists, but neither enter nor meta+enter is set — still nothing
        # of ours to remove, so this must not add $schema/$docs either.
        self._write({'bindings': [{'context': 'Chat', 'bindings': {'ctrl+k': 'chat:clear'}}]})
        changed, warning = keybindings.remove_enter_keys(self.path)
        self.assertFalse(changed)
        self.assertIsNone(warning)
        data = self._read()
        self.assertNotIn('$schema', data)
        self.assertNotIn('$docs', data)

    def test_existing_schema_and_docs_are_kept(self):
        self._write({
            '$schema': 'https://example.com/custom.json',
            'bindings': [{'context': 'Chat', 'bindings': {'enter': 'chat:newline', 'meta+enter': 'chat:submit'}}],
        })
        keybindings.remove_enter_keys(self.path)
        data = self._read()
        self.assertEqual(data['$schema'], 'https://example.com/custom.json')


class TestDryRun(KeybindingsTestBase):
    def test_dry_run_reports_without_writing(self):
        original = {
            'bindings': [{'context': 'Chat', 'bindings': {'enter': 'chat:newline', 'meta+enter': 'chat:submit'}}],
        }
        self._write(original)
        changed, warning = keybindings.remove_enter_keys(self.path, dry_run=True)
        self.assertTrue(changed)
        self.assertIsNone(warning)
        self.assertEqual(self._read(), original)


if __name__ == '__main__':
    unittest.main()

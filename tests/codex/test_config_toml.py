import glob
import importlib
import os
import tempfile
import unittest
from unittest import mock

from agentsessions.codex import config_toml


class ConfigTomlTestBase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.path = os.path.join(self.tmpdir, 'config.toml')

    def _write(self, text: str) -> None:
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write(text)

    def _read(self) -> str:
        with open(self.path, encoding='utf-8') as f:
            return f.read()

    def _backups(self):
        return glob.glob(self.path + '.bak-*')


class TestComputeRemoval(unittest.TestCase):
    """`compute_removal` is pure -- the bug this guards against is a full TOML
    parse/rewrite reformatting or reordering content that had nothing to do
    with this project; every one of these asserts the *other* lines are kept
    completely untouched, not just "present in some form"."""

    def test_drops_only_marked_lines(self):
        text = (
            'personality = "pragmatic"\n'
            'submit = "enter"  # managed by Agent Sessions\n'
            'model = "gpt-5.6-luna"\n'
        )
        new_text, changed = config_toml.compute_removal(text)
        self.assertTrue(changed)
        self.assertEqual(new_text, 'personality = "pragmatic"\nmodel = "gpt-5.6-luna"\n')

    def test_no_marked_lines_is_a_no_op(self):
        text = 'personality = "pragmatic"\nmodel = "gpt-5.6-luna"\n'
        new_text, changed = config_toml.compute_removal(text)
        self.assertFalse(changed)
        self.assertEqual(new_text, text)

    def test_leaves_an_orphaned_section_header_alone(self):
        # Per the contract (T-109): line-based only, nothing inferred about
        # emptied sections -- if the plugin only added keys to a table that
        # already existed (e.g. the user's or Codex's own [keymap]), the
        # header line itself never gets the marker, so it's always left
        # exactly as it is, even if every key under it was ours.
        text = (
            '[keymap]\n'
            'submit = "enter"  # managed by Agent Sessions\n'
            'insert_newline = "shift+enter"  # managed by Agent Sessions\n'
            '\n'
            '[tui]\n'
            'status_line_use_colors = true\n'
        )
        new_text, changed = config_toml.compute_removal(text)
        self.assertTrue(changed)
        self.assertEqual(new_text, '[keymap]\n\n[tui]\nstatus_line_use_colors = true\n')

    def test_a_marked_header_for_a_table_the_plugin_created_is_removed_too(self):
        # Confirmed with lnx-ts: when the plugin creates a *new* table solely
        # to hold its own keys (e.g. [tui.keymap.composer]), it marks the
        # header line itself too -- so removal here needs no special-casing
        # at all, the header is just another line ending with the marker.
        text = (
            '[tui.keymap.composer]  # managed by Agent Sessions\n'
            'submit = "enter"  # managed by Agent Sessions\n'
            '\n'
            '[tui]\n'
            'status_line_use_colors = true\n'
        )
        new_text, changed = config_toml.compute_removal(text)
        self.assertTrue(changed)
        self.assertEqual(new_text, '\n[tui]\nstatus_line_use_colors = true\n')

    def test_leaves_other_keys_in_the_same_section(self):
        text = (
            '[tui]\n'
            'screen_reader_detection_done = true\n'
            'status_line = ["model-with-reasoning"]  # managed by Agent Sessions\n'
            'status_line_use_colors = true\n'
        )
        new_text, changed = config_toml.compute_removal(text)
        self.assertTrue(changed)
        self.assertEqual(new_text,
                          '[tui]\nscreen_reader_detection_done = true\nstatus_line_use_colors = true\n')

    def test_does_not_match_the_marker_as_a_mid_line_substring(self):
        # A value that happens to *contain* the marker text mid-line (not at
        # the end) is not ours and must never be dropped.
        text = 'note = "not # managed by Agent Sessions, just similar text elsewhere"\nx = 1\n'
        new_text, changed = config_toml.compute_removal(text)
        self.assertFalse(changed)
        self.assertEqual(new_text, text)

    def test_marker_with_trailing_whitespace_is_still_recognized(self):
        text = 'submit = "enter"  # managed by Agent Sessions   \nmodel = "x"\n'
        new_text, changed = config_toml.compute_removal(text)
        self.assertTrue(changed)
        self.assertEqual(new_text, 'model = "x"\n')

    def test_file_with_no_trailing_newline_on_the_last_line(self):
        text = 'model = "x"\nsubmit = "enter"  # managed by Agent Sessions'
        new_text, changed = config_toml.compute_removal(text)
        self.assertTrue(changed)
        self.assertEqual(new_text, 'model = "x"\n')

    def test_empty_file_is_a_no_op(self):
        new_text, changed = config_toml.compute_removal('')
        self.assertFalse(changed)
        self.assertEqual(new_text, '')


class TestRemoveManagedLines(ConfigTomlTestBase):
    def test_missing_file_is_a_no_op(self):
        changed, message = config_toml.remove_managed_lines(self.path)
        self.assertFalse(changed)
        self.assertIsNone(message)
        self.assertFalse(os.path.exists(self.path))

    def test_removes_marked_lines_and_backs_up_first(self):
        self._write('personality = "pragmatic"\nsubmit = "enter"  # managed by Agent Sessions\n')
        changed, message = config_toml.remove_managed_lines(self.path)
        self.assertTrue(changed)
        self.assertIsNotNone(message)
        self.assertEqual(self._read(), 'personality = "pragmatic"\n')
        backups = self._backups()
        self.assertEqual(len(backups), 1)
        with open(backups[0], encoding='utf-8') as f:
            self.assertEqual(f.read(), 'personality = "pragmatic"\nsubmit = "enter"  # managed by Agent Sessions\n')

    def test_nothing_to_remove_writes_nothing_and_no_backup(self):
        original = 'personality = "pragmatic"\n'
        self._write(original)
        before_mtime = os.stat(self.path).st_mtime_ns
        changed, message = config_toml.remove_managed_lines(self.path)
        self.assertFalse(changed)
        self.assertIsNone(message)
        self.assertEqual(self._read(), original)
        self.assertEqual(os.stat(self.path).st_mtime_ns, before_mtime)
        self.assertEqual(self._backups(), [])

    def test_dry_run_reports_without_writing_or_backing_up(self):
        original = 'submit = "enter"  # managed by Agent Sessions\n'
        self._write(original)
        changed, message = config_toml.remove_managed_lines(self.path, dry_run=True)
        self.assertTrue(changed)
        self.assertIsNotNone(message)
        self.assertEqual(self._read(), original)   # untouched
        self.assertEqual(self._backups(), [])

    def test_default_path_respects_codex_home(self):
        with mock.patch.dict(os.environ, {'CODEX_HOME': '/custom/codex/home'}):
            reloaded = importlib.reload(config_toml)
            self.assertEqual(reloaded.DEFAULT_CONFIG_TOML_PATH, '/custom/codex/home/config.toml')
        importlib.reload(config_toml)   # restore the real default for any test after this one


if __name__ == '__main__':
    unittest.main()

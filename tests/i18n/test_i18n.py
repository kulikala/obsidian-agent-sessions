import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from agentsessions import config, i18n
from agentsessions.i18n.locales import en, ja


class TestLocaleCoverage(unittest.TestCase):
    """English is the base language: every other locale's keys must be a subset of
    it, since anything not covered falls back to English."""

    def test_all_registered_locales_are_subsets_of_english(self):
        base = set(en.MESSAGES)
        for lang, table in i18n._TABLES.items():
            if lang == 'en':
                continue
            with self.subTest(lang=lang):
                self.assertTrue(set(table) <= base,
                                set(table) - base)

    def test_japanese_locale_is_registered_and_nonempty(self):
        self.assertIn('ja', i18n._TABLES)
        self.assertIs(i18n._TABLES['ja'], ja.MESSAGES)
        self.assertTrue(ja.MESSAGES)


class TestFallback(unittest.TestCase):
    """A key missing from the active locale's table falls back to English, rather
    than showing the raw key."""

    def test_missing_key_falls_back_to_english(self):
        fake_tables = {
            'en': {'only_in_en': 'English only', 'shared': 'English shared'},
            'xx': {'shared': 'XX shared'},
        }
        with mock.patch.object(i18n, '_TABLES', fake_tables), \
                mock.patch.object(i18n, 'language', return_value='xx'):
            self.assertEqual(i18n.t('shared'), 'XX shared')
            self.assertEqual(i18n.t('only_in_en'), 'English only')

    def test_unknown_key_returns_the_key_itself(self):
        with mock.patch.object(i18n, 'language', return_value='en'):
            self.assertEqual(i18n.t('no.such.key'), 'no.such.key')

    def test_values_are_substituted_when_given(self):
        with mock.patch.object(i18n, 'language', return_value='en'):
            self.assertEqual(i18n.t('cmd.needs_value', flag='--foo'), '--foo needs a value')


class TestEnvLanguageResolution(unittest.TestCase):
    """`LANG`/`LC_ALL`/`LC_MESSAGES` are matched against the registered languages by
    prefix, case-insensitively; the first of the three that's set decides; no match
    falls back to English."""

    def setUp(self):
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for var in ('AGENT_SESSIONS_ID', 'LANG', 'LC_ALL', 'LC_MESSAGES'):
            os.environ.pop(var, None)

    def test_no_env_vars_set_defaults_to_english(self):
        self.assertEqual(i18n.language(), 'en')

    def test_lang_ja_prefix_selects_japanese(self):
        os.environ['LANG'] = 'ja_JP.UTF-8'
        self.assertEqual(i18n.language(), 'ja')

    def test_match_is_case_insensitive(self):
        os.environ['LANG'] = 'JA_JP.UTF-8'
        self.assertEqual(i18n.language(), 'ja')

    def test_unregistered_language_falls_back_to_english(self):
        os.environ['LANG'] = 'fr_FR.UTF-8'
        self.assertEqual(i18n.language(), 'en')

    def test_lang_takes_priority_over_lc_all(self):
        os.environ['LANG'] = 'en_US.UTF-8'
        os.environ['LC_ALL'] = 'ja_JP.UTF-8'
        self.assertEqual(i18n.language(), 'en')

    def test_falls_through_to_lc_all_when_lang_unset(self):
        os.environ['LC_ALL'] = 'ja_JP.UTF-8'
        self.assertEqual(i18n.language(), 'ja')

    def test_falls_through_to_lc_messages_when_others_unset(self):
        os.environ['LC_MESSAGES'] = 'ja_JP.UTF-8'
        self.assertEqual(i18n.language(), 'ja')

    def test_set_but_unmatched_lang_does_not_fall_through_to_lc_all(self):
        # The first *set* var decides, matched or not — it doesn't skip to the next
        # one just because it didn't match a registered language.
        os.environ['LANG'] = 'fr_FR.UTF-8'
        os.environ['LC_ALL'] = 'ja_JP.UTF-8'
        self.assertEqual(i18n.language(), 'en')


class TestUiStateLanguage(unittest.TestCase):
    """A plugin-launched session (AGENT_SESSIONS_ID set) prefers ui.json's `language`
    field over the environment, but only when it names a registered language."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.ui_state_path = os.path.join(self.tmpdir, 'ui.json')
        self.patcher = mock.patch.object(config, 'UI_STATE_PATH', self.ui_state_path)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        env_patcher = mock.patch.dict(os.environ, {}, clear=False)
        env_patcher.start()
        self.addCleanup(env_patcher.stop)
        for var in ('LANG', 'LC_ALL', 'LC_MESSAGES'):
            os.environ.pop(var, None)
        os.environ['AGENT_SESSIONS_ID'] = 'x'

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_ui_state(self, data):
        with open(self.ui_state_path, 'w', encoding='utf-8') as f:
            json.dump(data, f)

    def test_registered_language_in_ui_state_is_used(self):
        self._write_ui_state({'language': 'ja'})
        self.assertEqual(i18n.language(), 'ja')

    def test_unregistered_language_in_ui_state_falls_back_to_env(self):
        self._write_ui_state({'language': 'fr'})
        os.environ['LANG'] = 'ja_JP.UTF-8'
        self.assertEqual(i18n.language(), 'ja')

    def test_missing_ui_state_falls_back_to_env(self):
        os.environ['LANG'] = 'ja_JP.UTF-8'
        self.assertEqual(i18n.language(), 'ja')

    def test_without_agent_sessions_id_ui_state_is_ignored(self):
        os.environ.pop('AGENT_SESSIONS_ID', None)
        self._write_ui_state({'language': 'ja'})
        os.environ['LANG'] = 'en_US.UTF-8'
        self.assertEqual(i18n.language(), 'en')

    def test_broken_ui_state_falls_back_to_env(self):
        with open(self.ui_state_path, 'w', encoding='utf-8') as f:
            f.write('not json')
        os.environ['LANG'] = 'ja_JP.UTF-8'
        self.assertEqual(i18n.language(), 'ja')


if __name__ == '__main__':
    unittest.main()

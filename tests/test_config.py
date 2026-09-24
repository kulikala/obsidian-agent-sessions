import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from agentsessions import config


class TestResolveVault(unittest.TestCase):
    """Resolution order: env AGENT_SESSIONS_VAULT -> ~/.agents/sessions/vault.json -> None."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state_path = os.path.join(self.tmp, 'vault.json')
        self.patcher = mock.patch.object(config, 'VAULT_STATE_PATH', self.state_path)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        env_patcher = mock.patch.dict(os.environ)
        env_patcher.start()
        self.addCleanup(env_patcher.stop)
        os.environ.pop('AGENT_SESSIONS_VAULT', None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_state(self, data):
        with open(self.state_path, 'w', encoding='utf-8') as f:
            json.dump(data, f)

    def test_env_wins_when_both_present(self):
        self._write_state({'vault': '/from/file'})
        os.environ['AGENT_SESSIONS_VAULT'] = '/from/env'
        self.assertEqual(config._resolve_vault(), '/from/env')

    def test_falls_back_to_state_file_when_env_absent(self):
        self._write_state({'vault': '/from/file'})
        self.assertEqual(config._resolve_vault(), '/from/file')

    def test_none_when_neither_present(self):
        self.assertIsNone(config._resolve_vault())

    def test_none_when_state_file_missing(self):
        self.assertFalse(os.path.exists(self.state_path))
        self.assertIsNone(config._resolve_vault())

    def test_none_when_state_file_is_broken_json(self):
        with open(self.state_path, 'w', encoding='utf-8') as f:
            f.write('not json')
        self.assertIsNone(config._resolve_vault())

    def test_none_when_state_file_is_not_an_object(self):
        self._write_state(['not', 'a', 'dict'])
        self.assertIsNone(config._resolve_vault())

    def test_none_when_vault_field_is_missing_or_empty(self):
        self._write_state({})
        self.assertIsNone(config._resolve_vault())
        self._write_state({'vault': ''})
        self.assertIsNone(config._resolve_vault())

    def test_none_when_vault_field_is_not_a_string(self):
        self._write_state({'vault': 123})
        self.assertIsNone(config._resolve_vault())

    def test_empty_env_var_falls_back_to_state_file(self):
        self._write_state({'vault': '/from/file'})
        os.environ['AGENT_SESSIONS_VAULT'] = ''
        self.assertEqual(config._resolve_vault(), '/from/file')


class TestRequireVault(unittest.TestCase):
    def test_returns_vault_when_set(self):
        with mock.patch.object(config, 'VAULT', '/some/vault'):
            self.assertEqual(config.require_vault(), '/some/vault')

    def test_raises_vault_not_configured_when_none(self):
        with mock.patch.object(config, 'VAULT', None):
            with self.assertRaises(config.VaultNotConfigured) as ctx:
                config.require_vault()
            self.assertIn('AGENT_SESSIONS_VAULT', str(ctx.exception))


if __name__ == '__main__':
    unittest.main()

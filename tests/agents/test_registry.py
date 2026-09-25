import json
import os
import tempfile
import unittest
from unittest import mock

from agentsessions import agents, config


class TestEnabledAgents(unittest.TestCase):
    def test_env_var_wins_and_filters_unknown_names(self):
        with mock.patch.dict(os.environ, {'AGENT_SESSIONS_AGENTS': 'claude,codex,made-up'}):
            self.assertEqual(agents.enabled_agents(), ['claude', 'codex'])

    def test_env_var_single_agent(self):
        with mock.patch.dict(os.environ, {'AGENT_SESSIONS_AGENTS': 'codex'}):
            self.assertEqual(agents.enabled_agents(), ['codex'])

    def test_falls_back_to_ui_json_when_env_absent(self):
        with tempfile.TemporaryDirectory() as d:
            ui_path = os.path.join(d, 'ui.json')
            with open(ui_path, 'w') as f:
                json.dump({'agents': ['codex']}, f)
            with mock.patch.object(config, 'UI_STATE_PATH', ui_path), \
                 mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop('AGENT_SESSIONS_AGENTS', None)
                self.assertEqual(agents.enabled_agents(), ['codex'])

    def test_defaults_to_claude_only_when_nothing_configured(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(config, 'UI_STATE_PATH', os.path.join(d, 'missing.json')):
                os.environ.pop('AGENT_SESSIONS_AGENTS', None)
                self.assertEqual(agents.enabled_agents(), ['claude'])


if __name__ == '__main__':
    unittest.main()

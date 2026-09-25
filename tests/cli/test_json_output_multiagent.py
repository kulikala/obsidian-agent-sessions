import os
import shutil
import tempfile
import unittest
from unittest import mock

from agentsessions import config
from agentsessions.cli import json_output as jsonout
from tests.agents.codex_helpers import rollout_path, session_meta, user_message, write_rollout

CLAUDE_ID = '11111111-1111-1111-1111-111111111111'
CODEX_ID = '01000000-0000-0000-0000-00000000dead'


def write_claude_jsonl(path, records):
    import json
    with open(path, 'w') as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n')


class TestMultiAgentScan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.proj_root = os.path.join(self.tmp, 'projects')
        os.makedirs(self.proj_root)
        self.codex_home = os.path.join(self.tmp, 'codex-home')
        self.store_path = os.path.join(self.tmp, 'sessions.json')
        self.cache_path = os.path.join(self.tmp, 'scan-cache.json')

        proj = os.path.join(self.proj_root, '-Users-k-vault')
        os.makedirs(proj)
        write_claude_jsonl(os.path.join(proj, CLAUDE_ID + '.jsonl'), [
            {'type': 'user', 'cwd': '/Users/k/vault', 'message': {'role': 'user', 'content': 'a claude prompt'}},
        ])
        write_rollout(rollout_path(self.codex_home, CODEX_ID), [
            session_meta(CODEX_ID, '/work/codex-project'),
            user_message('a codex prompt', '2026-09-24T01:30:31Z'),
        ])

        self.patchers = [
            mock.patch.object(config, 'PROJECTS_DIR', self.proj_root),
            mock.patch.object(config, 'STORE_PATH', self.store_path),
            mock.patch.object(config, 'CACHE_PATH', self.cache_path),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)
        os.environ['CODEX_HOME'] = self.codex_home
        os.environ['AGENT_SESSIONS_AGENTS'] = 'claude,codex'
        self.addCleanup(os.environ.pop, 'CODEX_HOME', None)
        self.addCleanup(os.environ.pop, 'AGENT_SESSIONS_AGENTS', None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_scan_output_merges_and_tags_both_agents(self):
        out = jsonout.scan_output()
        by_id = {s['id']: s for s in out['sessions']}
        self.assertEqual(by_id[CLAUDE_ID]['agent'], 'claude')
        self.assertEqual(by_id[CODEX_ID]['agent'], 'codex')
        self.assertEqual(by_id[CODEX_ID]['cwd'], '/work/codex-project')

    def test_scan_output_claude_only_when_codex_not_enabled(self):
        os.environ['AGENT_SESSIONS_AGENTS'] = 'claude'
        out = jsonout.scan_output()
        ids = {s['id'] for s in out['sessions']}
        self.assertIn(CLAUDE_ID, ids)
        self.assertNotIn(CODEX_ID, ids)

    def test_detail_output_resolves_across_agents(self):
        d = jsonout.detail_output(CODEX_ID)
        self.assertEqual(d['last_user'], 'a codex prompt')

    def test_toggling_codex_off_and_on_preserves_its_cache_entry(self):
        jsonout.scan_output()   # populates cache for both agents
        os.environ['AGENT_SESSIONS_AGENTS'] = 'claude'
        jsonout.scan_output()   # claude-only run must not prune codex's cache entry
        from agentsessions.sessions import cache
        c = cache.load(path=self.cache_path)
        codex_path = rollout_path(self.codex_home, CODEX_ID)
        self.assertIn(codex_path, c)


if __name__ == '__main__':
    unittest.main()

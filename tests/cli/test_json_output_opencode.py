import json
import os
import tempfile
import unittest
from unittest import mock

from agentsessions import config
from agentsessions.agents.opencode import resolve as ocresolve
from agentsessions.cli import json_output as jsonout
from tests.agents.opencode_helpers import Fixture, make_db
from tests.cli.test_json_output_multiagent import DAEMON_UUID, TestCodexDaemonRelabeling

S1 = 'ses_bbbbbbbbbbbb01'
S2 = 'ses_bbbbbbbbbbbb02'


class TestOpencodeJson(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name
        self.status_dir = os.path.join(self.tmp, 'status')
        os.makedirs(self.status_dir)
        self.store_path = os.path.join(self.tmp, 'sessions.json')
        patches = [
            mock.patch.dict(os.environ, {'XDG_DATA_HOME': self.tmp, 'AGENT_SESSIONS_AGENTS': 'opencode'}),
            mock.patch.object(config, 'STORE_PATH', self.store_path),
            mock.patch.object(config, 'CACHE_PATH', os.path.join(self.tmp, 'scan-cache.json')),
            mock.patch.object(config, 'OPENCODE_STATUS_DIR', self.status_dir),
            mock.patch.object(config, 'SOCK_PATH', os.path.join(self.tmp, 'none.sock')),
            mock.patch.object(config, 'UI_STATE_PATH', os.path.join(self.tmp, 'ui.json')),
            mock.patch.object(ocresolve, '_ps_tree', return_value=[]),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        path = make_db(self.tmp)
        with Fixture(path) as f:
            f.session(S1, directory='/work/a', title='Fix the parser', created=1_000, updated=8_000,
                      model={'id': 'gemma', 'providerID': 'ollama'})
            f.user(S1, 'please fix the parser', 1_000)
            f.assistant(S1, 'fixed', 2_000, tools=('edit',),
                        tokens={'total': 15, 'input': 10, 'output': 5, 'reasoning': 0,
                                'cache': {'read': 0, 'write': 0}}, cost=0.02)
            f.session(S2, directory='/work/b', title='New session - 2026-09-30T00:00:00.000Z',
                      created=3_000, updated=9_000)
            f.user(S2, 'x' * 100, 3_000)

    def test_scan_rows(self):
        out = jsonout.scan_output()
        by_id = {s['id']: s for s in out['sessions']}
        r = by_id[S1]
        self.assertEqual((r['agent'], r['name'], r['cwd'], r['child'], r['model']),
                         ('opencode', 'Fix the parser', '/work/a', False, 'ollama/gemma'))
        self.assertEqual(r['last_activity'], 8.0)
        self.assertEqual(r['transcript'], 'opencode:' + S1)
        self.assertNotIn('effort', r)
        u = by_id[S2]
        self.assertIsNone(u['name'])
        self.assertEqual(u['label'], 'x' * jsonout.OTHER_LABEL_LEN)
        self.assertNotIn('model', u)      # unknown model: field absent

    def test_scan_only(self):
        out = jsonout.scan_output(only=[S2])
        self.assertEqual([s['id'] for s in out['sessions']], [S2])

    def test_scan_is_stable_across_runs_and_leaves_no_cache_entries(self):
        first = jsonout.scan_output()['sessions']
        second = jsonout.scan_output()['sessions']
        self.assertEqual(first, second)
        with open(config.CACHE_PATH) as f:
            self.assertEqual(json.load(f), {})

    def test_detail_and_usage(self):
        d = jsonout.detail_output(S1)
        self.assertEqual((d['last_user'], d['last_assistant'], d['tools'], d['last_command'], d['model']),
                         ('please fix the parser', 'fixed', ['edit'], None, 'ollama/gemma'))
        u = jsonout.usage_output(S1)
        self.assertEqual((u['total']['calls'], u['total']['input'], u['total']['output']), (1, 10, 5))
        self.assertAlmostEqual(u['total']['cost'], 0.02)

    def test_live_reads_status_files(self):
        with open(os.path.join(self.status_dir, S1 + '.json'), 'w') as f:
            json.dump({'status': 'waiting', 'waiting_for': 'permission', 'pid': os.getpid(),
                       'updated_at': 42.0, 'cwd': '/work/a'}, f)
        out = jsonout.live_output()
        self.assertEqual(out['live'][S1], {'agent': 'opencode', 'status': 'waiting',
                                           'status_label': out['live'][S1]['status_label'],
                                           'pid': os.getpid(), 'updated_at': 42.0,
                                           'waiting_for': 'permission'})

    def test_live_does_not_scan_opencode_sessions(self):
        with mock.patch.object(jsonout.opencode_agent, 'scan', side_effect=AssertionError('no scan')), \
                mock.patch.object(jsonout.opencode_agent, 'list_transcripts', side_effect=AssertionError('no scan')):
            self.assertEqual(jsonout.live_output()['live'], {})

    def test_resolve(self):
        got = jsonout.resolve_output('opencode', 0, 2.0, '/work/b')
        self.assertEqual(got, {'thread': S2, 'transcript': 'opencode:' + S2})
        with open(self.store_path, 'w') as f:
            json.dump({'version': 1, 'folded': [], 'archived': [], 'pendingRenames': {},
                       'sessions': {S2: {'agent': 'opencode', 'daemon': DAEMON_UUID}},
                       'categoryColors': {}}, f)
        self.assertEqual(jsonout.resolve_output('opencode', 0, 2.0, '/work/b'),
                         {'thread': None, 'transcript': None})
        # an agent that picks its own id has nothing to resolve
        self.assertEqual(jsonout.resolve_output('claude', 0, 2.0, '/work/b'),
                         {'thread': None, 'transcript': None})

    def test_stats_omits_opencode(self):
        with mock.patch.object(jsonout.stats, 'compute', return_value={'windows': {}}):
            out = jsonout.stats_output()
        self.assertNotIn('opencode', out.get('agents', {}))

    def test_disabled_agent_is_not_scanned(self):
        os.environ['AGENT_SESSIONS_AGENTS'] = 'claude'
        with mock.patch.object(config, 'PROJECTS_DIR', os.path.join(self.tmp, 'no-projects')):
            ids = {s['id'] for s in jsonout.scan_output()['sessions']}
        self.assertNotIn(S1, ids)


class TestDaemonRelabelingGeneralised(TestCodexDaemonRelabeling):
    """The relabeling in `_daemon_list` follows the entry's `agent`, not a hard-coded "codex"."""

    def test_linked_opencode_session_is_relabeled_to_its_session_id(self):
        self._write_store({S1: {'agent': 'opencode', 'daemon': DAEMON_UUID}})
        t = self._serve_list([{'id': DAEMON_UUID, 'agent': 'opencode', 'cwd': '/work/x', 'pid': 5,
                               'startedAt': 1.0, 'clients': 1, 'exited': None, 'exitedAt': None}])
        try:
            out = jsonout.live_output()
        finally:
            t.join(timeout=2)
        self.assertEqual([s['id'] for s in out['daemon']['sessions']], [S1])

    def test_a_link_only_relabels_the_matching_daemon_session(self):
        self._write_store({S1: {'agent': 'opencode', 'daemon': DAEMON_UUID}})
        other = '88888888-8888-8888-8888-888888888888'
        t = self._serve_list([
            {'id': DAEMON_UUID, 'agent': 'opencode', 'cwd': '/a', 'pid': 5, 'startedAt': 1.0, 'clients': 0,
             'exited': None, 'exitedAt': None},
            {'id': other, 'agent': 'opencode', 'cwd': '/b', 'pid': 6, 'startedAt': 1.0, 'clients': 0,
             'exited': None, 'exitedAt': None},
        ])
        try:
            out = jsonout.live_output()
        finally:
            t.join(timeout=2)
        self.assertEqual([s['id'] for s in out['daemon']['sessions']], [S1, other])


del TestCodexDaemonRelabeling   # imported only as a base class; don't run its tests twice

if __name__ == '__main__':
    unittest.main()

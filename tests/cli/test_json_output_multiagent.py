import json
import os
import shutil
import socket
import tempfile
import threading
import unittest
from unittest import mock

from agentsessions import config
from agentsessions.cli import json_output as jsonout
from agentsessions.daemon import protocol
from tests.agents.codex_helpers import rollout_path, session_meta, user_message, write_rollout

CLAUDE_ID = '11111111-1111-1111-1111-111111111111'
CODEX_ID = '01000000-0000-0000-0000-00000000dead'
DAEMON_UUID = '99999999-9999-9999-9999-999999999999'
THREAD_ID = '02000000-0000-0000-0000-00000000beef'


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


class TestCodexDaemonRelabeling(unittest.TestCase):
    """`json live`'s daemon-list part relabels a Codex session's daemon-assigned
    uuid to its resolved thread id (per team-lead's ruling: the thread id is the
    session's permanent identity; sessions.json links `sessions[thread_id] =
    {"agent": "codex", "daemon": "<uuid>"}`)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store_path = os.path.join(self.tmp, 'sessions.json')
        self.sock_path = os.path.join(self.tmp, 'daemon.sock')
        # Only `_daemon_list` (the daemon's own `list`) is under test here, but
        # `live_output` also calls `agents.claude.live_sessions()` for the
        # (default-enabled) claude agent -- point it at an empty dir so this
        # never picks up a real ~/.claude/sessions ledger from this machine.
        self.sessions_dir = os.path.join(self.tmp, 'claude-sessions')
        os.makedirs(self.sessions_dir)
        self.patchers = [
            mock.patch.object(config, 'STORE_PATH', self.store_path),
            mock.patch.object(config, 'SOCK_PATH', self.sock_path),
            mock.patch.object(config, 'SESSIONS_DIR', self.sessions_dir),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _serve_list(self, daemon_sessions):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(self.sock_path)
        server.listen(1)

        def serve_one():
            conn, _ = server.accept()
            try:
                decoder = protocol.Decoder()
                while True:
                    chunk = conn.recv(4096)
                    if not chunk:
                        return
                    for kind, payload in decoder.feed(chunk):
                        if kind != protocol.FRAME_J:
                            continue
                        req = protocol.decode_json(payload)
                        seq = req.get('seq')
                        if req.get('op') == 'hello':
                            conn.sendall(protocol.encode_json({'ok': True, 'version': 1, 'pid': 1, 'seq': seq}))
                        elif req.get('op') == 'list':
                            conn.sendall(protocol.encode_json(
                                {'ok': True, 'sessions': daemon_sessions, 'seq': seq}))
                            return
            finally:
                conn.close()

        t = threading.Thread(target=serve_one, daemon=True)
        t.start()
        return t

    def _write_store(self, sessions):
        with open(self.store_path, 'w') as f:
            json.dump({'version': 1, 'folded': [], 'archived': [], 'pendingRenames': {},
                       'sessions': sessions, 'categoryColors': {}}, f)

    def test_linked_codex_session_is_relabeled_to_thread_id(self):
        self._write_store({THREAD_ID: {'agent': 'codex', 'daemon': DAEMON_UUID}})
        daemon_sessions = [{'id': DAEMON_UUID, 'agent': 'codex', 'cwd': '/work/x', 'pid': 123,
                             'startedAt': 1.0, 'clients': 1, 'exited': None, 'exitedAt': None}]
        t = self._serve_list(daemon_sessions)
        try:
            out = jsonout.live_output()
        finally:
            t.join(timeout=2)
        ids = [s['id'] for s in out['daemon']['sessions']]
        self.assertEqual(ids, [THREAD_ID])

    def test_claude_session_is_never_relabeled(self):
        self._write_store({})
        daemon_sessions = [{'id': CLAUDE_ID, 'agent': 'claude', 'cwd': '/v', 'pid': 1,
                             'startedAt': 1.0, 'clients': 0, 'exited': None, 'exitedAt': None}]
        t = self._serve_list(daemon_sessions)
        try:
            out = jsonout.live_output()
        finally:
            t.join(timeout=2)
        self.assertEqual(out['daemon']['sessions'][0]['id'], CLAUDE_ID)

    def test_unlinked_codex_uuid_is_passed_through_unchanged(self):
        # A stale link (a different, no-longer-running daemon uuid) must not
        # affect a session under a *different*, currently-live uuid.
        self._write_store({THREAD_ID: {'agent': 'codex', 'daemon': 'some-other-now-dead-uuid'}})
        daemon_sessions = [{'id': DAEMON_UUID, 'agent': 'codex', 'cwd': '/work/x', 'pid': 123,
                             'startedAt': 1.0, 'clients': 1, 'exited': None, 'exitedAt': None}]
        t = self._serve_list(daemon_sessions)
        try:
            out = jsonout.live_output()
        finally:
            t.join(timeout=2)
        self.assertEqual(out['daemon']['sessions'][0]['id'], DAEMON_UUID)


if __name__ == '__main__':
    unittest.main()

import json
import os
import shutil
import socket
import tempfile
import threading
import unittest
from unittest import mock

from agentsessions import config, i18n
from agentsessions.cli import json_output as jsonout
from agentsessions.daemon import protocol
from agentsessions.sessions import live, store

ID1 = '11111111-1111-1111-1111-111111111111'
ID2 = '22222222-2222-2222-2222-222222222222'


def write_jsonl(path, records):
    with open(path, 'w') as f:
        for r in records:
            # Detail parsing matches the raw line text against patterns like "type":"user"
            # with no spaces, so write with compact (no-space) separators via json.dumps.
            f.write(json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n')


class JsonoutTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.proj_root = os.path.join(self.tmp, 'projects')
        self.proj = os.path.join(self.proj_root, '-Users-k-vault')
        os.makedirs(self.proj)
        self.store_path = os.path.join(self.tmp, 'sessions.json')
        self.cache_path = os.path.join(self.tmp, 'scan-cache.json')
        self.sessions_dir = os.path.join(self.tmp, 'claude-sessions')
        os.makedirs(self.sessions_dir)

        self.patchers = [
            mock.patch.object(config, 'PROJECTS_DIR', self.proj_root),
            mock.patch.object(config, 'STORE_PATH', self.store_path),
            mock.patch.object(config, 'CACHE_PATH', self.cache_path),
            mock.patch.object(config, 'SESSIONS_DIR', self.sessions_dir),
            # Without this, agents.enabled_agents()'s ui.json fallback would read
            # this *machine's* real ~/.agents/sessions/ui.json (written by a real
            # plugin instance) instead of defaulting to ['claude'] -- these tests
            # assume Claude-only unless a test explicitly overrides AGENT_SESSIONS_AGENTS.
            mock.patch.object(config, 'UI_STATE_PATH', os.path.join(self.tmp, 'ui.json')),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)
        old_agents_env = os.environ.pop('AGENT_SESSIONS_AGENTS', None)
        if old_agents_env is not None:
            self.addCleanup(os.environ.__setitem__, 'AGENT_SESSIONS_AGENTS', old_agents_env)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestScanOutput(JsonoutTestBase):
    def setUp(self):
        super().setUp()
        write_jsonl(os.path.join(self.proj, ID1 + '.jsonl'), [
            {'type': 'system', 'cwd': '/Users/k/vault', 'content': 'x'},
            {'type': 'user', 'message': {'role': 'user', 'content': 'initial question'}},
            {'type': 'custom-title', 'customTitle': 'RIM: Meeting Notes', 'sessionId': ID1},
        ])
        write_jsonl(os.path.join(self.proj, ID2 + '.jsonl'), [
            {'type': 'user', 'cwd': '/Users/k/other', 'message': {'role': 'user', 'content': 'unnamed question'}},
        ])
        store.save(store.Store(folded=['RIM']), path=self.store_path)

    def test_scan_output_shape(self):
        out = jsonout.scan_output()
        self.assertEqual(set(out.keys()), {'sessions', 'store'})
        by_id = {s['id']: s for s in out['sessions']}
        self.assertEqual(set(by_id), {ID1, ID2})

        s1 = by_id[ID1]
        self.assertEqual(s1['agent'], 'claude')
        self.assertEqual(s1['name'], 'RIM: Meeting Notes')
        self.assertEqual(s1['group'], 'RIM')
        self.assertEqual(s1['label'], 'Meeting Notes')
        self.assertEqual(s1['cwd'], '/Users/k/vault')
        self.assertEqual(s1['folder'], 'vault')
        self.assertFalse(s1['child'])
        self.assertTrue(s1['transcript'].endswith(ID1 + '.jsonl'))
        self.assertIsInstance(s1['last_activity'], float)

        s2 = by_id[ID2]
        self.assertIsNone(s2['name'])
        self.assertIsNone(s2['group'])
        self.assertEqual(s2['label'], 'unnamed question')

        self.assertEqual(out['store']['folded'], ['RIM'])
        self.assertEqual(out['store']['archived'], [])
        self.assertEqual(out['store']['pendingRenames'], {})
        self.assertEqual(out['store']['sessions'], {})

    def test_only_returns_just_that_id_and_updates_cache(self):
        out = jsonout.scan_output(only=[ID1])
        ids = [s['id'] for s in out['sessions']]
        self.assertEqual(ids, [ID1])
        self.assertTrue(os.path.exists(self.cache_path))

    def test_second_full_scan_is_fast_via_cache(self):
        jsonout.scan_output()
        import time
        start = time.monotonic()
        jsonout.scan_output()
        self.assertLess(time.monotonic() - start, 0.2)


class TestDetailOutput(JsonoutTestBase):
    def test_returns_last_user_and_assistant(self):
        write_jsonl(os.path.join(self.proj, ID1 + '.jsonl'), [
            {'type': 'user', 'timestamp': '2026-09-01T00:00:00Z',
             'message': {'role': 'user', 'content': 'hello'}},
            {'type': 'assistant', 'timestamp': '2026-09-01T00:00:01Z',
             'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'yes'}]}},
        ])
        out = jsonout.detail_output(ID1)
        self.assertEqual(out['last_user'], 'hello')
        self.assertEqual(out['last_assistant'], 'yes')
        self.assertEqual(out['tools'], [])
        self.assertIsNone(out['last_command'])

    def test_unknown_id_returns_empty_detail(self):
        out = jsonout.detail_output('does-not-exist')
        self.assertEqual(out, {'last_user': '', 'last_assistant': '', 'tools': [],
                                'last_command': None})


class TestLiveOutput(JsonoutTestBase):
    def test_no_daemon_socket_means_not_running(self):
        sock_path = os.path.join(self.tmp, 'no-such.sock')
        with mock.patch.object(config, 'SOCK_PATH', sock_path):
            out = jsonout.live_output()
        self.assertEqual(out['daemon'], {'running': False, 'sessions': []})
        self.assertEqual(out['live'], {})

    def test_fake_daemon_hello_and_list(self):
        sock_path = os.path.join(self.tmp, 'daemon.sock')
        fixed_sessions = [{'id': 'x', 'agent': 'claude', 'cwd': '/v', 'pid': 123,
                            'startedAt': 1.0, 'clients': 1, 'exited': None, 'exitedAt': None}]
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(sock_path)
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
                                {'ok': True, 'sessions': fixed_sessions, 'seq': seq}))
                            return
            finally:
                conn.close()

        t = threading.Thread(target=serve_one, daemon=True)
        t.start()
        try:
            with mock.patch.object(config, 'SOCK_PATH', sock_path):
                out = jsonout.live_output()
        finally:
            t.join(timeout=2)
            server.close()
            os.unlink(sock_path)

        self.assertEqual(out['daemon'], {'running': True, 'sessions': fixed_sessions})

    def test_daemon_that_rejects_hello_means_not_running(self):
        sock_path = os.path.join(self.tmp, 'daemon.sock')
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(sock_path)
        server.listen(1)

        def serve_one():
            conn, _ = server.accept()
            try:
                decoder = protocol.Decoder()
                chunk = conn.recv(4096)
                for kind, payload in decoder.feed(chunk):
                    if kind == protocol.FRAME_J:
                        req = protocol.decode_json(payload)
                        conn.sendall(protocol.encode_json({'ok': False, 'error': 'nope', 'seq': req.get('seq')}))
            finally:
                conn.close()

        t = threading.Thread(target=serve_one, daemon=True)
        t.start()
        try:
            with mock.patch.object(config, 'SOCK_PATH', sock_path):
                out = jsonout.live_output()
        finally:
            t.join(timeout=2)
            server.close()
            os.unlink(sock_path)

        self.assertEqual(out['daemon'], {'running': False, 'sessions': []})

    def test_waiting_session_includes_waiting_for(self):
        # Claude itself writes status/waitingFor when it's blocked on something like
        # AskUserQuestion or a permission prompt. This test uses its own process's pid,
        # so `ps` won't show "claude" in its cmdline; patch `_claude_pids` to return
        # None so the check falls back to `_alive` alone.
        with open(os.path.join(self.sessions_dir, '1.json'), 'w') as f:
            json.dump({'pid': os.getpid(), 'sessionId': ID1, 'status': 'waiting',
                       'waitingFor': 'input needed', 'statusUpdatedAt': 1000}, f)
        sock_path = os.path.join(self.tmp, 'no-such.sock')
        with mock.patch.object(config, 'SOCK_PATH', sock_path), \
                mock.patch.object(live, '_claude_pids', return_value=None):
            out = jsonout.live_output()
        self.assertEqual(out['live'][ID1]['status'], 'waiting')
        self.assertEqual(out['live'][ID1]['status_label'], i18n.t('status.waiting'))
        self.assertEqual(out['live'][ID1]['waiting_for'], 'input needed')

    def test_idle_session_omits_waiting_for(self):
        with open(os.path.join(self.sessions_dir, '1.json'), 'w') as f:
            json.dump({'pid': os.getpid(), 'sessionId': ID1, 'status': 'idle',
                       'statusUpdatedAt': 1000}, f)
        sock_path = os.path.join(self.tmp, 'no-such.sock')
        with mock.patch.object(config, 'SOCK_PATH', sock_path), \
                mock.patch.object(live, '_claude_pids', return_value=None):
            out = jsonout.live_output()
        self.assertNotIn('waiting_for', out['live'][ID1])
        self.assertEqual(out['live'][ID1]['status'], 'idle')
        self.assertEqual(out['live'][ID1]['status_label'], i18n.t('status.idle'))


if __name__ == '__main__':
    unittest.main()

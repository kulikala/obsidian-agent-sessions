import json
import os
import shutil
import socket
import tempfile
import threading
import unittest
from unittest import mock

from agentsessions import config, jsonout, protocol, store

ID1 = '11111111-1111-1111-1111-111111111111'
ID2 = '22222222-2222-2222-2222-222222222222'


def write_jsonl(path, records):
    with open(path, 'w') as f:
        for r in records:
            # 詳細読み取りは行の生テキストを "type":"user" のように空白なしで
            # 照合するので、json.dumps は詰めた区切りで書く。
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
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestScanOutput(JsonoutTestBase):
    def setUp(self):
        super().setUp()
        write_jsonl(os.path.join(self.proj, ID1 + '.jsonl'), [
            {'type': 'system', 'cwd': '/Users/k/vault', 'content': 'x'},
            {'type': 'user', 'message': {'role': 'user', 'content': '最初の質問'}},
            {'type': 'custom-title', 'customTitle': 'RIM: 議事メモ作成', 'sessionId': ID1},
        ])
        write_jsonl(os.path.join(self.proj, ID2 + '.jsonl'), [
            {'type': 'user', 'cwd': '/Users/k/other', 'message': {'role': 'user', 'content': '名前なしの質問'}},
        ])
        store.save(store.Store(folded=['RIM']), path=self.store_path)

    def test_scan_output_shape(self):
        out = jsonout.scan_output()
        self.assertEqual(set(out.keys()), {'sessions', 'store'})
        by_id = {s['id']: s for s in out['sessions']}
        self.assertEqual(set(by_id), {ID1, ID2})

        s1 = by_id[ID1]
        self.assertEqual(s1['agent'], 'claude')
        self.assertEqual(s1['name'], 'RIM: 議事メモ作成')
        self.assertEqual(s1['group'], 'RIM')
        self.assertEqual(s1['label'], '議事メモ作成')
        self.assertEqual(s1['cwd'], '/Users/k/vault')
        self.assertEqual(s1['folder'], 'vault')
        self.assertFalse(s1['child'])
        self.assertTrue(s1['transcript'].endswith(ID1 + '.jsonl'))
        self.assertIsInstance(s1['last_activity'], float)

        s2 = by_id[ID2]
        self.assertIsNone(s2['name'])
        self.assertIsNone(s2['group'])
        self.assertEqual(s2['label'], '名前なしの質問')

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
             'message': {'role': 'user', 'content': 'こんにちは'}},
            {'type': 'assistant', 'timestamp': '2026-09-01T00:00:01Z',
             'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'はい'}]}},
        ])
        out = jsonout.detail_output(ID1)
        self.assertEqual(out['last_user'], 'こんにちは')
        self.assertEqual(out['last_assistant'], 'はい')
        self.assertEqual(out['tools'], [])

    def test_unknown_id_returns_empty_detail(self):
        out = jsonout.detail_output('does-not-exist')
        self.assertEqual(out, {'last_user': '', 'last_assistant': '', 'tools': []})


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


if __name__ == '__main__':
    unittest.main()

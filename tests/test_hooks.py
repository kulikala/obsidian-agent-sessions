import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from agentsessions import config, hooks, live


class TestRecordHook(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.events_log = os.path.join(self.tmpdir, 'events.log')
        self.patcher = mock.patch.object(config, 'EVENTS_LOG', self.events_log)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _lines(self):
        with open(self.events_log, encoding='utf-8') as f:
            return [json.loads(ln) for ln in f if ln.strip()]

    def test_appends_one_line_with_expected_fields(self):
        raw = json.dumps({
            'session_id': 'x', 'transcript_path': '/t', 'hook_event_name': 'Stop',
        }).encode('utf-8')
        hooks.record_hook(raw)
        lines = self._lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]['event'], 'Stop')
        self.assertEqual(lines[0]['session_id'], 'x')
        self.assertEqual(lines[0]['transcript_path'], '/t')
        self.assertIn('ts', lines[0])
        self.assertIsInstance(lines[0]['ts'], float)

    def test_multiple_calls_append_multiple_lines(self):
        raw = json.dumps({'session_id': 'a', 'hook_event_name': 'SessionEnd'}).encode('utf-8')
        hooks.record_hook(raw)
        hooks.record_hook(raw)
        self.assertEqual(len(self._lines()), 2)

    def test_invalid_json_is_ignored_without_raising(self):
        hooks.record_hook(b'not json')
        self.assertFalse(os.path.exists(self.events_log))

    def test_non_object_json_is_ignored(self):
        hooks.record_hook(b'[1, 2, 3]')
        self.assertFalse(os.path.exists(self.events_log))

    def test_undecodable_bytes_do_not_raise(self):
        hooks.record_hook(b'\xff\xfe\x00')
        self.assertFalse(os.path.exists(self.events_log))


class TestFormatStatusLine(unittest.TestCase):
    # session_id が無いときは live.live_sessions を呼ばない（rc は常に ○）ので、
    # このクラスの大半のテストは ps 等の実行環境に依存しない。

    def test_full_data(self):
        line = hooks.format_status_line({
            'model': {'display_name': 'Claude Sonnet 5'},
            'effort': {'level': 'high'},
            'context_window': {'used_percentage': 45},
        })
        self.assertEqual(line, 'Claude Sonnet 5 · high · ctx 45% · rc ○')

    def test_missing_model_falls_back_to_default_label(self):
        line = hooks.format_status_line({'context_window': {'used_percentage': 10}})
        self.assertEqual(line, 'デフォルト · デフォルト · ctx 10% · rc ○')

    def test_missing_context_window_uses_dash(self):
        line = hooks.format_status_line({'model': {'display_name': 'Claude Sonnet 5'}})
        self.assertEqual(line, 'Claude Sonnet 5 · デフォルト · ctx —% · rc ○')

    def test_missing_everything(self):
        self.assertEqual(hooks.format_status_line({}), 'デフォルト · デフォルト · ctx —% · rc ○')

    def test_percentage_is_rounded(self):
        line = hooks.format_status_line({'context_window': {'used_percentage': 45.6}})
        self.assertEqual(line, 'デフォルト · デフォルト · ctx 46% · rc ○')

    def test_effort_as_plain_string(self):
        line = hooks.format_status_line({'effort': 'high'})
        self.assertEqual(line, 'デフォルト · high · ctx —% · rc ○')

    def test_effort_dict_without_level_falls_back_to_default(self):
        line = hooks.format_status_line({'effort': {}})
        self.assertEqual(line, 'デフォルト · デフォルト · ctx —% · rc ○')

    def test_missing_effort_falls_back_to_default_label(self):
        line = hooks.format_status_line({'session_id': None})
        self.assertEqual(line, 'デフォルト · デフォルト · ctx —% · rc ○')

    def test_rc_marks_when_matching_session_has_bridge(self):
        with mock.patch.object(live, 'live_sessions',
                                return_value={'abc': live.Live(session_id='abc', pid=1, rc=True)}):
            line = hooks.format_status_line({'session_id': 'abc'})
        self.assertEqual(line, 'デフォルト · デフォルト · ctx —% · rc ●')

    def test_rc_empty_when_matching_session_has_no_bridge(self):
        with mock.patch.object(live, 'live_sessions',
                                return_value={'abc': live.Live(session_id='abc', pid=1, rc=False)}):
            line = hooks.format_status_line({'session_id': 'abc'})
        self.assertEqual(line, 'デフォルト · デフォルト · ctx —% · rc ○')

    def test_rc_empty_when_session_id_does_not_match_any_live_session(self):
        with mock.patch.object(live, 'live_sessions',
                                return_value={'other': live.Live(session_id='other', pid=1, rc=True)}):
            line = hooks.format_status_line({'session_id': 'abc'})
        self.assertEqual(line, 'デフォルト · デフォルト · ctx —% · rc ○')

    def test_live_sessions_not_consulted_without_session_id(self):
        with mock.patch.object(live, 'live_sessions') as m:
            hooks.format_status_line({})
        m.assert_not_called()


class TestRecordStatus(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.status_dir = os.path.join(self.tmpdir, 'status')
        self.patcher = mock.patch.object(config, 'STATUS_DIR', self.status_dir)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_writes_raw_payload_as_is_and_returns_line(self):
        raw = json.dumps({
            'session_id': 'abc',
            'model': {'display_name': 'Claude Sonnet 5'},
            'effort': {'level': 'high'},
            'context_window': {'used_percentage': 50},
        }, ensure_ascii=False).encode('utf-8')
        with mock.patch.object(live, 'live_sessions',
                                return_value={'abc': live.Live(session_id='abc', pid=1, rc=True)}):
            line = hooks.record_status(raw)
        self.assertEqual(line, 'Claude Sonnet 5 · high · ctx 50% · rc ●')
        path = os.path.join(self.status_dir, 'abc.json')
        with open(path, 'rb') as f:
            self.assertEqual(f.read(), raw)

    def test_missing_session_id_returns_line_without_writing_file(self):
        raw = json.dumps({'model': {'display_name': 'X'}}).encode('utf-8')
        line = hooks.record_status(raw)
        self.assertEqual(line, 'X · デフォルト · ctx —% · rc ○')
        self.assertFalse(os.path.isdir(self.status_dir))

    def test_invalid_json_returns_default_line(self):
        line = hooks.record_status(b'not json')
        self.assertEqual(line, 'デフォルト · デフォルト · ctx —% · rc ○')


if __name__ == '__main__':
    unittest.main()

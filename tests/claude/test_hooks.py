import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from agentsessions import config, hooks, i18n, live


def setUpModule():
    # Even when run inside a session that was itself launched from the plugin,
    # the submit-key symbol must not leak into these tests.
    patcher = mock.patch.dict(os.environ)
    patcher.start()
    os.environ.pop('AGENT_SESSIONS_ID', None)
    unittest.addModuleCleanup(patcher.stop)


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


class TestCompactedMark(unittest.TestCase):
    # A marker for a session that has just compacted and hasn't sent its next
    # prompt yet. `record_hook` reflects it into COMPACTED_DIR via `_update_compacted`.

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.events_log = os.path.join(self.tmpdir, 'events.log')
        self.compacted_dir = os.path.join(self.tmpdir, 'compacted')
        self.patchers = [
            mock.patch.object(config, 'EVENTS_LOG', self.events_log),
            mock.patch.object(config, 'COMPACTED_DIR', self.compacted_dir),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _marker_path(self, session_id):
        return os.path.join(self.compacted_dir, '%s.json' % session_id)

    def test_session_start_with_source_compact_marks_the_session(self):
        raw = json.dumps({
            'session_id': 'a', 'hook_event_name': 'SessionStart', 'source': 'compact',
        }).encode('utf-8')
        hooks.record_hook(raw)
        self.assertTrue(os.path.exists(self._marker_path('a')))
        with open(self._marker_path('a'), encoding='utf-8') as f:
            marker = json.load(f)
        self.assertIn('compactedAt', marker)

    def test_session_start_with_other_source_does_not_mark(self):
        for source in ('startup', 'resume', 'clear', 'fork'):
            raw = json.dumps({
                'session_id': 'a', 'hook_event_name': 'SessionStart', 'source': source,
            }).encode('utf-8')
            hooks.record_hook(raw)
            self.assertFalse(os.path.exists(self._marker_path('a')), 'source=%s' % source)

    def test_user_prompt_submit_clears_the_mark(self):
        os.makedirs(self.compacted_dir)
        with open(self._marker_path('a'), 'w', encoding='utf-8') as f:
            json.dump({'compactedAt': 1.0}, f)
        raw = json.dumps({'session_id': 'a', 'hook_event_name': 'UserPromptSubmit'}).encode('utf-8')
        hooks.record_hook(raw)
        self.assertFalse(os.path.exists(self._marker_path('a')))

    def test_session_end_clears_the_mark(self):
        os.makedirs(self.compacted_dir)
        with open(self._marker_path('a'), 'w', encoding='utf-8') as f:
            json.dump({'compactedAt': 1.0}, f)
        raw = json.dumps({'session_id': 'a', 'hook_event_name': 'SessionEnd'}).encode('utf-8')
        hooks.record_hook(raw)
        self.assertFalse(os.path.exists(self._marker_path('a')))

    def test_clearing_when_no_mark_exists_does_not_raise(self):
        raw = json.dumps({'session_id': 'a', 'hook_event_name': 'UserPromptSubmit'}).encode('utf-8')
        hooks.record_hook(raw)  # passes as long as no exception is raised

    def test_unrelated_events_leave_existing_mark_untouched(self):
        os.makedirs(self.compacted_dir)
        with open(self._marker_path('a'), 'w', encoding='utf-8') as f:
            json.dump({'compactedAt': 1.0}, f)
        raw = json.dumps({'session_id': 'a', 'hook_event_name': 'Stop'}).encode('utf-8')
        hooks.record_hook(raw)
        self.assertTrue(os.path.exists(self._marker_path('a')))

    def test_marks_are_per_session(self):
        raw_a = json.dumps({
            'session_id': 'a', 'hook_event_name': 'SessionStart', 'source': 'compact',
        }).encode('utf-8')
        raw_b = json.dumps({
            'session_id': 'b', 'hook_event_name': 'SessionStart', 'source': 'compact',
        }).encode('utf-8')
        hooks.record_hook(raw_a)
        hooks.record_hook(raw_b)
        clear_a = json.dumps({'session_id': 'a', 'hook_event_name': 'UserPromptSubmit'}).encode('utf-8')
        hooks.record_hook(clear_a)
        self.assertFalse(os.path.exists(self._marker_path('a')))
        self.assertTrue(os.path.exists(self._marker_path('b')))


class TestFormatStatusLine(unittest.TestCase):
    # When there's no session_id, live.live_sessions isn't called (rc is always ○),
    # so most of this class's tests don't depend on the execution environment (ps, etc.).

    def test_full_data(self):
        line = hooks.format_status_line({
            'model': {'display_name': 'Claude Sonnet 5'},
            'effort': {'level': 'high'},
            'context_window': {'used_percentage': 45},
        })
        self.assertEqual(line, 'Claude Sonnet 5 · high · ctx 45% · rc ○')

    def test_missing_model_falls_back_to_default_label(self):
        line = hooks.format_status_line({'context_window': {'used_percentage': 10}})
        self.assertEqual(line, f'{i18n.t("default")} · {i18n.t("default")} · ctx 10% · rc ○')

    def test_missing_context_window_uses_dash(self):
        line = hooks.format_status_line({'model': {'display_name': 'Claude Sonnet 5'}})
        self.assertEqual(line, f'Claude Sonnet 5 · {i18n.t("default")} · ctx —% · rc ○')

    def test_missing_everything(self):
        self.assertEqual(hooks.format_status_line({}), f'{i18n.t("default")} · {i18n.t("default")} · ctx —% · rc ○')

    def test_percentage_is_rounded(self):
        line = hooks.format_status_line({'context_window': {'used_percentage': 45.6}})
        self.assertEqual(line, f'{i18n.t("default")} · {i18n.t("default")} · ctx 46% · rc ○')

    def test_effort_as_plain_string(self):
        line = hooks.format_status_line({'effort': 'high'})
        self.assertEqual(line, f'{i18n.t("default")} · high · ctx —% · rc ○')

    def test_effort_dict_without_level_falls_back_to_default(self):
        line = hooks.format_status_line({'effort': {}})
        self.assertEqual(line, f'{i18n.t("default")} · {i18n.t("default")} · ctx —% · rc ○')

    def test_missing_effort_falls_back_to_default_label(self):
        line = hooks.format_status_line({'session_id': None})
        self.assertEqual(line, f'{i18n.t("default")} · {i18n.t("default")} · ctx —% · rc ○')

    def test_rc_marks_when_matching_session_has_bridge(self):
        with mock.patch.object(live, 'live_sessions',
                                return_value={'abc': live.Live(session_id='abc', pid=1, rc=True)}):
            line = hooks.format_status_line({'session_id': 'abc'})
        self.assertEqual(line, f'{i18n.t("default")} · {i18n.t("default")} · ctx —% · rc ●')

    def test_rc_empty_when_matching_session_has_no_bridge(self):
        with mock.patch.object(live, 'live_sessions',
                                return_value={'abc': live.Live(session_id='abc', pid=1, rc=False)}):
            line = hooks.format_status_line({'session_id': 'abc'})
        self.assertEqual(line, f'{i18n.t("default")} · {i18n.t("default")} · ctx —% · rc ○')

    def test_rc_empty_when_session_id_does_not_match_any_live_session(self):
        with mock.patch.object(live, 'live_sessions',
                                return_value={'other': live.Live(session_id='other', pid=1, rc=True)}):
            line = hooks.format_status_line({'session_id': 'abc'})
        self.assertEqual(line, f'{i18n.t("default")} · {i18n.t("default")} · ctx —% · rc ○')

    def test_live_sessions_not_consulted_without_session_id(self):
        with mock.patch.object(live, 'live_sessions') as m:
            hooks.format_status_line({})
        m.assert_not_called()


class TestSubmitSymbol(unittest.TestCase):
    # Submit-key symbol: only appended (` · <symbol>`) at the end when
    # `AGENT_SESSIONS_ID` is set and `config.UI_STATE_PATH` is readable.

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.ui_state_path = os.path.join(self.tmpdir, 'ui.json')
        self.patcher = mock.patch.object(config, 'UI_STATE_PATH', self.ui_state_path)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_ui_state(self, content):
        with open(self.ui_state_path, 'w', encoding='utf-8') as f:
            f.write(content)

    def test_appends_symbol_when_env_set_and_ui_state_readable(self):
        self._write_ui_state(json.dumps({'submitKey': 'cmd+enter', 'submitSymbol': '⌘⏎'}))
        with mock.patch.dict(os.environ, {'AGENT_SESSIONS_ID': 'x'}):
            line = hooks.format_status_line({})
        self.assertEqual(line, f'⌘⏎ · {i18n.t("default")} · {i18n.t("default")} · ctx —% · rc ○')

    def test_no_symbol_without_env_var_even_if_ui_state_exists(self):
        self._write_ui_state(json.dumps({'submitKey': 'cmd+enter', 'submitSymbol': '⌘⏎'}))
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('AGENT_SESSIONS_ID', None)
            line = hooks.format_status_line({})
        self.assertEqual(line, f'{i18n.t("default")} · {i18n.t("default")} · ctx —% · rc ○')

    def test_no_symbol_when_ui_state_missing(self):
        with mock.patch.dict(os.environ, {'AGENT_SESSIONS_ID': 'x'}):
            line = hooks.format_status_line({})
        self.assertEqual(line, f'{i18n.t("default")} · {i18n.t("default")} · ctx —% · rc ○')

    def test_no_symbol_when_ui_state_is_broken_json(self):
        self._write_ui_state('not json')
        with mock.patch.dict(os.environ, {'AGENT_SESSIONS_ID': 'x'}):
            line = hooks.format_status_line({})
        self.assertEqual(line, f'{i18n.t("default")} · {i18n.t("default")} · ctx —% · rc ○')

    def test_no_symbol_when_ui_state_has_no_submit_symbol(self):
        self._write_ui_state(json.dumps({'submitKey': 'enter'}))
        with mock.patch.dict(os.environ, {'AGENT_SESSIONS_ID': 'x'}):
            line = hooks.format_status_line({})
        self.assertEqual(line, f'{i18n.t("default")} · {i18n.t("default")} · ctx —% · rc ○')


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
        self.assertEqual(line, f'X · {i18n.t("default")} · ctx —% · rc ○')
        self.assertFalse(os.path.isdir(self.status_dir))

    def test_invalid_json_returns_default_line(self):
        line = hooks.record_status(b'not json')
        self.assertEqual(line, f'{i18n.t("default")} · {i18n.t("default")} · ctx —% · rc ○')


if __name__ == '__main__':
    unittest.main()

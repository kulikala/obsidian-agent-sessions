"""The commands the agent-sessions skill calls besides `new`, `stats`, `sessions` and `show`: `sessions`'
categories and status filter, `resume`, `analyze` and `suggest-name` (with the plugin's `rename`)."""
import codecs
import io
import json
import os
import re
import shutil
import socket
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from agentsessions import config
from agentsessions.agents import launch
from agentsessions.cli import analyze as cmd_analyze
from agentsessions.cli import json_output, listing
from agentsessions.cli import resume as cmd_resume
from agentsessions.cli import sessions as cmd_sessions
from agentsessions.cli import suggest_name as cmd_suggest
from agentsessions.daemon import protocol
from agentsessions.sessions import naming, store
from tests.cli.test_new import FakePlugin as NewFakePlugin, NewTestCase
from tests.cli.test_sessions_show import NOW, ListingTestCase, session

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SCAN = {
    'sessions': [
        session('aaaa1111-0000', name='Web: Login bug', activity=NOW - 60),
        session('bbbb2222-0000', agent='codex', name='Web: Docs site', cwd='/w/docs', activity=NOW - 3600),
        session('cccc3333-0000', agent='opencode', name='Infra: Backups', activity=NOW - 7200),
        session('dddd4444-0000', name=None, activity=NOW - 9000),
        session('eeee5555-0000', name='Web: Old', activity=NOW - 86400 * 9),
        session('ffff6666-0000', name='Web: Sub', child=True),
    ],
    'store': {'archived': [{'id': 'eeee5555-0000'}], 'sessions': {}, 'folded': [], 'pendingRenames': {}},
}
LIVE = {
    'live': {'aaaa1111-0000': {'agent': 'claude', 'status': 'busy'}},
    'daemon': {'running': True, 'sessions': []},
}


class CategoriesTestCase(ListingTestCase):
    def setUp(self):
        super().setUp()
        for p in (mock.patch.object(json_output, 'scan_output', lambda: SCAN),
                  mock.patch.object(json_output, 'live_output', lambda: LIVE)):
            p.start()
            self.addCleanup(p.stop)

    def run_cmd(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = cmd_sessions.main(list(args))
        return rc, out.getvalue()


class TestSessionsByCategoryAndStatus(CategoriesTestCase):
    def test_rows_carry_category_archived_and_child(self):
        rows = {r['id']: r for r in listing.collect(include_children=True, include_archived=True)}
        self.assertEqual(rows['aaaa1111-0000']['category'], 'Web')
        self.assertIsNone(rows['dddd4444-0000']['category'])
        self.assertTrue(rows['eeee5555-0000']['archived'])
        self.assertTrue(rows['ffff6666-0000']['child'])
        self.assertFalse(rows['aaaa1111-0000']['archived'] or rows['aaaa1111-0000']['child'])

    def test_category_filter_ignores_case_and_empty_means_none(self):
        _, out = self.run_cmd('--category', 'web', '--json')
        self.assertEqual([s['id'] for s in json.loads(out)['sessions']], ['aaaa1111-0000', 'bbbb2222-0000'])
        _, out = self.run_cmd('--category', '', '--json')
        self.assertEqual([s['id'] for s in json.loads(out)['sessions']], ['dddd4444-0000'])

    def test_status_filter_keeps_ended_sessions_and_repeats(self):
        _, out = self.run_cmd('--status', 'ended', '--json')
        self.assertEqual({s['status'] for s in json.loads(out)['sessions']}, {'ended'})
        self.assertEqual(len(json.loads(out)['sessions']), 3)
        _, out = self.run_cmd('--status', 'ended', '--status', 'running', '--json')
        self.assertEqual(len(json.loads(out)['sessions']), 4)

    def test_categories_are_counted_most_used_first(self):
        _, out = self.run_cmd('--categories', '--json')
        data = json.loads(out)
        self.assertEqual(data['categories'], [
            {'category': 'Web', 'sessions': 2, 'ended': 1},
            {'category': 'Infra', 'sessions': 1, 'ended': 1},
        ])
        self.assertEqual(data['uncategorized'], 1)
        _, text = self.run_cmd('--categories', '--all')
        self.assertIn('Web  (4 sessions, 3 ended)', text)

    def test_all_marks_archived_and_sub_agent_rows(self):
        _, text = self.run_cmd('--all')
        self.assertIn('Web: Old  (archived)', text)
        self.assertIn('Web: Sub  (sub-agent)', text)

    def test_category_and_categories_exclude_each_other(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.run_cmd('--category', 'Web', '--categories')


class TestResumeArgv(unittest.TestCase):
    def test_each_agent_resumes_as_the_plugin_does(self):
        self.assertEqual(launch.build_resume_argv('claude', '/b/claude', 'S'), ['/b/claude', '--resume', 'S'])
        self.assertEqual(launch.build_resume_argv('claude', '/b/claude', 'S', 'Web: Login'),
                         ['/b/claude', '--resume', 'S', '--remote-control=Web: Login'])
        self.assertEqual(launch.build_resume_argv('codex', '/b/codex', 'T', codex_no_daemon=True),
                         ['/b/codex', '--no-daemon', 'resume', 'T'])
        self.assertEqual(launch.build_resume_argv('opencode', '/b/oc', 'ses_1'), ['/b/oc', '--session', 'ses_1'])
        self.assertEqual(launch.build_resume_argv('opencode', '/b/oc', 'ses_1', ollama_bin='/b/ollama', ollama_model='m'),
                         ['/b/ollama', 'launch', 'opencode', '--model', 'm', '-y', '--', '--session', 'ses_1'])

    def test_a_message_goes_last(self):
        self.assertEqual(launch.build_resume_argv('claude', 'c', 'S', prompt='-go'), ['c', '--resume', 'S', '--', '-go'])
        self.assertEqual(launch.build_resume_argv('codex', 'x', 'T', prompt='-go'), ['x', 'resume', 'T', '--', '-go'])
        self.assertEqual(launch.build_resume_argv('opencode', 'o', 'ses', prompt='go'), ['o', '--session', 'ses', '--prompt=go'])

    def test_remote_control_on_resume(self):
        rc = launch.resume_connects_remote_control
        self.assertTrue(rc('{"remoteControlAtStartup": true}', None))
        self.assertFalse(rc('{"remoteControlAtStartup": "yes"}', ''))
        self.assertFalse(rc('not json', '{"type":"user"}'))
        self.assertTrue(rc(None, '{"type": "bridge-session","url":"x"}\n'))


def row(sid, agent='claude', status='ended', name='Web: Login bug', named=True, cwd=None, self_=False):
    return {'id': sid, 'agent': agent, 'name': name, 'named': named, 'category': None, 'folder': 'w',
            'cwd': cwd, 'status': status, 'last_activity': NOW, 'in_daemon': False, 'self': self_,
            'archived': False, 'child': False}


class TestResume(NewTestCase):
    def setUp(self):
        super().setUp()
        self.claude_dir = os.path.join(self.tmp, 'claude-config')
        os.makedirs(self.claude_dir)
        self.rows = []
        for p in (mock.patch.object(listing, 'collect', lambda *a, **k: self.rows),
                  mock.patch.object(cmd_resume.new, 'SETTLE_SECONDS', 0.1)):
            p.start()
            self.addCleanup(p.stop)

    def run_resume(self, *args):
        out, err = io.StringIO(), io.StringIO()
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': self.tmp, 'CLAUDE_CONFIG_DIR': self.claude_dir}
        with redirect_stdout(out), redirect_stderr(err), mock.patch.dict(os.environ, env, clear=False):
            for k in [k for k in os.environ if k.startswith(('CLAUDECODE', 'CLAUDE_CODE', 'CODEX_', 'OPENCODE_'))
                      or k == 'AGENT_SESSIONS_ID']:
                del os.environ[k]
            rc = cmd_resume.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def argv(self):
        self.wait_recorded()
        return self.recorded('argv').splitlines()

    def test_an_ended_claude_session_resumes_under_its_own_id(self):
        self.rows = [row('aaaa1111-2222', cwd=self.work)]
        rc, out, _ = self.run_resume('aaaa1111', '--json')
        self.assertEqual(rc, 0)
        data = json.loads(out)
        self.assertEqual((data['id'], data['daemon_id'], data['confirmed']), ('aaaa1111-2222',) * 2 + (True,))
        self.assertEqual(self.argv(), ['--resume', 'aaaa1111-2222'])
        self.assertIn('aaaa1111-2222', self.daemon.sessions)

    def test_a_remote_control_session_resumes_into_remote_control_by_its_name(self):
        self.rows = [row('aaaa1111-2222', cwd=self.work)]
        os.makedirs(os.path.join(self.projects, 'proj'))
        with open(os.path.join(self.projects, 'proj', 'aaaa1111-2222.jsonl'), 'w') as f:
            f.write('{"type":"bridge-session","sessionId":"aaaa1111-2222"}\n')
        self.assertEqual(self.run_resume('aaaa1111-2222')[0], 0)
        self.assertEqual(self.argv(), ['--resume', 'aaaa1111-2222', '--remote-control=Web: Login bug'])

    def test_codex_gets_a_new_daemon_id_linked_without_losing_the_entry(self):
        self.rows = [row('thread-1', agent='codex', cwd=self.work)]
        store.update(lambda st: st.sessions.__setitem__('thread-1', {'agent': 'codex', 'cwd': self.work,
                                                                      'daemon': 'old-daemon', 'extra': 1}),
                     self.store_path)
        rc, out, _ = self.run_resume('thread-1', '--prompt', 'carry on', '--json')
        self.assertEqual(rc, 0)
        data = json.loads(out)
        self.assertNotEqual(data['daemon_id'], 'thread-1')
        entry = store.load(path=self.store_path).sessions['thread-1']
        self.assertEqual(entry, {'agent': 'codex', 'cwd': self.work, 'daemon': data['daemon_id'], 'extra': 1})
        self.assertEqual(self.argv(), ['resume', 'thread-1', '--', 'carry on'])

    def test_only_an_ended_session_and_never_the_callers_own(self):
        self.rows = [row('aaaa1111-2222', status='idle', cwd=self.work),
                     row('bbbb1111-2222', cwd=self.work, self_=True)]
        rc, _, err = self.run_resume('aaaa1111-2222')
        self.assertEqual(rc, 2)
        self.assertIn('not ended (idle)', err)
        rc, _, err = self.run_resume('bbbb1111-2222')
        self.assertEqual(rc, 2)
        self.assertIn('calling session itself', err)
        self.assertFalse(os.path.exists(self.rec + '.argv'))

    def test_the_plugin_is_asked_to_open_a_tab(self):
        self.rows = [row('aaaa1111-2222', cwd=self.work)]
        plugin = NewFakePlugin(self.plugin_sock, {'ok': True})
        self.addCleanup(plugin.close)
        rc, out, _ = self.run_resume('aaaa1111-2222', '--json')
        self.assertEqual(rc, 0)
        self.assertTrue(json.loads(out)['opened'])
        req = plugin.wait()
        self.assertEqual((req['op'], req['session'], req['agent'], req['cwd']),
                         ('open', 'aaaa1111-2222', 'claude', self.work))
        self.assertNotIn('daemon', req)
        self.assertNotIn('name', req)

    def test_without_a_plugin_the_session_still_resumes_and_reports_no_tab(self):
        self.rows = [row('aaaa1111-2222', cwd=self.work)]
        rc, out, _ = self.run_resume('aaaa1111-2222', '--json')
        self.assertEqual(rc, 0)
        result = json.loads(out)
        self.assertFalse(result['opened'])
        self.assertTrue(any('Obsidian did not answer' in w for w in result['warnings']))

    def test_an_unknown_session_or_a_missing_folder_is_exit_2(self):
        self.rows = [row('aaaa1111-2222', cwd=os.path.join(self.tmp, 'gone'))]
        self.assertEqual(self.run_resume('zzzz')[0], 2)
        rc, _, err = self.run_resume('aaaa1111-2222')
        self.assertEqual(rc, 2)
        self.assertIn('no longer exists', err)

    def test_a_session_still_running_in_the_daemon_is_refused(self):
        self.rows = [row('aaaa1111-2222', cwd=self.work)]
        self.assertEqual(self.run_resume('aaaa1111-2222')[0], 0)
        rc, _, err = self.run_resume('aaaa1111-2222')
        self.assertEqual(rc, 2)
        self.assertIn('already running', err)


class TestAnalyze(ListingTestCase):
    DIGEST = {'agent': 'claude', 'context': {}, 'sessions': [{'id': 'ffff6666-0000', 'preamble': 900, 'tasks': 5}],
              'tasks': [{'id': 't-%d' % i, 'ts': i, 'turn_count': 2,
                         'turns': [{'prompt': 'p', 'tools': {'Bash': 1}}, {'prompt': 'q'}]} for i in range(5)],
              'hints': [{'id': 'h1', 'task': 't-0'}, {'id': 'h2', 'task': 't-4'}, {'id': 'h3', 'task': None}]}
    BLOCK = {'range': {'start': NOW - 3600, 'end': NOW},
             'totals': {'calls': 7, 'w': 1234, 'usd': 0.5, 'cache_hit': 0.9, 'cache_read': 10, 'cache_write': 1},
             'panes': [{'digest': DIGEST}]}

    def run_cmd(self, *args, block=BLOCK, own=None):
        out, err = io.StringIO(), io.StringIO()
        env = {'CLAUDE_CODE_SESSION_ID': own} if own else {}
        with redirect_stdout(out), redirect_stderr(err), mock.patch.dict(os.environ, env), \
                mock.patch.object(json_output, 'session_efficiency_output', return_value=block) as eff:
            rc = cmd_analyze.main(list(args))
        return rc, out.getvalue(), err.getvalue(), eff

    def test_latest_tasks_keep_their_hints(self):
        d = cmd_analyze.latest_tasks(self.DIGEST, 2)
        self.assertEqual([t['id'] for t in d['tasks']], ['t-3', 't-4'])
        self.assertEqual([h['id'] for h in d['hints']], ['h2', 'h3'])
        self.assertEqual((d['shown'], d['total']), (2, 5))

    def test_checks_with_nothing_to_judge_are_left_out(self):
        na = cmd_analyze.not_applicable
        everything = {c for c, _ in cmd_analyze.CHECKS}
        self.assertEqual(na({'tasks': []}, {}), everything)
        self.assertEqual(na(self.DIGEST, self.BLOCK['totals']), {'repeatedLookups'})
        bare = {'sessions': [{'id': 's', 'tasks': 1}], 'tasks': [{'id': 't', 'turn_count': 1, 'turns': [{}]}]}
        self.assertEqual(na(bare, {}), everything - {'found', 'longContext'})

    def test_this_session_by_default_with_the_checks_and_the_data(self):
        rc, out, _, eff = self.run_cmd('--tasks', '2', own='ffff6666-0000')
        self.assertEqual(rc, 0)
        eff.assert_called_once_with('claude', 'ffff6666-0000')
        for check_id, _ in cmd_analyze.CHECKS:
            self.assertEqual('- %s: ' % check_id in out, check_id != 'repeatedLookups', check_id)
        self.assertIn('latest 2 of the session\'s 5 tasks', out)
        data = json.loads(out.split('<<<DATA\n')[1].split('\nDATA>>>')[0])
        self.assertEqual([t['id'] for t in data['tasks']], ['t-3', 't-4'])
        self.assertIn('1234 weighted tokens, about $0.50, cache hit 90%', out)

    def test_another_session_and_the_errors(self):
        rc, _, _, eff = self.run_cmd('Docs')
        self.assertEqual(rc, 0)
        eff.assert_called_once_with('codex', 'bbbb2222-0000')
        self.assertEqual(self.run_cmd()[0], 2)
        self.assertEqual(self.run_cmd('zzzz-nothing')[0], 2)
        rc, _, err, _ = self.run_cmd('Docs', block={'missing': True})
        self.assertEqual(rc, 2)
        self.assertIn('nothing to analyse', err)


class TestNamingRules(unittest.TestCase):
    def test_checks(self):
        self.assertEqual(naming.check('Web', 'Login bug', ['Web']), [])
        self.assertEqual(naming.check('ｗｅｂ', 'Login bug', ['Web']), [])
        self.assertEqual(naming.check('', 'Login bug', []), ['noCategory'])
        self.assertEqual(naming.check('Web', '', []), ['noName'])
        self.assertIn('nameTooLong', naming.check('Web', 'one two three four five six', []))
        self.assertIn('nameTooLong', naming.check('ウェブ', 'あ' * 21, []))
        self.assertEqual(naming.check('ウェブ', 'あ' * 20, []), [])
        self.assertIn('nameIsSentence', naming.check('Web', 'ログインを直します', []))
        self.assertIn('nameRepeatsCategory', naming.check('Web', 'Web login', []))
        self.assertIn('nameHasSeparator', naming.check('Web', 'a: b', []))
        self.assertEqual(naming.check('Debug', 'Login', []), ['categoryIsTaskType'])
        self.assertEqual(naming.check('Debug', 'Login', ['debug']), [])
        self.assertIn('categoryTooLong', naming.check('one two three four', 'Login', []))

    def test_parse_and_compose(self):
        self.assertEqual(naming.parse('  Web:  Login   bug '), {'category': 'Web', 'name': 'Login bug'})
        self.assertEqual(naming.parse('Login bug'), {'category': '', 'name': 'Login bug'})
        self.assertEqual(naming.compose('web', 'Login bug', ['Web']), 'Web: Login bug')
        self.assertEqual(naming.compose('', 'Login bug', ['Web']), 'Login bug')

    def test_profiles(self):
        rows = [row('a', name='Web: A'), row('b', name='Web: B'), row('c', name='Ops: C'),
                row('d', name='first prompt', named=False), dict(row('e', name='Web: Sub'), child=True)]
        rows[1]['last_activity'] = NOW + 1
        self.assertEqual(naming.category_profiles(rows), [
            {'category': 'Web', 'sessions': 2, 'examples': ['B', 'A']},
            {'category': 'Ops', 'sessions': 1, 'examples': ['C']},
        ])


def _ts(path):
    with open(os.path.join(ROOT, 'plugin', 'src', 'sessions', path), encoding='utf-8') as f:
        return f.read()


def _js_regexp_source(src, const):
    """The pattern a `new RegExp("..." + "...")` constant builds, with the string escapes undone."""
    body = re.search(r'const %s = new RegExp\(\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)' % const, src).group(1)
    literal = ''.join(re.findall(r'"((?:[^"\\]|\\.)*)"', body))
    return codecs.decode(codecs.decode(literal, 'unicode_escape'), 'unicode_escape')


class TestTheRulesMatchThePlugin(unittest.TestCase):
    def test_limits_and_patterns_are_organize_ts(self):
        src = _ts('organize.ts')
        for const, ours in (('NAME_LIMIT', naming.NAME_LIMIT), ('CATEGORY_LIMIT', naming.CATEGORY_LIMIT)):
            m = re.search(r'export const %s = \{ cjkChars: (\d+), words: (\d+), latinChars: (\d+) \}' % const, src)
            self.assertEqual(ours, {'cjkChars': int(m.group(1)), 'words': int(m.group(2)), 'latinChars': int(m.group(3))})
        self.assertEqual(naming.TASK_TYPE_CATEGORY.pattern, _js_regexp_source(src, 'TASK_TYPE_CATEGORY'))
        self.assertEqual(naming.SENTENCE_ENDING.pattern, _js_regexp_source(src, 'SENTENCE_ENDING'))
        self.assertEqual(naming.CJK.pattern, re.search(r'const CJK = /(.*?)/;', src).group(1))

    def test_checks_are_efficiency_checks_ts(self):
        src = _ts('efficiency-checks.ts')
        block = src.split('export const CHECKS')[1].split('];')[0]
        theirs = [(i, ' '.join(f.split())) for i, f in
                  re.findall(r'id: "(\w+)",.*?focus:\s*"((?:[^"\\]|\\.)*)"', block, re.S)]
        self.assertEqual(list(cmd_analyze.CHECKS), theirs)


class FakePlugin:
    """A `plugin.sock` that answers `rename` with `reply` and keeps the requests."""

    def __init__(self, path, reply):
        self.requests = []
        self.reply = reply
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(path)
        self.sock.listen(1)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        conn, _ = self.sock.accept()
        decoder = protocol.Decoder()
        while True:
            frames = decoder.feed(conn.recv(65536))
            if frames:
                req = protocol.decode_json(frames[0][1])
                self.requests.append(req)
                conn.sendall(protocol.encode_json(dict(self.reply, seq=req.get('seq'))))
                conn.close()
                return

    def close(self):
        self.sock.close()


class TestSuggestName(ListingTestCase):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.mkdtemp(prefix='agsd-name-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.sock_path = os.path.join(self.tmp, 'plugin.sock')
        self.store_path = os.path.join(self.tmp, 'sessions.json')
        for p in (mock.patch.object(json_output, 'scan_output', lambda: SCAN),
                  mock.patch.object(json_output, 'live_output', lambda: LIVE),
                  mock.patch.object(json_output, 'detail_output', return_value={
                      'last_user': 'fix the backups', 'recent_user': ['look at backups', 'fix the backups'],
                      'last_assistant': 'Fixed.'}),
                  mock.patch.object(config, 'STORE_PATH', self.store_path),
                  mock.patch.dict(os.environ, {cmd_suggest.SOCK_ENV: self.sock_path})):
            p.start()
            self.addCleanup(p.stop)

    def run_cmd(self, *args, own='aaaa1111-0000'):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), \
                mock.patch.dict(os.environ, {'CLAUDE_CODE_SESSION_ID': own} if own else {}):
            rc = cmd_suggest.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def test_material_for_this_session_and_another(self):
        rc, out, _ = self.run_cmd('--json')
        self.assertEqual(rc, 0)
        m = json.loads(out)
        self.assertEqual((m['id'], m['currentName']), ('aaaa1111-0000', 'Web: Login bug'))
        self.assertEqual(m['categories'][0]['category'], 'Web')
        self.assertNotIn('conversation', m)
        rc, out, _ = self.run_cmd('cccc3333')
        self.assertIn('Recent prompt: fix the backups', out)
        self.assertIn('Last reply: Fixed.', out)
        self.assertIn('- Web (3): Login bug / Docs site / Old', out)

    def test_check(self):
        rc, out, _ = self.run_cmd('--check', 'web: Sign-in redirect')
        self.assertEqual((rc, out), (0, 'Meets the rules: Web: Sign-in redirect\n'))
        rc, out, _ = self.run_cmd('--check', 'Research: Login', '--json')
        self.assertEqual(rc, 1)
        self.assertEqual([i['id'] for i in json.loads(out)['issues']], ['categoryIsTaskType'])

    def test_apply_through_the_plugin_queued_for_the_callers_turn(self):
        plugin = FakePlugin(self.sock_path, {'ok': True, 'queued': True})
        self.addCleanup(plugin.close)
        rc, out, _ = self.run_cmd('--apply', 'Web: Sign-in redirect')
        plugin.thread.join(5)
        self.assertEqual(rc, 0)
        self.assertEqual(plugin.requests[0]['op'], 'rename')
        self.assertEqual((plugin.requests[0]['session'], plugin.requests[0]['name']),
                         ('aaaa1111-0000', 'Web: Sign-in redirect'))
        self.assertIn('once its current turn ends', out)
        self.assertTrue(out.startswith('Renaming to Web: Sign-in redirect'))

    def test_apply_reports_acceptance_not_a_rename(self):
        plugin = FakePlugin(self.sock_path, {'ok': True})
        self.addCleanup(plugin.close)
        rc, out, _ = self.run_cmd('--apply', 'Web: Sign-in redirect', '--json')
        plugin.thread.join(5)
        data = json.loads(out)
        self.assertEqual((rc, data['accepted'], data['renamed'], data['queued']), (0, True, False, False))

    def test_an_older_plugin_is_named_as_the_reason(self):
        plugin = FakePlugin(self.sock_path, {'ok': False, 'error': 'unknown-op'})
        self.addCleanup(plugin.close)
        rc, out, _ = self.run_cmd('--apply', 'Web: Sign-in redirect')
        self.assertEqual(rc, 1)
        self.assertIn('plugin is older than this program', out)
        self.assertIn('/rename Web: Sign-in redirect', out)

    def test_apply_refuses_a_name_that_breaks_a_rule_and_skips_an_unchanged_one(self):
        rc, out, _ = self.run_cmd('--apply', 'Debug: Fixing it?')
        self.assertEqual(rc, 1)
        self.assertIn('Breaks the rules', out)
        rc, out, _ = self.run_cmd('--apply', 'Web: Login bug')
        self.assertEqual((rc, out), (0, 'Unchanged: the session already has this name\n'))

    def test_without_obsidian_claude_gets_the_rename_to_type(self):
        rc, out, _ = self.run_cmd('--apply', 'Web: Sign-in redirect', '--json')
        self.assertEqual(rc, 1)
        data = json.loads(out)
        self.assertFalse(data['renamed'] or data['accepted'])
        self.assertEqual(data['command'], '/rename Web: Sign-in redirect')

    def test_without_obsidian_opencode_is_named_in_sessions_json(self):
        rc, _, _ = self.run_cmd('cccc3333', '--apply', 'Infra: Nightly backups')
        self.assertEqual(rc, 0)
        self.assertEqual(store.load(path=self.store_path).sessions['cccc3333-0000']['name'], 'Infra: Nightly backups')

    def test_a_plugin_error_falls_back(self):
        plugin = FakePlugin(self.sock_path, {'ok': False, 'error': 'no-session'})
        self.addCleanup(plugin.close)
        rc, out, _ = self.run_cmd('--apply', 'Web: Sign-in redirect')
        self.assertEqual(rc, 1)
        self.assertIn('Obsidian could not rename it: no-session', out)


if __name__ == '__main__':
    unittest.main()

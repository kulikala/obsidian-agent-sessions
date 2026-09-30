"""`agent-sessions sessions`, `show` and `stats`, over canned scan/live/detail/usage output."""
import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from agentsessions import config
from agentsessions.cli import json_output, listing
from agentsessions.cli import sessions as cmd_sessions
from agentsessions.cli import show as cmd_show
from agentsessions.cli import stats as cmd_stats

NOW = 1_000_000.0


def session(sid, agent='claude', name=None, cwd='/w/proj', activity=NOW - 100, child=False):
    label = name or 'first prompt'
    return {'id': sid, 'agent': agent, 'name': name, 'group': None, 'label': label, 'cwd': cwd,
            'folder': os.path.basename(cwd), 'last_activity': activity, 'child': child, 'transcript': '/t/%s' % sid}


SCAN = {
    'sessions': [
        session('aaaa1111-0000', name='Fix login', activity=NOW - 60),
        session('bbbb2222-0000', agent='codex', name='Docs', cwd='/w/docs', activity=NOW - 3600),
        session('cccc3333-0000', agent='opencode', name=None, cwd='/w/other', activity=NOW - 86400 * 3),
        session('dddd4444-0000', name='Sub agent', child=True),
        session('eeee5555-0000', name='Old thing', activity=NOW - 86400 * 9),
        session('ffff6666-0000', name='Fix logout', activity=NOW - 7200),
    ],
    'store': {'archived': [{'id': 'eeee5555-0000'}], 'sessions': {}, 'folded': [], 'pendingRenames': {}},
}
LIVE = {
    'live': {
        'aaaa1111-0000': {'agent': 'claude', 'status': 'busy'},
        'bbbb2222-0000': {'agent': 'codex', 'status': 'waiting', 'waiting_for': 'permission'},
        'ffff6666-0000': {'agent': 'claude', 'status': 'idle'},
    },
    'daemon': {'running': True, 'sessions': [{'id': 'aaaa1111-0000', 'exited': None}]},
}


def patched(scan=SCAN, live=LIVE, links=None):
    return [
        mock.patch.object(json_output, 'scan_output', lambda: scan),
        mock.patch.object(json_output, 'live_output', lambda: live),
        mock.patch.object(json_output, '_daemon_links', lambda: links or {}),
    ]


class ListingTestCase(unittest.TestCase):
    def setUp(self):
        for p in patched():
            p.start()
            self.addCleanup(p.stop)
        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        for k in ('AGENT_SESSIONS_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'):
            os.environ.pop(k, None)


class TestCollect(ListingTestCase):
    def test_statuses_come_from_the_live_entries_and_a_session_without_one_has_ended(self):
        by_id = {r['id']: r for r in listing.collect()}
        self.assertEqual(by_id['aaaa1111-0000']['status'], 'running')
        self.assertEqual(by_id['bbbb2222-0000']['status'], 'asking')
        self.assertEqual(by_id['bbbb2222-0000']['waiting_for'], 'permission')
        self.assertEqual(by_id['ffff6666-0000']['status'], 'idle')
        self.assertEqual(by_id['cccc3333-0000']['status'], 'ended')

    def test_a_running_shell_command_counts_as_running(self):
        live = json.loads(json.dumps(LIVE))
        live['live']['ffff6666-0000']['status'] = 'shell'
        for p in patched(live=live):
            p.start()
            self.addCleanup(p.stop)
        self.assertEqual({r['id']: r for r in listing.collect()}['ffff6666-0000']['status'], 'running')

    def test_newest_first_without_archived_or_sub_agent_sessions(self):
        ids = [r['id'] for r in listing.collect()]
        self.assertEqual(ids, ['aaaa1111-0000', 'bbbb2222-0000', 'ffff6666-0000', 'cccc3333-0000'])
        self.assertNotIn('eeee5555-0000', ids)
        self.assertNotIn('dddd4444-0000', ids)

    def test_all_adds_archived_and_children(self):
        ids = [r['id'] for r in listing.collect(include_children=True, include_archived=True)]
        self.assertIn('eeee5555-0000', ids)
        self.assertIn('dddd4444-0000', ids)

    def test_an_unnamed_session_shows_its_first_prompt(self):
        by_id = {r['id']: r for r in listing.collect()}
        self.assertEqual(by_id['cccc3333-0000']['name'], 'first prompt')
        self.assertFalse(by_id['cccc3333-0000']['named'])

    def test_the_callers_own_session_is_marked(self):
        with mock.patch.dict(os.environ, {'CLAUDE_CODE_SESSION_ID': 'aaaa1111-0000'}):
            rows = listing.collect()
        self.assertEqual([r['id'] for r in rows if r['self']], ['aaaa1111-0000'])


class TestOwnSessionId(ListingTestCase):
    def test_a_daemon_id_is_mapped_through_the_stores_links(self):
        with mock.patch.object(json_output, '_daemon_links', lambda: {'daemon-1': 'thread-1'}):
            self.assertEqual(listing.own_session_id({'AGENT_SESSIONS_ID': 'daemon-1'}), 'thread-1')
            self.assertEqual(listing.own_session_id({'AGENT_SESSIONS_ID': 'claude-id'}), 'claude-id')

    def test_the_agents_own_variables_are_the_fallback(self):
        self.assertEqual(listing.own_session_id({'CLAUDE_CODE_SESSION_ID': 'c'}), 'c')
        self.assertEqual(listing.own_session_id({'CODEX_THREAD_ID': 'x'}), 'x')
        self.assertIsNone(listing.own_session_id({}))


class TestFind(ListingTestCase):
    def rows(self):
        return listing.collect(include_children=True, include_archived=True)

    def test_exact_id_prefix_name_and_substring(self):
        rows = self.rows()
        self.assertEqual(listing.find(rows, 'bbbb2222-0000')['name'], 'Docs')
        self.assertEqual(listing.find(rows, 'bbbb')['name'], 'Docs')
        self.assertEqual(listing.find(rows, 'docs')['id'], 'bbbb2222-0000')
        self.assertEqual(listing.find(rows, 'login')['id'], 'aaaa1111-0000')

    def test_several_matches_are_ambiguous_and_none_is_not_found(self):
        with self.assertRaises(listing.Ambiguous) as cm:
            listing.find(self.rows(), 'Fix lo')
        self.assertEqual({r['name'] for r in cm.exception.rows}, {'Fix login', 'Fix logout'})
        with self.assertRaises(listing.NotFound):
            listing.find(self.rows(), 'nothing like this')

    def test_a_short_prefix_is_not_an_id(self):
        with self.assertRaises(listing.NotFound):
            listing.find(self.rows(), 'aaa')

    def test_an_exact_name_beats_a_longer_name_containing_it(self):
        rows = [{'id': 'x1', 'name': 'Fix', 'agent': 'claude'}, {'id': 'x2', 'name': 'Fix more', 'agent': 'claude'}]
        self.assertEqual(listing.find(rows, 'fix')['id'], 'x1')


class TestAgo(unittest.TestCase):
    def test_units(self):
        self.assertEqual(listing.ago(NOW - 5, NOW), '5s ago')
        self.assertEqual(listing.ago(NOW - 130, NOW), '2m ago')
        self.assertEqual(listing.ago(NOW - 7300, NOW), '2h ago')
        self.assertEqual(listing.ago(NOW - 86400 * 3, NOW), '3d ago')
        self.assertEqual(listing.ago(None, NOW), '-')


class TestSessionsCommand(ListingTestCase):
    def run_cmd(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = cmd_sessions.main(list(args))
        return rc, out.getvalue()

    def test_one_line_per_session_with_status_and_folder(self):
        rc, out = self.run_cmd()
        self.assertEqual(rc, 0)
        lines = out.strip().splitlines()
        self.assertEqual(len(lines), 4)
        self.assertIn('aaaa1111-0000  claude   running', lines[0])
        self.assertIn('[/w/proj]  Fix login', lines[0])
        self.assertIn('asking (permission)', out)

    def test_query_agent_and_limit(self):
        _, out = self.run_cmd('--query', 'fix', '--json')
        self.assertEqual({s['id'] for s in json.loads(out)['sessions']}, {'aaaa1111-0000', 'ffff6666-0000'})
        _, out = self.run_cmd('--agent', 'codex', '--json')
        self.assertEqual([s['agent'] for s in json.loads(out)['sessions']], ['codex'])
        _, out = self.run_cmd('--query', '/w/docs', '--json')
        self.assertEqual([s['name'] for s in json.loads(out)['sessions']], ['Docs'])
        _, out = self.run_cmd('--limit', '1', '--json')
        data = json.loads(out)
        self.assertEqual((len(data['sessions']), data['total']), (1, 4))
        _, text = self.run_cmd('--limit', '1')
        self.assertIn('3 more', text)

    def test_status_words_can_be_searched(self):
        _, out = self.run_cmd('--query', 'ended', '--json')
        self.assertEqual([s['status'] for s in json.loads(out)['sessions']], ['ended'])

    def test_no_match(self):
        self.assertEqual(self.run_cmd('--query', 'zzz'), (0, 'no sessions\n'))

    def test_the_own_session_is_flagged_in_the_text(self):
        with mock.patch.dict(os.environ, {'CODEX_THREAD_ID': 'bbbb2222-0000'}):
            _, out = self.run_cmd()
        self.assertEqual(sum('<- this session' in line for line in out.splitlines()), 1)


DETAIL = {'last_user': 'fix the login', 'last_assistant': 'done', 'tools': ['Bash'], 'last_command': 'pytest', 'model': 'm1'}
USAGE = {'total': {'calls': 3, 'input': 10, 'output': 20, 'cache_read': 5, 'cache_create': 1, 'thinking': 0, 'cost': 1.5,
                   'tools': {'Bash': 2, 'Read': 1}, 'estimated': False, 'duration': 60, 'context_last': 9,
                   'first_ts': 1, 'last_ts': 2}}


class TestShowCommand(ListingTestCase):
    def setUp(self):
        super().setUp()
        for p in (mock.patch.object(json_output, 'detail_output', lambda sid: DETAIL),
                  mock.patch.object(json_output, 'usage_output', lambda sid: USAGE)):
            p.start()
            self.addCleanup(p.stop)

    def run_cmd(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = cmd_show.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def test_shows_status_usage_and_the_last_messages(self):
        rc, out, _ = self.run_cmd('Fix login')
        self.assertEqual(rc, 0)
        for text in ('ID: aaaa1111-0000', 'Status: running', 'Folder: /w/proj', '3 calls, input 10, output 20',
                     'cost $1.50', 'Model: m1', 'Bash x2, Read x1', 'fix the login', 'done', 'pytest'):
            self.assertIn(text, out)

    def test_without_an_argument_it_is_the_callers_own_session(self):
        with mock.patch.dict(os.environ, {'CLAUDE_CODE_SESSION_ID': 'ffff6666-0000'}):
            rc, out, _ = self.run_cmd()
        self.assertEqual(rc, 0)
        self.assertIn('ID: ffff6666-0000', out)
        self.assertIn('<- this session', out)

    def test_outside_a_session_self_is_an_error(self):
        rc, _, err = self.run_cmd()
        self.assertEqual(rc, 2)
        self.assertIn('not running inside', err)

    def test_json_carries_session_detail_and_usage(self):
        rc, out, _ = self.run_cmd('bbbb', '--json')
        data = json.loads(out)
        self.assertEqual(data['session']['agent'], 'codex')
        self.assertEqual(data['detail']['last_user'], 'fix the login')
        self.assertEqual(data['usage']['cost'], 1.5)

    def test_ambiguous_and_unknown_names_list_candidates_or_say_so(self):
        rc, _, err = self.run_cmd('Fix lo')
        self.assertEqual(rc, 2)
        self.assertIn('aaaa1111-0000', err)
        self.assertIn('ffff6666-0000', err)
        rc, _, err = self.run_cmd('zzz')
        self.assertEqual(rc, 2)
        self.assertIn('no session matches', err)

    def test_an_archived_session_can_still_be_looked_at(self):
        rc, out, _ = self.run_cmd('Old thing')
        self.assertEqual(rc, 0)


WINDOW = {'used_percentage': 42.0, 'end': NOW + 3 * 3600 + 5 * 60, 'total': {'calls': 2, 'input': 100, 'output': 50,
          'cache_read': 0, 'cache_create': 0, 'cost': 0.25}, 'sessions': [{}, {}]}


class TestStatsCommand(unittest.TestCase):
    def test_render_gives_each_agents_windows(self):
        data = {'agents': {'claude': {'windows': {'five_hour': WINDOW, 'seven_day': dict(WINDOW, used_percentage=None)}}}}
        text = cmd_stats.render(data, NOW)
        self.assertIn('claude', text)
        self.assertIn('5-hour window: 42% used, resets in 3h05m', text)
        self.assertIn('2 calls, 150 tokens, cost $0.25 across 2 sessions', text)
        self.assertIn('7-day window: usage unknown', text)

    def test_a_window_that_has_reset(self):
        text = cmd_stats.render({'agents': {'codex': {'windows': {'five_hour': dict(WINDOW, end=NOW - 5)}}}}, NOW)
        self.assertIn(', reset (', text)

    def test_nothing_to_show(self):
        self.assertIn('no usage windows', cmd_stats.render({}, NOW))

    def test_the_command_prints_json_or_text(self):
        data = {'agents': {'claude': {'windows': {'five_hour': WINDOW}}}}
        with mock.patch.object(json_output, 'stats_output', lambda: data):
            out = io.StringIO()
            with redirect_stdout(out):
                cmd_stats.main(['--json'])
            self.assertEqual(json.loads(out.getvalue()), data)
            out = io.StringIO()
            with redirect_stdout(out):
                cmd_stats.main([])
            self.assertIn('5-hour window', out.getvalue())


class TestDispatch(unittest.TestCase):
    def test_the_new_subcommands_are_registered(self):
        from agentsessions.cli import SUBCOMMANDS
        for cmd in ('new', 'sessions', 'show', 'stats'):
            self.assertIn(cmd, SUBCOMMANDS)


class TestRuntimeDirOverride(unittest.TestCase):
    def test_the_environment_moves_the_runtime_dir_and_everything_under_it(self):
        import subprocess
        import sys
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        out = subprocess.run(
            [sys.executable, '-c', 'from agentsessions import config; print(config.RUNTIME_DIR, config.SOCK_PATH, config.UI_STATE_PATH)'],
            cwd=root, env=dict(os.environ, AGENT_SESSIONS_RUNTIME_DIR='/tmp/x-rt'), capture_output=True, text=True)
        self.assertEqual(out.stdout.split(), ['/tmp/x-rt', '/tmp/x-rt/daemon.sock', '/tmp/x-rt/ui.json'])
        self.assertTrue(config.RUNTIME_DIR)


if __name__ == '__main__':
    unittest.main()

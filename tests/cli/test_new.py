"""`agent-sessions new`, run against a real daemon (in this process, in a temp runtime dir) starting a
stand-in for the agent: a shell script that records its argv and environment and, for Claude, writes
the transcript lines the real one would."""
import io
import json
import os
import shutil
import signal
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from agentsessions import config
from agentsessions.cli import json_output
from agentsessions.cli import new as cmd_new
from agentsessions.daemon import server as daemon
from agentsessions.sessions import store

TIMEOUT = 5.0

FAKE_AGENT = r'''#!/bin/sh
# Stand-in for an agent CLI. Records how it was started.
out="$FAKE_OUT"
: > "$out.argv"
for a in "$@"; do printf '%s\n' "$a" >> "$out.argv"; done
env | sort > "$out.env"
sid=""; name=""; rc=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) sid="$2"; shift ;;
    --name) name="$2"; shift ;;
    --remote-control=*) rc="${1#--remote-control=}" ;;
    --remote-control) rc="-" ;;
  esac
  shift
done
if [ -n "$sid" ] && [ -n "$FAKE_TRANSCRIPTS" ]; then
  mkdir -p "$FAKE_TRANSCRIPTS/proj"
  t="$FAKE_TRANSCRIPTS/proj/$sid.jsonl"
  if [ -n "$name" ]; then printf '{"type":"custom-title","customTitle":"%s","sessionId":"%s"}\n' "$name" "$sid" >> "$t"; fi
  if [ -n "$rc" ]; then printf '{"type":"system","subtype":"bridge_status","url":"https://claude.ai/code/session_x"}\n' >> "$t"; fi
fi
exec sleep 30
'''


class NewTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='agsd-new-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.runtime = os.path.join(self.tmp, 'run')
        os.makedirs(self.runtime)
        self.vault = os.path.join(self.tmp, 'vault')
        self.work = os.path.join(self.tmp, 'work')
        self.projects = os.path.join(self.tmp, 'projects')
        for d in (self.vault, self.work, self.projects):
            os.makedirs(d)
        self.agent = os.path.join(self.tmp, 'fake-agent')
        with open(self.agent, 'w') as f:
            f.write(FAKE_AGENT)
        os.chmod(self.agent, 0o755)
        self.rec = os.path.join(self.tmp, 'rec')
        self.ui = os.path.join(self.tmp, 'ui.json')
        self.write_ui({a: {'path': self.agent, 'env': {'FAKE_OUT': self.rec, 'FAKE_TRANSCRIPTS': self.projects}}
                       for a in ('claude', 'codex', 'opencode')})

        self.sock = os.path.join(self.runtime, 'daemon.sock')
        self.daemon = daemon.Daemon(sock_path=self.sock, runtime_dir=self.runtime, idle_exit=600, echo_stderr=False)
        self.daemon.bind()
        self.thread = threading.Thread(target=self.daemon.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_daemon)

        store_path = os.path.join(self.vault, '.agents', 'sessions', 'sessions.json')
        patches = [
            mock.patch.dict(os.environ, {'AGENT_SESSIONS_SOCK': self.sock, 'AGENT_SESSIONS_AGENTS': 'claude,codex,opencode'}),
            mock.patch.object(config, 'UI_STATE_PATH', self.ui),
            mock.patch.object(config, 'VAULT', self.vault),
            mock.patch.object(config, 'STORE_PATH', store_path),
            mock.patch.object(config, 'PROJECTS_DIR', self.projects),
            mock.patch.object(config, 'RUNTIME_DIR', self.runtime),
            mock.patch.object(cmd_new, 'POLL_SECONDS', 0.05),
            mock.patch.object(cmd_new, 'SETTLE_SECONDS', 0.1),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.store_path = store_path

    def stop_daemon(self):
        pids = [s.pid for s in self.daemon.sessions.values() if s.running and s.pid]
        if self.thread.is_alive():
            self.daemon.stop()
            self.thread.join(TIMEOUT)
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass

    def write_ui(self, launch):
        with open(self.ui, 'w') as f:
            json.dump({'agentLaunch': launch}, f)

    def run_new(self, *args, environ=None):
        out, err = io.StringIO(), io.StringIO()
        base = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': self.tmp}
        base.update(environ or {})
        with redirect_stdout(out), redirect_stderr(err), mock.patch.dict(os.environ, base, clear=False):
            for k in [k for k in os.environ if k.startswith(('CLAUDE', 'CODEX_', 'OPENCODE_')) or k == 'AGENT_SESSIONS_ID']:
                if k not in (environ or {}):
                    del os.environ[k]
            rc = cmd_new.main(['--cwd', self.work, '--timeout', '3'] + list(args))
        return rc, out.getvalue(), err.getvalue()

    def recorded(self, kind):
        with open(self.rec + '.' + kind) as f:
            return f.read()

    def wait_recorded(self):
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline and not os.path.exists(self.rec + '.env'):
            time.sleep(0.02)
        time.sleep(0.05)


class TestClaude(NewTestCase):
    def test_a_named_remote_controlled_session_is_confirmed_from_its_transcript(self):
        rc, out, err = self.run_new('--agent', 'claude', '--name', 'Fix login', '--remote-control', '--json')
        self.assertEqual(rc, 0, err)
        result = json.loads(out)
        self.assertTrue(result['confirmed'])
        self.assertEqual(result['name'], 'Fix login')
        self.assertEqual(result['remote_control'], 'https://claude.ai/code/session_x')
        sid = result['id']
        self.assertEqual(self.recorded('argv').split('\n')[:-1],
                         ['--session-id', sid, '--name', 'Fix login', '--remote-control=Fix login'])
        # Registered for Obsidian's list, under the id Claude was told to use.
        self.assertEqual(store.load(self.store_path).sessions[sid], {'agent': 'claude', 'cwd': self.work})

    def test_it_runs_in_the_folder_asked_for_with_the_plugins_environment(self):
        rc, out, _ = self.run_new('--agent', 'claude', '--json', environ={
            'CLAUDECODE': '1', 'CLAUDE_PID': '1', 'CLAUDE_EFFORT': 'high', 'CLAUDE_CODE_SESSION_ID': 'x',
            'CLAUDE_PLUGIN_ROOT': '/p', 'AGENT_SESSIONS_ID': 'someone-else', 'LANG': 'C', 'SECRET_TOKEN': 'no'})
        self.assertEqual(rc, 0)
        env = dict(line.split('=', 1) for line in self.recorded('env').splitlines() if '=' in line)
        self.assertEqual(env['PWD'], os.path.realpath(self.work))
        self.assertEqual(env['AGENT_SESSIONS_VAULT'], self.vault)
        self.assertEqual(env['AGENT_SESSIONS_ID'], json.loads(out)['id'])   # the new session's own, set by the daemon
        for key in ('CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PLUGIN_ROOT', 'SECRET_TOKEN'):
            self.assertNotIn(key, env)
        self.assertEqual(env['LANG'], 'C')
        self.assertEqual(env['FAKE_OUT'], self.rec)   # the agent's own variables from the settings

    def test_no_name_and_no_remote_control_only_needs_the_session_to_be_running(self):
        rc, out, _ = self.run_new('--agent', 'claude', '--json')
        self.assertEqual(rc, 0)
        self.assertEqual(self.recorded('argv').split('\n')[0], '--session-id')

    def test_a_name_that_never_shows_up_exits_1_and_leaves_the_session_running(self):
        self.write_ui({'claude': {'path': self.agent, 'env': {'FAKE_OUT': self.rec}}})   # writes no transcript
        rc, out, _ = self.run_new('--agent', 'claude', '--name', 'X', '--timeout', '0.5', '--json')
        self.assertEqual(rc, 1)
        result = json.loads(out)
        self.assertFalse(result['confirmed'])
        self.assertIn('attach', result['attach'])
        self.assertTrue(any(s.id == result['id'] and s.running for s in self.daemon.sessions.values()))

    def test_the_first_message_is_passed_after_a_double_dash(self):
        rc, _, _ = self.run_new('--agent', 'claude', '--prompt', 'do the thing')
        self.assertEqual(rc, 0)
        self.assertEqual(self.recorded('argv').split('\n')[-3:-1], ['--', 'do the thing'])

    def test_the_default_agent_is_the_callers_own(self):
        rc, out, _ = self.run_new('--json', environ={'CODEX_THREAD_ID': 't'})
        self.assertEqual(json.loads(out)['agent'], 'codex')
        rc, out, _ = self.run_new('--json', environ={'CLAUDECODE': '1'})
        self.assertEqual(json.loads(out)['agent'], 'claude')

    def test_human_output_names_the_id_and_how_to_open_it(self):
        rc, out, _ = self.run_new('--agent', 'claude', '--name', 'N', '--remote-control')
        self.assertEqual(rc, 0)
        self.assertIn('ID: ', out)
        self.assertIn('Remote Control: https://claude.ai/code/session_x', out)
        self.assertIn(' attach ', out)


class TestFailures(NewTestCase):
    def test_a_missing_folder_is_exit_2(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = cmd_new.main(['--cwd', os.path.join(self.tmp, 'nope')])
        self.assertEqual(rc, 2)
        self.assertIn('no such folder', err.getvalue())

    def test_a_disabled_agent_is_refused(self):
        with mock.patch.dict(os.environ, {'AGENT_SESSIONS_AGENTS': 'claude'}):
            rc, _, err = self.run_new('--agent', 'codex')
        self.assertEqual(rc, 2)
        self.assertIn('not enabled', err)

    def test_a_missing_binary_is_exit_2_in_words(self):
        self.write_ui({'claude': {'path': '', 'env': {}}})
        rc, _, err = self.run_new('--agent', 'claude', environ={'PATH': '/nonexistent'})
        self.assertEqual(rc, 2)
        self.assertIn('claude was not found', err)

    def test_ollama_launch_without_a_model_is_refused(self):
        self.write_ui({'opencode': {'path': self.agent, 'env': {}, 'launchVia': 'ollama', 'ollamaModel': ''}})
        rc, _, err = self.run_new('--agent', 'opencode')
        self.assertEqual(rc, 2)
        self.assertIn('no model', err)

    def test_an_agent_that_dies_at_once_is_exit_2(self):
        with open(self.agent, 'w') as f:
            f.write('#!/bin/sh\nexit 3\n')
        rc, _, err = self.run_new('--agent', 'claude', '--name', 'X')
        self.assertEqual(rc, 2)
        self.assertIn('ended right after it started', err)

    def test_json_errors_are_json(self):
        rc, out, _ = self.run_new('--agent', 'claude', '--cwd', os.path.join(self.tmp, 'nope'), '--json')
        self.assertEqual(rc, 2)
        self.assertEqual(json.loads(out)['ok'], False)


class TestResolvedAgents(NewTestCase):
    def resolver(self, thread, after=1):
        calls = {'n': 0}

        def fake(agent, pid, since, cwd):
            calls['n'] += 1
            self.assertIsInstance(pid, int)
            self.assertEqual(cwd, self.work)
            return {'thread': thread if calls['n'] >= after else None, 'transcript': None}
        return mock.patch.object(json_output, 'resolve_output', fake)

    def test_opencode_is_linked_under_its_real_id_with_the_name(self):
        with self.resolver('ses_real', after=3):
            rc, out, _ = self.run_new('--agent', 'opencode', '--name', 'Docs', '--prompt', 'hi', '--json')
        self.assertEqual(rc, 0)
        result = json.loads(out)
        self.assertEqual(result['id'], 'ses_real')
        entry = store.load(self.store_path).sessions['ses_real']
        self.assertEqual(entry, {'agent': 'opencode', 'cwd': self.work, 'daemon': result['daemon_id'], 'name': 'Docs'})
        self.assertEqual(store.load(self.store_path).pendingRenames, {})
        self.wait_recorded()
        self.assertNotIn('--name', self.recorded('argv'))

    def test_codex_is_linked_and_its_name_is_reported_as_not_applied(self):
        with self.resolver('thread-1'):
            rc, out, _ = self.run_new('--agent', 'codex', '--name', 'Docs', '--prompt', 'hi', '--json')
        self.assertEqual(rc, 0)
        result = json.loads(out)
        entry = store.load(self.store_path).sessions['thread-1']
        self.assertEqual(entry, {'agent': 'codex', 'cwd': self.work, 'daemon': result['daemon_id']})
        self.assertTrue(any('/rename' in w for w in result['warnings']))

    def test_a_link_obsidian_made_first_counts_as_confirmed(self):
        # Obsidian adopts the unlinked daemon session and links it; `json resolve` then leaves that
        # thread out as already linked and never returns it.
        daemon = '0f0f0f0f-0000-4000-8000-000000000001'

        def fake(agent, pid, since, cwd):
            store.update(lambda st: st.sessions.__setitem__(
                'thread-p', {'agent': 'codex', 'cwd': cwd, 'daemon': daemon}), self.store_path)
            return {'thread': None, 'transcript': None}
        with mock.patch.object(cmd_new.uuid, 'uuid4', return_value=daemon), \
                mock.patch.object(json_output, 'resolve_output', fake):
            rc, out, _ = self.run_new('--agent', 'codex', '--prompt', 'hi', '--timeout', '5', '--json')
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)['id'], 'thread-p')
        self.assertEqual(cmd_new.linked_to({'a': {'daemon': 'x'}, 'b': 'junk'}, 'x'), 'a')
        self.assertIsNone(cmd_new.linked_to({'a': {'daemon': 'y'}}, 'x'))

    def test_an_id_that_does_not_appear_in_time_exits_1_and_says_how_to_attach(self):
        with self.resolver(None):
            rc, out, _ = self.run_new('--agent', 'codex', '--prompt', 'hi', '--timeout', '0.5', '--json')
        self.assertEqual(rc, 1)
        result = json.loads(out)
        self.assertEqual(result['id'], result['daemon_id'])
        self.assertTrue(any('Obsidian links it' in w for w in result['warnings']))
        self.assertEqual(store.load(self.store_path).sessions, {})

    def test_without_a_prompt_it_exits_0_once_the_process_is_up_and_leaves_the_linking_to_obsidian(self):
        with mock.patch.object(cmd_new, 'SETTLE_SECONDS', 0.2), mock.patch.object(
                json_output, 'resolve_output', side_effect=AssertionError('must not resolve')):
            rc, out, _ = self.run_new('--agent', 'codex', '--json')
        self.assertEqual(rc, 0)
        result = json.loads(out)
        self.assertEqual(result['id'], result['daemon_id'])
        self.assertTrue(any('real id after its first message' in w and 'Obsidian links it' in w
                            for w in result['warnings']))
        self.assertEqual(store.load(self.store_path).sessions, {})

    def test_an_opencode_name_waits_in_pending_renames_for_the_link(self):
        with mock.patch.object(cmd_new, 'SETTLE_SECONDS', 0.2):
            rc, out, _ = self.run_new('--agent', 'opencode', '--name', 'Docs', '--json')
        self.assertEqual(rc, 0)
        st = store.load(self.store_path)
        self.assertEqual(st.pendingRenames, {json.loads(out)['daemon_id']: 'Docs'})
        self.assertEqual(st.sessions, {})

    def test_a_process_that_dies_at_once_is_not_reported_as_started(self):
        with mock.patch.object(cmd_new, 'SETTLE_SECONDS', 0.2), mock.patch.object(
                cmd_new, '_daemon_session', return_value=None):
            rc, out, _ = self.run_new('--agent', 'codex', '--json')
        self.assertEqual(rc, 2)

    def test_remote_control_is_ignored_for_other_agents(self):
        with self.resolver('t'):
            rc, out, _ = self.run_new('--agent', 'codex', '--remote-control', '--prompt', 'x', '--json')
        self.assertTrue(any('only for Claude Code' in w for w in json.loads(out)['warnings']))
        self.wait_recorded()
        self.assertNotIn('remote-control', self.recorded('argv'))


class TestEnsureDaemon(unittest.TestCase):
    def test_a_daemon_that_does_not_answer_is_started_detached_and_waited_for(self):
        answers = iter([None, None, {'ok': True, 'sessions': []}])
        with mock.patch.object(cmd_new, '_daemon', lambda op, **kw: next(answers)), \
                mock.patch.object(cmd_new.subprocess, 'Popen') as popen, \
                mock.patch.object(cmd_new.time, 'sleep'):
            cmd_new.ensure_daemon()
        argv = popen.call_args[0][0]
        self.assertEqual(argv[-2:], ['daemon', '--detach'])
        self.assertTrue(popen.call_args[1]['start_new_session'])

    def test_a_daemon_that_never_comes_up_is_a_failure(self):
        with mock.patch.object(cmd_new, '_daemon', lambda op, **kw: None), \
                mock.patch.object(cmd_new.subprocess, 'Popen'), mock.patch.object(cmd_new.time, 'sleep'):
            with self.assertRaises(cmd_new.Failure):
                cmd_new.ensure_daemon()


class TestHelpers(unittest.TestCase):
    def test_caller_agent_prefers_the_daemons_record(self):
        sessions = [{'id': 'me', 'agent': 'opencode'}]
        self.assertEqual(cmd_new.caller_agent({'AGENT_SESSIONS_ID': 'me', 'CLAUDECODE': '1'}, sessions), 'opencode')
        self.assertEqual(cmd_new.caller_agent({'CLAUDECODE': '1'}, []), 'claude')
        self.assertEqual(cmd_new.caller_agent({'CODEX_THREAD_ID': 't'}, []), 'codex')
        self.assertEqual(cmd_new.caller_agent({'OPENCODE_PID': '1'}, []), 'opencode')
        self.assertIsNone(cmd_new.caller_agent({}, []))

    def test_choose_agent(self):
        self.assertEqual(cmd_new.choose_agent(None, 'codex', ['claude', 'codex']), 'codex')
        self.assertEqual(cmd_new.choose_agent(None, 'codex', ['claude']), 'claude')   # the caller's agent is off
        self.assertEqual(cmd_new.choose_agent('claude', 'codex', ['claude', 'codex']), 'claude')
        with self.assertRaises(cmd_new.Failure):
            cmd_new.choose_agent('codex', None, ['claude'])

    def test_read_claude_progress_takes_the_latest_title_and_a_url(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 't.jsonl')
            with open(path, 'w') as f:
                f.write('garbage\n')
                f.write(json.dumps({'type': 'custom-title', 'customTitle': 'old'}) + '\n')
                f.write(json.dumps({'type': 'system', 'subtype': 'bridge_status'}) + '\n')
                f.write(json.dumps({'type': 'custom-title', 'customTitle': 'new'}) + '\n')
                f.write(json.dumps({'type': 'system', 'subtype': 'bridge_status', 'url': 'https://x'}) + '\n')
            self.assertEqual(cmd_new.read_claude_progress(path), ('new', 'https://x'))
            self.assertEqual(cmd_new.read_claude_progress(path + '.missing'), (None, None))


if __name__ == '__main__':
    unittest.main()

import contextlib
import glob
import io
import json
import os
import re
import shutil
import tempfile
import unittest
from unittest import mock

from agentsessions import config
from agentsessions.cli import json_cmd, json_output
from agentsessions.efficiency import cache, report
from tests.efficiency import builder as b
from tests.efficiency import scenario as sc

DAY = sc.DAY


def _call(ts, w):
    return {'ts': ts, 'in': w, 'cr': 0, 'cw': 0, 'cw1h': 0, 'out': 0}


class RangeRuleTest(unittest.TestCase):
    NOW = 1_000_000_000.0

    def windows(self, five=None, seven=None, five_ex=False, seven_ex=False):
        return {'five_hour': {'start': self.NOW - 3 * 3600, 'used_percentage': five, 'exhausted': five_ex},
                'seven_day': {'start': self.NOW - 4 * DAY, 'used_percentage': seven, 'exhausted': seven_ex}}

    def test_five_hour_first(self):
        r = report.choose_range(self.NOW, self.windows(86, 95), [], 80, 1e7)
        self.assertEqual((r['rule'], r['start'], r['end'], r['used_percentage']),
                         ('five_hour', self.NOW - 3 * 3600, self.NOW, 86))

    def test_seven_day_next(self):
        r = report.choose_range(self.NOW, self.windows(10, 90), [], 80, 1e7)
        self.assertEqual((r['rule'], r['start']), ('seven_day', self.NOW - 4 * DAY))

    def test_exhausted_counts_even_without_a_percentage(self):
        r = report.choose_range(self.NOW, self.windows(None, None, five_ex=True), [], 80, 1e7)
        self.assertEqual((r['rule'], r['exhausted']), ('five_hour', True))
        r = report.choose_range(self.NOW, self.windows(None, None, seven_ex=True), [], 80, 1e7)
        self.assertEqual(r['rule'], 'seven_day')

    def test_unknown_percentage_falls_to_the_budget(self):
        calls = [_call(self.NOW - i * 3600, 1_000_000) for i in range(10)]
        r = report.choose_range(self.NOW, self.windows(None, None), calls, 80, 3_000_000)
        self.assertEqual(r['rule'], 'budget')
        self.assertEqual(r['start'], self.NOW - 24 * 3600)     # reached in 2 hours: still a whole day
        self.assertEqual(r['basis'], 'min_day')
        sparse = [_call(self.NOW - i * 10 * 3600, 1_000_000) for i in range(10)]
        r = report.choose_range(self.NOW, self.windows(None, None), sparse, 80, 3_000_000)
        self.assertEqual(r['start'], self.NOW - 24 * 3600)     # budget reached at 20 hours: still a day
        r = report.choose_range(self.NOW, self.windows(None, None), sparse, 80, 5_000_000)
        self.assertEqual(r['start'], self.NOW - 40 * 3600)     # the call that reaches the budget
        self.assertEqual(r['basis'], 'budget')

    def test_budget_stops_at_seven_days(self):
        calls = [_call(self.NOW - i * DAY, 1000) for i in range(10)]
        r = report.choose_range(self.NOW, {}, calls, 80, 1e9)
        self.assertEqual(r['start'], self.NOW - 7 * DAY)
        self.assertEqual(r['basis'], 'max_week')
        r = report.choose_range(self.NOW, {}, [], 80, 1e9)
        self.assertEqual(r['start'], self.NOW - 7 * DAY)


class OutputTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.projects = os.path.join(self.tmp, 'projects')
        self.runtime = os.path.join(self.tmp, 'runtime')
        status = os.path.join(self.runtime, 'status')
        os.makedirs(status)
        patches = [
            mock.patch.object(config, 'PROJECTS_DIR', self.projects),
            mock.patch.object(config, 'RUNTIME_DIR', self.runtime),
            mock.patch.object(config, 'STATUS_DIR', status),
            mock.patch.object(config, 'STATS_CACHE_PATH', os.path.join(self.runtime, 'stats-cache.json')),
            mock.patch.object(config, 'CACHE_PATH', os.path.join(self.runtime, 'scan-cache.json')),
            mock.patch.object(config, 'VAULT', b.CWD),
            mock.patch.dict(os.environ, {'AGENT_SESSIONS_AGENTS': 'claude'}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.uuids = sc.history(self.projects, 'en', heavy=True)
        self.age()

    def age(self):
        """Give every transcript an mtime well before `sc.NOW`, outside the racy window."""
        for path in glob.glob(os.path.join(self.projects, '**', '*.jsonl'), recursive=True):
            os.utime(path, (sc.NOW - 60, sc.NOW - 60))

    def run_cli(self, *args):
        out = io.StringIO()
        with mock.patch('time.time', return_value=sc.NOW), contextlib.redirect_stdout(out):
            code = json_cmd.main(['efficiency'] + list(args))
        self.assertEqual(code, 0)
        text = out.getvalue()
        self.assertEqual(text.count('\n'), 1)
        return json.loads(text)

    def claude(self, *args):
        return self.run_cli('--agent', 'claude', *args)['agents']['claude']

    def test_shape(self):
        c = self.claude()
        self.assertEqual(set(c), {'range', 'totals', 'providers', 'sessions', 'breakdown', 'tasks', 'hits',
                                  'baselines', 'limits', 'panes'})
        self.assertEqual(c['range']['rule'], 'budget')
        self.assertEqual([(p['key'], p['provider'], p['local']) for p in c['panes']], [('claude', 'anthropic', False)])
        self.assertEqual(set(c['panes'][0]['digest']), {'agent', 'context', 'sessions', 'tasks', 'hints'})
        self.assertEqual(c['providers'][0]['provider'], 'anthropic')
        self.assertEqual(c['baselines']['disabled'], [])
        self.assertFalse(c['limits']['truncated'])
        e16 = [h for h in c['hits'] if h['detector'] == 'E16']
        self.assertEqual(len(e16), 1)
        self.assertNotIn('E16', [x['cause'] for x in c['breakdown']])
        self.assertNotIn('digest', self.claude('--no-digest')['panes'][0])

    def test_digest_has_every_task_of_the_range_oldest_first(self):
        c = self.claude()
        d = c['panes'][0]['digest']
        ids = [t['id'] for t in d['tasks']]
        lo, hi = c['range']['start'], c['range']['end']
        self.assertTrue(ids)
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual([t['ts'] for t in d['tasks']], sorted(t['ts'] for t in d['tasks']))
        self.assertTrue(all(lo - 3 * sc.DAY <= t['ts'] <= hi for t in d['tasks']))
        # Every hit with a task is among them, and goes along as a hint.
        self.assertTrue({h['task'] for h in c['hits'] if h['task']} <= set(ids))
        self.assertEqual({h['id'] for h in d['hints']}, {h['id'] for h in c['hits']})
        self.assertEqual({s['id'] for s in d['sessions']}, {t['session'] for t in d['tasks']})
        self.assertEqual(d['context']['range']['start'], lo)
        self.assertIn('L_med', d['context']['baselines'])

    def test_digest_turns_carry_prompts_replies_and_numbers_never_tool_output(self):
        d = self.claude()['panes'][0]['digest']
        task = next(t for t in d['tasks'] if t['session'] == sc.SCENARIO)
        first = task['turns'][0]
        self.assertEqual(first['prompt'], b.text_of('en', sc.LONG)[:600])
        self.assertTrue(first['ref'].startswith(task['id'] + '.p'))
        self.assertGreater(first['w'], 0)
        self.assertEqual(first['tools'].get('read'), 1)
        self.assertIn('src/a.py', first['paths'])            # inside the vault: relative
        rework = [t for t in task['turns'] if t.get('rework')]
        self.assertTrue(rework)
        blob = json.dumps(d, ensure_ascii=False)
        self.assertNotIn('x' * 50, blob)                     # read results: never sent
        self.assertNotIn(b.CWD + '/', blob)
        for t in d['tasks']:
            for turn in t['turns']:
                self.assertLessEqual(len(turn.get('prompt') or ''), 600)
                self.assertLessEqual(len(turn.get('reply') or ''), 200)

    def test_digest_text_is_masked(self):
        sid = b.session_uuid(990)
        t = b.Transcript(sid, sc.NOW - 3600)
        t.prompt('use key sk-ant-api03-abcdefgh and mail pat@example.org about /srv/app/src/deep/auth.ts')
        t.call(text='Read https://example.com/a/b?c=1 for pat@example.org')
        t.write(os.path.join(b.project_dir(self.projects), sid + '.jsonl'))
        self.age()
        d = self.claude()['panes'][0]['digest']
        turn = next(t for t in d['tasks'] if t['session'] == sid)['turns'][0]
        self.assertEqual(turn['prompt'], 'use key [secret] and mail [email] about …/deep/auth.ts')
        self.assertEqual(turn['reply'], 'Read https://example.com/… for [email]')

    def test_digest_never_carries_the_user_name(self):
        import getpass
        from agentsessions.efficiency import excerpt
        names = [n for n in excerpt.user_names(os.path.expanduser('~')) if len(n) >= 3]
        self.assertTrue(names)
        name = names[0]
        sid = b.session_uuid(991)
        t = b.Transcript(sid, sc.NOW - 3600)
        t.prompt('copy /Users/%s/Applications/a.app to /home/%s/x and C:\\Users\\%s\\y, '
                 'see ~/.claude/projects/-Users-%s-work/s.jsonl and /srv/%s/data' % ((name,) * 5))
        t.read('/srv/%s/notes/today.md' % name)
        t.call(text='Copied it into /Users/%s/Applications.' % name)
        t.write(os.path.join(b.project_dir(self.projects), sid + '.jsonl'))
        self.age()
        blob = json.dumps(self.claude()['panes'][0]['digest'], ensure_ascii=False)
        self.assertNotIn(os.path.expanduser('~'), blob)
        for n in names:
            self.assertNotRegex(blob, '(?i)[/\\\\-]%s(?![A-Za-z0-9])' % re.escape(n))
        self.assertIn('~/Applications/a.app', blob)

    def test_digest_savings_per_check(self):
        d = self.claude()['panes'][0]['digest']
        checks = {'rework', 'firstRequest', 'mixedTasks', 'longContext', 'largeOutput', 'cacheRebuild',
                  'repeatedLookups', 'startupSize', 'found'}
        for t in d['tasks']:
            self.assertEqual(set(t['saving']), checks)
            self.assertTrue(all(isinstance(v, int) and v >= 0 for v in t['saving'].values()))
            self.assertEqual(t['saving']['found'], round(t['w'] * 0.3))
            self.assertLessEqual(t['saving']['rework'], t['w'])
        heavy = next(t for t in d['tasks'] if t['session'] == sc.SCENARIO and t['turn_count'] == 4)
        self.assertGreater(heavy['saving']['rework'], 0)

    def test_cache_has_no_conversation_text_and_is_reused(self):
        self.claude()
        files = glob.glob(os.path.join(self.runtime, 'efficiency', 'cache', '*.json'))
        self.assertTrue(files)
        blob = ''.join(open(f, encoding='utf-8').read() for f in files)
        for fragment in (b.FILLER['en'][:30], b.FILLER['en'][-30:].strip(), b.SHORT['en'], 'still working'):
            self.assertNotIn(fragment, blob)
        again = self.claude()
        self.assertEqual(again['limits']['parsed_bytes'], 0)
        self.assertEqual(again['limits']['cache_hits'], len(files))

    def test_grown_or_other_version_is_read_again_and_gone_is_removed(self):
        self.claude()
        path = os.path.join(b.project_dir(self.projects), sc.SCENARIO + '.jsonl')
        t = b.Transcript(sc.SCENARIO, sc.NOW - 600)
        t.prompt('one more')
        t.call()
        with open(path, 'a', encoding='utf-8') as f:
            for rec in t.lines:
                f.write(json.dumps(rec) + '\n')
        self.age()
        c = self.claude()
        self.assertEqual(c['limits']['parsed_bytes'], os.path.getsize(path))
        with mock.patch.object(cache, 'EFFICIENCY_VERSION', cache.EFFICIENCY_VERSION + 1):
            self.assertGreater(self.claude()['limits']['parsed_bytes'], os.path.getsize(path))
        gone = os.path.join(b.project_dir(self.projects), b.session_uuid(100) + '.jsonl')
        entry = cache.entry_path(gone)
        self.assertTrue(os.path.exists(entry))
        os.unlink(gone)
        self.claude()
        self.assertFalse(os.path.exists(entry))

    def test_two_ranges_agree(self):
        wide = self.claude('--from', '2026-09-08T00:00:00Z', '--to', '2026-09-21T12:00:00Z')
        narrow = self.claude('--from', '2026-09-18T00:00:00Z', '--to', '2026-09-20T23:00:00Z')
        self.assertEqual(wide['range']['rule'], 'explicit')
        self.assertEqual(wide['baselines'], narrow['baselines'])
        lo, hi = narrow['range']['start'], narrow['range']['end']
        # `tasks` lists the 20 largest, so the wide range shows fewer of the shared ones.
        shape = lambda c: {t['id']: (t['turns'], t['corrections'], t['all_calls'])
                           for t in c['tasks'] if lo <= t['first_ts'] and t['last_ts'] <= hi}
        shared = shape(wide)
        self.assertTrue(shared)
        self.assertEqual(shared, {k: v for k, v in shape(narrow).items() if k in shared})
        hit_ids = lambda c: sorted(h['id'] for h in c['hits'] if h['ts'] and lo <= h['ts'] <= hi)
        self.assertTrue(hit_ids(narrow))
        self.assertEqual(hit_ids(wide), hit_ids(narrow))

    def test_sub_agents_are_read_unless_older_than_the_window(self):
        folder = os.path.join(b.project_dir(self.projects), sc.SCENARIO, 'subagents')
        fresh = b.Transcript(sc.SCENARIO, sc.NOW - 2 * sc.DAY, agent_id='fresh')
        fresh.call()
        fresh.write(os.path.join(folder, 'agent-fresh.jsonl'))
        old = b.Transcript(sc.SCENARIO, sc.NOW - 30 * sc.DAY, agent_id='old')
        old.call()
        old_path = old.write(os.path.join(folder, 'agent-old.jsonl'))
        self.age()
        os.utime(old_path, (sc.NOW - 30 * sc.DAY, sc.NOW - 30 * sc.DAY))
        self.claude()
        self.assertTrue(os.path.exists(cache.entry_path(os.path.join(folder, 'agent-fresh.jsonl'))))
        self.assertFalse(os.path.exists(cache.entry_path(old_path)))

    def test_max_sessions(self):
        c = self.claude('--max-sessions', '5')
        self.assertEqual(c['limits']['truncated'], True)
        self.assertEqual(c['limits']['reason'], 'max_sessions')
        self.assertEqual(c['limits']['sessions_read'], 5)

    def test_bad_options(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(json_cmd.main(['efficiency', '--from', '2026-01-01']), 2)
            self.assertEqual(json_cmd.main(['efficiency', '--budget', 'lots']), 2)
            self.assertEqual(json_cmd.main(['efficiency', '--bogus']), 2)

    def test_disabled_agents_are_left_out(self):
        env = {'AGENT_SESSIONS_AGENTS': 'claude,codex', 'CODEX_HOME': os.path.join(self.tmp, 'codex'),
               'XDG_DATA_HOME': os.path.join(self.tmp, 'xdg')}
        with mock.patch.dict(os.environ, env), mock.patch('time.time', return_value=sc.NOW):
            out = json_output.efficiency_output(['codex', 'opencode'])
        self.assertEqual(list(out['agents']), ['codex'])
        self.assertEqual(out['agents']['codex']['totals']['calls'], 0)
        self.assertEqual(out['agents']['codex']['panes'], [])



class HitOutTest(unittest.TestCase):
    def test_e08_carries_the_masked_path_it_reads(self):
        from agentsessions.efficiency import excerpt
        hit = {'id': 'h-1', 'detector': 'E08', 'metrics': {'sessions': 3}, 'targets': ['/home/pat/vault/CLAUDE.md'],
               'read_path': '/home/pat/vault/docs/ref.md', '_contrib': {}}
        out = report._hit_out(hit, excerpt.Masker('/home/pat', '/home/pat/vault'))
        self.assertEqual(out['metrics']['shown_path'], 'docs/ref.md')
        self.assertEqual(out['shown_targets'], ['CLAUDE.md'])
        self.assertEqual(out['read_path'], '/home/pat/vault/docs/ref.md')
        self.assertNotIn('_contrib', out)


if __name__ == '__main__':
    unittest.main()

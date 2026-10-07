"""Codex and OpenCode: reading their records into calls, the detectors that apply to them, and
the per-provider panes of `json efficiency`."""

import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from agentsessions import config
from agentsessions.efficiency import cache, codex_read, detect, normalize, opencode_read, report, sources
from agentsessions.agents.opencode import db as oc_db
from tests.efficiency import builder as b
from tests.efficiency.fixtures import make_codex as mc
from tests.efficiency.fixtures import make_opencode as mo

NOW = 1790000000.0
DAY = 86400.0
HOUR = 3600.0


class _Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        patcher = mock.patch.object(config, 'RUNTIME_DIR', os.path.join(self.tmp, 'runtime'))
        patcher.start()
        self.addCleanup(patcher.stop)


# ---- Codex ----------------------------------------------------------------------------------

class CodexReadTest(_Tmp):
    def rollout(self, **kw) -> mc.Rollout:
        return mc.Rollout(mc.thread_id(1), NOW - DAY, **kw)

    def test_one_call_per_usage_record(self):
        r = self.rollout()
        r.turn('look at the parser', instructions='rule\n' * 10)
        r.call(ctx=20000, cached=15000, output=300, reasoning=100)
        r.call(ctx=26000, cached=24000, output=100, reasoning=0)
        rec = codex_read.read_file(r.write(self.tmp))
        self.assertEqual(len(rec['calls']), 2)
        c = rec['calls'][0]
        self.assertEqual((c['in'], c['cr'], c['cw'], c['out'], c['th'], c['ctx']), (5000, 15000, 0, 300, 100, 20000))
        self.assertEqual(c['model'], 'gpt-5.6-terra')
        self.assertEqual(c['provider'], 'openai')
        # Reasoning is part of Codex's output: not weighted twice.
        self.assertEqual(normalize.w_of(c), 5000 + 0.1 * 15000 + 5 * 300)
        self.assertEqual((rec['version'], rec['cwd'], rec['window']), ('0.160.1', mc.CWD, 258400))
        self.assertEqual([i['p'] for i in rec['preamble']['instr']], ['AGENTS.md'])

    def test_old_versions_use_last_token_usage_and_skip_repeated_totals(self):
        r = self.rollout(version='0.147.0', records=False)
        r.turn('look at the parser', new_style=False)
        r.call(ctx=20000, repeat_total=True)
        r.call(ctx=22000)
        rec = codex_read.read_file(r.write(self.tmp))
        self.assertEqual([c['ctx'] for c in rec['calls']], [20000, 22000])
        self.assertEqual(len(rec['prompts']), 1)

    def test_prompts_skip_injected_text_and_slash_commands_once_per_turn(self):
        r = self.rollout()
        r.turn('/model')
        r.call()
        r.turn('<environment_context>x</environment_context>')
        r.call()
        r.turn('fix the build please', after=600)
        r.call(after=10)
        rec = codex_read.read_file(r.write(self.tmp))
        self.assertEqual(len(rec['prompts']), 1)
        p = rec['prompts'][0]
        self.assertEqual(p['chars'], len('fix the build please'))
        self.assertGreater(p['gap'], 500)
        self.assertEqual(codex_read.prompt_text(rec['path'], p['off']), 'fix the build please')

    def test_tools_kinds_targets_and_results(self):
        r = self.rollout()
        r.turn('go')
        r.call(tools=[mc.Rollout.shell('c1', "sed -n '1,200p' src/app.py", 'x' * 4000),
                      mc.Rollout.shell('c2', 'rg -n parse src/lib', 'hits'),
                      mc.Rollout.shell('c3', 'npm test', 'boom', code=1),
                      mc.Rollout.patch('c4', 'src/app.py', 'old line', 'new line'),
                      mc.Rollout.code('c5', 'const r = await tools.web__run({}); text(r)', 'w' * 100)])
        rec = codex_read.read_file(r.write(self.tmp))
        tools = rec['calls'][0]['tools']
        self.assertEqual([(t['n'], t['k'], t['p']) for t in tools],
                         [('exec_command', 'read', 'src/app.py'), ('exec_command', 'search', 'src/lib'),
                          ('exec_command', 'exec', None), ('apply_patch', 'edit', 'src/app.py'), ('exec', 'web', None)])
        edit = rec['calls'][0]['edits'][0]
        self.assertEqual((edit['p'], edit['o'], edit['n']),
                         ('src/app.py', normalize.short_hash('old line'), normalize.short_hash('new line')))
        results = {x['tu']: x for x in rec['results']}
        self.assertEqual(results['c3']['err'], True)
        self.assertEqual(results['c1']['err'], False)
        self.assertGreater(results['c1']['est'], 1000)
        self.assertEqual(codex_read.command_text(rec['path'], tools[2]), 'npm test')
        # Nothing of the text is kept in the record.
        self.assertNotIn('npm test', json.dumps(rec))

    def test_compaction_and_interruption(self):
        r = self.rollout()
        r.turn('go')
        r.call()
        r.abort()
        r.compaction()
        rec = codex_read.read_file(r.write(self.tmp))
        self.assertEqual([e['k'] for e in rec['events']], ['interrupt', 'compaction'])

    def test_subagent_rollout_joins_its_parent(self):
        home = os.path.join(self.tmp, 'codex')
        parent = mc.Rollout(mc.thread_id(1), NOW - HOUR)
        parent.turn('go')
        parent.call()
        parent.write(home)
        child = mc.Rollout(mc.thread_id(2), NOW - HOUR + 10,
                           source={'subagent': {'thread_spawn': {'parent_thread_id': mc.thread_id(1), 'depth': 1}}})
        child.call()
        child.call()
        child.write(home)
        src = sources.CodexSource(home)
        sessions, _ = src.read(NOW, NOW - DAY, 10, cache.Reader(NOW, folder=os.path.join(self.tmp, 'c')))
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sorted({c['chain_kind'] for c in sessions[0]['calls']}), ['main', 'subagent'])
        self.assertEqual(len(sessions[0]['calls']), 3)

    def test_command_kind(self):
        self.assertEqual(codex_read.command_kind("bash -lc 'cat docs/a.md'"), ('read', 'docs/a.md'))
        self.assertEqual(codex_read.command_kind('git log --oneline'), ('search', None))
        self.assertEqual(codex_read.command_kind('python3 -m pytest'), ('exec', None))
        self.assertEqual(codex_read.command_kind(''), ('exec', None))


class CodexDetectTest(_Tmp):
    def run_build(self, rollouts, **kw):
        home = os.path.join(self.tmp, 'codex')
        for r in rollouts:
            r.write(home)
        with open(os.path.join(home, 'config.toml'), 'w') as f:
            f.write('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\n\n[tui]\nmodel = "nope"\n')
        return report.build_for(NOW, sources.CodexSource(home), vault='/work', **kw)

    def test_cache_expiry_uses_the_model_retention(self):
        r = mc.Rollout(mc.thread_id(1), NOW - 5 * HOUR)
        r.turn('go')
        r.call(ctx=60000)
        r.call(ctx=62000, cached=1000, after=40 * 60)       # 40 minutes: past gpt-5.6's 30
        r.call(ctx=63000)
        r.call(ctx=64000, cached=1000, after=20 * 60)       # 20 minutes: within it
        block = self.run_build([r])
        e04 = [h for h in block['hits'] if h['detector'] == 'E04']
        self.assertEqual(len(e04), 1)
        self.assertEqual(e04[0]['metrics']['ttl'], 1800)
        self.assertEqual(e04[0]['remedy_kind'], 'habit')
        self.assertEqual(e04[0]['agent'], 'codex')
        self.assertEqual(e04[0]['impact_w'], round(61000 * 0.9))
        self.assertEqual(detect.codex_retention('gpt-5.2-codex'), 300)
        self.assertEqual(detect.codex_retention('gpt-6-luna'), 1800)

    def test_model_switch_with_a_cache_break_is_e05(self):
        r = mc.Rollout(mc.thread_id(1), NOW - 5 * HOUR)
        r.turn('go')
        r.call(ctx=60000)
        r.turn('more', model='gpt-5.6-luna', after=30)
        r.call(ctx=62000, cached=0)
        block = self.run_build([r])
        e05 = [h for h in block['hits'] if h['detector'] == 'E05']
        self.assertEqual([(h['metrics']['from'], h['metrics']['to']) for h in e05], [('gpt-5.6-terra', 'gpt-5.6-luna')])

    def test_large_results_and_the_agents_md_owner(self):
        repo = os.path.join(self.tmp, 'repo')
        os.makedirs(os.path.join(repo, '.git'))
        r = mc.Rollout(mc.thread_id(1), NOW - 5 * HOUR, cwd=repo)
        r.turn('go')
        for i in range(3):
            r.call(tools=[mc.Rollout.shell('t%d' % i, 'npm test', 'x' * 40000)])
            for _ in range(4):
                r.call()
        block = self.run_build([r])
        e01 = [h for h in block['hits'] if h['detector'] == 'E01']
        self.assertEqual(len(e01), 3)
        self.assertEqual({tuple(h['targets']) for h in e01}, {(os.path.join(repo, 'AGENTS.md'),)})
        self.assertTrue(all(h['remedy_kind'] == 'fix' and h['change'] == 'add' for h in e01))
        self.assertIsNotNone(e01[0]['impact_usd'])      # gpt-5.6-terra has a price

    def test_range_on_a_monthly_window_and_the_pane(self):
        r = mc.Rollout(mc.thread_id(1), NOW - 2 * HOUR)
        r.turn('go')
        r.call()
        block = self.run_build([r])
        self.assertEqual(block['range']['rule'], 'budget')
        self.assertEqual([(p['key'], p['provider'], p['model'], p['models'], p['local']) for p in block['panes']],
                         [('codex-openai', 'openai', 'gpt-5.6-sol', ['gpt-5.6-sol'], False)])

    def test_analysis_model_is_the_strongest_listed_tier(self):
        r = mc.Rollout(mc.thread_id(1), NOW - 2 * HOUR)
        r.turn('go')
        r.call()
        home = os.path.join(self.tmp, 'codex')
        os.makedirs(home)
        cache_rows = [('gpt-6-luna', 'list', 4), ('gpt-reserve', 'list', 4), ('gpt-6-sol', 'hide', 2),
                      ('gpt-5.6-terra', 'list', 8), ('gpt-5.6-luna', 'list', 9)]
        with open(os.path.join(home, 'models_cache.json'), 'w') as f:
            json.dump({'models': [{'slug': s, 'visibility': v, 'priority': p} for s, v, p in cache_rows]}, f)
        block = self.run_build([r])
        pane = block['panes'][0]
        # Sol is hidden for this account: Terra first, then the Luna models newest first, then
        # config.toml's model.
        self.assertEqual(pane['models'], ['gpt-5.6-terra', 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.6-sol'])
        self.assertEqual(pane['model'], 'gpt-5.6-terra')
        with open(os.path.join(home, 'models_cache.json'), 'w') as f:
            json.dump({'models': [{'slug': 'gpt-6-sol', 'visibility': 'list', 'priority': 2},
                                  {'slug': 'gpt-6-luna', 'visibility': 'list', 'priority': 4}]}, f)
        self.assertEqual(self.run_build([r])['panes'][0]['models'], ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol'])

    def test_a_local_provider_uses_its_most_used_model(self):
        r = mc.Rollout(mc.thread_id(1), NOW - 2 * HOUR, model='gpt-oss:20b', provider='ollama')
        r.turn('go')
        r.call()
        pane = self.run_build([r])['panes'][0]
        self.assertEqual((pane['key'], pane['model'], pane['models'], pane['local']),
                         ('codex-ollama', 'gpt-oss:20b', ['gpt-oss:20b'], True))

    def test_unpriced_model(self):
        r = mc.Rollout(mc.thread_id(1), NOW - 2 * HOUR, model='gpt-9-unknown')
        r.turn('go')
        r.call()
        block = self.run_build([r])
        self.assertIsNone(block['totals']['usd'])
        self.assertEqual(block['totals']['unpriced_calls'], 1)

    def test_language_does_not_change_tasks_or_hits(self):
        outcomes = []
        for lang in ('en', 'ja', 'es'):
            shutil.rmtree(os.path.join(self.tmp, 'codex'), ignore_errors=True)
            shutil.rmtree(os.path.join(self.tmp, 'runtime'), ignore_errors=True)
            rollouts = []
            for i in range(60):
                r = mc.Rollout(mc.thread_id(100 + i), NOW - 13 * DAY + i * 4 * HOUR)
                for j in range(2):
                    r.turn(b.text_of(lang, 60), after=90 if j else 1)
                    r.call(tools=[mc.Rollout.shell('r%d%d' % (i, j), 'cat notes/n%d.md' % i)])
                    r.call()
                rollouts.append(r)
            s = mc.Rollout(mc.thread_id(999), NOW - 2 * DAY)
            s.turn(b.text_of(lang, 60))
            s.call(tools=[mc.Rollout.patch('p1', 'src/a.py', 'a0', 'a1')])
            s.turn(b.SHORT[lang], after=60)
            s.call(tools=[mc.Rollout.patch('p2', 'src/a.py', 'a1', 'a0')])
            for _ in range(12):
                s.call(after=5)
            rollouts.append(s)
            block = self.run_build(rollouts, budget=1e12)
            outcomes.append(([(t['id'], t['turns'], t['corrections'], t['reverts']) for t in block['tasks']],
                             [(h['id'], h['detector'], h['impact_w']) for h in block['hits']],
                             block['baselines']['disabled']))
        self.assertEqual(outcomes[0], outcomes[1])
        self.assertEqual(outcomes[0], outcomes[2])
        self.assertIn('E16', [h[1] for h in outcomes[0][1]])


# ---- OpenCode -------------------------------------------------------------------------------

class OpencodeTest(_Tmp):
    def setUp(self):
        super().setUp()
        self.path = os.path.join(self.tmp, 'opencode.db')
        self.conn = mo.create(self.path)
        self.addCleanup(self.conn.close)
        self.config = os.path.join(self.tmp, 'opencode.json')
        with open(self.config, 'w') as f:
            json.dump({'provider': {'mybox': {'options': {'baseURL': 'http://127.0.0.1:8080/v1'}}}}, f)

    def source(self) -> sources.OpencodeSource:
        return sources.OpencodeSource(db_path=self.path, home=self.tmp, config_path=self.config)

    def read_one(self, sid: str) -> dict:
        d = oc_db.open_db(self.path)
        try:
            row = next(r for r in opencode_read.list_sessions(d, 0) if r['id'] == sid)
            return opencode_read.read_session(d, row, self.tmp)
        finally:
            d.close()

    def test_steps_tokens_reasoning_and_tools(self):
        s = mo.Session(self.conn, 'ses_a', NOW - HOUR, cwd='/work/repo')
        s.prompt('read the parser')
        s.reply()
        s.step(tools=[mo.Session.tool('read', {'filePath': '/work/repo/src/p.py'}, 'x' * 3000),
                      mo.Session.tool('edit', {'filePath': '/work/repo/src/p.py', 'oldString': 'a', 'newString': 'b'}),
                      mo.Session.tool('bash', {'command': 'npm test'}, 'fail', status='error'),
                      mo.Session.tool('pencil_open', {})],
               ctx=40000, write=1000, output=300, reasoning=700, cost=0.01)
        s.save()
        rec = self.read_one('ses_a')
        c = rec['calls'][0]
        self.assertEqual((c['in'], c['cr'], c['cw'], c['out'], c['rs'], c['ctx'], c['usd']),
                         (3, 38997, 1000, 300, 700, 40000, 0.01))
        self.assertEqual(normalize.w_of(c), 3 + 1.25 * 1000 + 0.1 * 38997 + 5 * (300 + 700))
        self.assertEqual([(t['k'], t['p']) for t in c['tools']],
                         [('read', 'src/p.py'), ('edit', 'src/p.py'), ('exec', None), ('mcp', None)])
        self.assertEqual(c['edits'][0]['o'], normalize.short_hash('a'))
        self.assertEqual([r['err'] for r in rec['results']], [False, False, True, False])
        self.assertEqual(rec['provider'], 'anthropic')
        d = oc_db.open_db(self.path)
        try:
            self.assertEqual(opencode_read.prompt_text(d, rec['prompts'][0]['off']), 'read the parser')
            self.assertEqual(opencode_read.reply_text(d, c['text_off']), 'ok')
            self.assertEqual(opencode_read.command_text(d, c['tools'][2]), 'npm test')
        finally:
            d.close()

    def test_compaction_abort_and_child_sessions(self):
        s = mo.Session(self.conn, 'ses_a', NOW - HOUR)
        s.prompt('go')
        s.reply(error='MessageAbortedError')
        s.step()
        s.compaction()
        s.save()
        child = mo.Session(self.conn, 'ses_b', NOW - HOUR + 30, parent='ses_a')
        child.prompt('sub task')
        child.reply()
        child.step()
        child.save()
        rec = self.read_one('ses_a')
        self.assertEqual(sorted(e['k'] for e in rec['events']), ['compaction', 'interrupt'])
        sessions, _ = self.source().read(NOW, NOW - DAY, 10, cache.Reader(NOW, folder=os.path.join(self.tmp, 'c')))
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sorted({c['chain_kind'] for c in sessions[0]['calls']}), ['main', 'subagent'])

    def test_agent_switch_with_a_cache_break_is_e05(self):
        s = mo.Session(self.conn, 'ses_a', NOW - HOUR)
        s.prompt('plan it')
        s.reply(agent='plan')
        s.step(ctx=50000, write=500)
        s.prompt('now do it', after=30)
        s.reply(agent='build')
        s.step(ctx=52000, write=51000)
        s.step(ctx=53000, write=50000, after=4000)      # a long pause: no E04 for OpenCode
        s.save()
        block = report.build_for(NOW, self.source(), vault='/work')
        e05 = [h for h in block['hits'] if h['detector'] == 'E05']
        self.assertEqual([(h['metrics']['kind'], h['metrics']['from'], h['metrics']['to']) for h in e05],
                         [('agent', 'plan', 'build')])
        self.assertEqual([h for h in block['hits'] if h['detector'] == 'E04'], [])
        self.assertIsNone(e05[0]['impact_usd'])

    def test_panes_per_provider_keep_each_providers_sessions_apart(self):
        a = mo.Session(self.conn, 'ses_cloud', NOW - 3 * HOUR, provider='anthropic', model='claude-sonnet-5')
        a.prompt('cloud work')
        a.reply()
        for _ in range(3):
            a.step()
        a.save(title='cloud title')
        for i, (prov, model) in enumerate([('ollama', 'big-local'), ('ollama', 'big-local'), ('ollama', 'small-local'),
                                          ('mybox', 'box-model')]):
            l = mo.Session(self.conn, 'ses_local%d' % i, NOW - 2 * HOUR + i * 60, provider=prov, model=model)
            l.prompt('local work')
            l.reply()
            l.step()
            l.save(title='local title %d' % i)
        names = {'ses_cloud': 'Cloud title', 'ses_local0': 'Secret local title'}
        block = report.build_for(NOW, self.source(), vault='/work', names=names)
        panes = {p['provider']: p for p in block['panes']}
        self.assertEqual(sorted(panes), ['anthropic', 'mybox', 'ollama'])
        self.assertEqual((panes['ollama']['key'], panes['ollama']['model'], panes['ollama']['local']),
                         ('opencode-ollama', 'big-local', True))
        self.assertTrue(panes['mybox']['local'])
        self.assertFalse(panes['anthropic']['local'])
        cloud_sent = json.dumps([panes['anthropic']['summary'], panes['anthropic']['excerpts']])
        self.assertNotIn('Secret local title', cloud_sent)
        self.assertNotIn('ses_local', cloud_sent)
        self.assertEqual(panes['anthropic']['sessions'], 1)
        self.assertEqual(panes['ollama']['sessions'], 3)

    def test_cache_by_session_and_update_time(self):
        s = mo.Session(self.conn, 'ses_a', NOW - HOUR)
        s.prompt('go')
        s.reply()
        s.step()
        s.save()
        report.build_for(NOW, self.source())
        folder = cache.cache_dir('opencode')
        files = os.listdir(folder)
        self.assertEqual(len(files), 1)
        with open(os.path.join(folder, files[0])) as f:
            self.assertNotIn('go', json.load(f)['record']['prompts'][0].values())
        block = report.build_for(NOW, self.source())
        self.assertEqual(block['limits']['cache_hits'], 1)
        # A session that is gone leaves the cache.
        self.conn.execute('DELETE FROM session')
        self.conn.commit()
        report.build_for(NOW, self.source())
        self.assertEqual(os.listdir(folder), [])


class RangeTest(unittest.TestCase):
    def test_another_window_length(self):
        windows = {'five_hour': {'start': None, 'used_percentage': None},
                   'window_43200m': {'start': NOW - 20 * DAY, 'used_percentage': 90, 'minutes': 43200}}
        r = report.choose_range(NOW, windows, [], 80, 1e7)
        self.assertEqual((r['rule'], r['start'], r['used_percentage']), ('window_43200m', NOW - 7 * DAY, 90))
        windows['window_43200m']['used_percentage'] = 10
        self.assertEqual(report.choose_range(NOW, windows, [], 80, 1e7)['rule'], 'budget')


class OwnerTest(unittest.TestCase):
    def test_agents_md_owner(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        os.makedirs(os.path.join(tmp, 'sub', 'deep'))
        open(os.path.join(tmp, 'sub', 'AGENTS.md'), 'w').close()
        self.assertEqual(detect.owner_instructions(os.path.join(tmp, 'sub', 'deep', 'x.py'), name='AGENTS.md'),
                         os.path.join(tmp, 'sub', 'AGENTS.md'))
        self.assertEqual(detect.instruction_name({'agent': 'opencode'}), 'AGENTS.md')
        self.assertEqual(detect.instruction_name({}), 'CLAUDE.md')

    def test_codex_config_model(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        with open(os.path.join(tmp, 'config.toml'), 'w') as f:
            f.write('# c\nmodel = "gpt-6-luna"\nmodel_provider = "ollama"\n[x]\nmodel = "no"\n')
        self.assertEqual(sources.codex_config_model(tmp), ('gpt-6-luna', 'ollama'))
        self.assertEqual(sources.codex_config_model(os.path.join(tmp, 'none')), (None, None))

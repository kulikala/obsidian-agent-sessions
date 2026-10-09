import os
import shutil
import tempfile
import unittest

from agentsessions.efficiency import detect, impact, tasks
from tests.efficiency import builder as b
from tests.efficiency import scenario as sc
from tests.efficiency.test_tasks import load

RANGE = (sc.NOW - 7 * sc.DAY, sc.NOW)


def run(root, rng=RANGE, base=None):
    sessions = load(root)
    if base is None:
        base = tasks.baselines(sessions, sc.NOW)
    analysed = [{'session': s, 'tasks': tasks.session_tasks(s, base, rng, everything=True)}
                for s in sessions]
    hits, _collisions = detect.run(analysed, base, rng)
    return hits


def of(hits, detector):
    return [h for h in hits if h['detector'] == detector]


class DetectorTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)
        self.n = 0

    def session(self, start=None, cwd=b.CWD, **kw):
        self.n += 1
        t = b.Transcript(b.session_uuid(self.n), start or sc.NOW - sc.DAY + self.n * 3600, cwd=cwd, **kw)
        return t

    def save(self, t):
        t.write(os.path.join(b.project_dir(self.root, t.cwd), t.session + '.jsonl'))

    # ---- E01
    def big_output(self, t, reads_after, command='npm test'):
        t.prompt('run the tests')
        tool = t.tool('Bash', command=command)
        t.call(tools=[tool])
        t.result(tool, 'y' * 40000)                     # 10,000 estimated tokens
        for _ in range(reads_after):
            t.call()

    def test_e01_large_result_read_again(self):
        t = self.session()
        self.big_output(t, 5)
        self.save(t)
        [h] = of(run(self.root), 'E01')
        self.assertEqual(h['metrics']['reads_after'], 5)
        self.assertEqual(h['impact_w'], 10000 * 5 * 0.1)
        self.assertEqual(h['saving_rate'], 0.8)
        self.assertEqual(h['remedy_kind'], 'habit')
        self.assertFalse(h['needs_llm'])

    def test_e01_guard_session_ends_soon(self):
        t = self.session()
        self.big_output(t, 2)
        self.save(t)
        self.assertEqual(of(run(self.root), 'E01'), [])

    def test_e01_guard_compaction_cuts_r(self):
        t = self.session()
        self.big_output(t, 1)
        t.compaction()
        for _ in range(5):
            t.call()
        self.save(t)
        self.assertEqual(of(run(self.root), 'E01'), [])

    def test_e01_repeated_command_is_a_fix(self):
        for _ in range(3):
            t = self.session()
            self.big_output(t, 4, command='npm test -- --all')
            self.save(t)
        hits = of(run(self.root), 'E01')
        self.assertEqual(len(hits), 3)
        for h in hits:
            self.assertEqual((h['remedy_kind'], h['change'], h['targets']),
                             ('fix', 'add', ['/work/vault/CLAUDE.md']))

    def test_e01_fix_goes_to_the_repository_worked_on(self):
        vault = os.path.join(self.root, 'v')
        repo = os.path.join(self.root, 'repo')
        os.makedirs(os.path.join(repo, '.git'))
        os.makedirs(vault)
        open(os.path.join(vault, 'CLAUDE.md'), 'w').close()
        for _ in range(3):
            t = self.session(cwd=vault)
            t.read(os.path.join(repo, 'src', 'app.py'))
            self.big_output(t, 4, command='npm test -- --all')
            self.save(t)
        hits = of(run(self.root), 'E01')
        self.assertEqual(len(hits), 3)
        self.assertEqual({tuple(h['targets']) for h in hits}, {(os.path.join(repo, 'CLAUDE.md'),)})

    # ---- E02
    def test_e02_large_context(self):
        t = self.session()
        t.prompt('continue')
        for _ in range(12):
            t.call(ctx=700_000)
        self.save(t)
        [h] = of(run(self.root), 'E02')
        self.assertEqual(h['metrics']['threshold'], 600_000)
        self.assertEqual(h['impact_w'], round(12 * 500_000 * 0.1))
        self.assertEqual(h['confidence'], 'medium')

    def test_e02_guard_few_calls_and_rewriting_lowers_confidence(self):
        t = self.session()
        t.prompt('continue')
        for _ in range(9):
            t.call(ctx=700_000)
        self.save(t)
        self.assertEqual(of(run(self.root), 'E02'), [])
        t2 = self.session()
        t2.prompt('continue')
        for i in range(12):
            t2.edit('/work/vault/big.py', 'v%d' % i, 'v%d' % (i + 1), ctx=700_000)
        self.save(t2)
        [h] = of(run(self.root), 'E02')
        self.assertEqual(h['confidence'], 'low')

    # ---- E03
    def three_tasks(self, t, carry=150_000, share=False, compact=False):
        t.prompt('first job')
        t.edit('/work/vault/one.py', 'a', 'b', ctx=carry - 1000)
        if compact:
            t.compaction(after=3600)
        t.prompt('second job', after=2 * 3600)
        t.read('/work/vault/two.py', ctx=carry)
        t.call(ctx=carry)
        t.prompt('third job', after=2 * 3600)
        t.read('/work/vault/one.py' if share else '/work/vault/three.py', ctx=carry + 5000)

    def test_e03_unrelated_tasks_in_one_conversation(self):
        t = self.session()
        self.three_tasks(t)
        self.save(t)
        hits = of(run(self.root), 'E03')
        self.assertEqual(len(hits), 2)
        self.assertTrue(all(h['needs_llm'] for h in hits))
        self.assertEqual(hits[0]['metrics']['tasks'], 3)

    def test_e03_guards(self):
        t = self.session()
        self.three_tasks(t, share=True)
        self.save(t)
        self.assertEqual(len(of(run(self.root), 'E03')), 1)     # the third goes back to the first's file
        shutil.rmtree(self.root)
        os.makedirs(self.root)
        t = self.session()
        self.three_tasks(t, compact=True)
        self.save(t)
        self.assertEqual(of(run(self.root), 'E03'), [])

    # ---- E04 / E05
    def test_e04_cache_expired_over_a_pause(self):
        t = self.session()
        t.prompt('start')
        t.call(ctx=80_000, fresh=True)                   # the first write: never a hit
        t.call(ctx=81_000)
        t.prompt('back again', after=2 * 3600)
        t.call(ctx=82_000, fresh=True)
        self.save(t)
        [h] = of(run(self.root), 'E04')
        self.assertEqual(h['metrics']['ttl'], 3600)
        self.assertEqual(h['impact_w'], round((82_000 - 3) * 1.9))
        self.assertEqual(h['remedy_kind'], 'habit')

    def test_e04_guards(self):
        t = self.session()
        t.prompt('start')
        t.call(ctx=80_000, fresh=True)
        t.prompt('half an hour later', after=1800)
        t.call(ctx=81_000, fresh=True)                   # within the one-hour TTL
        t.prompt('after compaction', after=2 * 3600)
        t.compaction()
        t.call(ctx=30_000, fresh=True)
        self.save(t)
        self.assertEqual(of(run(self.root), 'E04'), [])

    def test_e04_short_ttl_repeats_suggest_the_setting(self):
        t = self.session()
        t.ttl_1h = False
        t.prompt('start')
        t.call(ctx=80_000, fresh=True)
        for _ in range(3):
            t.prompt('later', after=20 * 60)
            t.call(ctx=80_000, fresh=True)
        self.save(t)
        hits = of(run(self.root), 'E04')
        self.assertEqual(len(hits), 3)
        self.assertEqual({h['remedy_kind'] for h in hits}, {'fix'})
        self.assertEqual(hits[0]['targets'], [os.path.expanduser('~/.claude/settings.json')])

    def test_e04_not_while_waiting_for_others(self):
        t = self.session()
        t.prompt('start')
        t.call(ctx=80_000, fresh=True)
        t.spawn('helper1')
        start_sub = t.t
        t.wait(2 * 3600)
        t.call(ctx=82_000, fresh=True)                   # the main chain waited for the sub-agent
        self.save(t)
        sub = b.Transcript(t.session, start_sub + 60, agent_id='helper1')
        for _ in range(3):
            sub.call(after=1800)
        sub.write(os.path.join(b.project_dir(self.root), t.session, 'subagents', 'agent-helper1.jsonl'))
        mate = b.Transcript(t.session, start_sub, agent_id='mate1')
        mate.raw_user('<teammate-message teammate_id="lead">wait</teammate-message>')
        mate.call(ctx=50_000, fresh=True)
        mate.call(ctx=51_000, fresh=True, after=3600)    # a teammate idle for an hour
        mate.write(os.path.join(b.project_dir(self.root), t.session, 'subagents', 'agent-mate1.jsonl'))
        self.assertEqual(of(run(self.root), 'E04'), [])

    def test_e05_model_change_rewrites_the_cache(self):
        t = self.session()
        t.prompt('start')
        t.call(ctx=80_000, fresh=True)
        t.prompt('switch', after=30)
        t.call(ctx=81_000, fresh=True, model='claude-sonnet-5')
        t.prompt('effort only', after=30)
        t.call(ctx=82_000, model='claude-sonnet-5', effort='low')   # no cache break: not a hit
        self.save(t)
        hits = run(self.root)
        [h] = of(hits, 'E05')
        self.assertEqual(h['metrics']['kind'], 'model')
        self.assertEqual(of(hits, 'E04'), [])

    def test_e05_round_trips_count_once(self):
        t = self.session()
        t.prompt('start')
        t.call(ctx=80_000, fresh=True)
        for model in ('claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-5'):
            t.call(ctx=80_000, fresh=True, model=model)
        self.save(t)
        [h] = of(run(self.root), 'E05')
        self.assertEqual(h['metrics']['switches'], 3)

    # ---- E08
    def test_e08_same_reads_every_session(self):
        vault = os.path.join(self.root, 'v')
        repo = os.path.join(self.root, 'repo')
        os.makedirs(os.path.join(repo, '.git'))
        os.makedirs(vault)
        open(os.path.join(vault, 'CLAUDE.md'), 'w').close()
        for _ in range(3):
            t = self.session(cwd=vault)
            t.prompt('hello')
            t.read(os.path.join(vault, 'CLAUDE.md'), size=12000)       # the instruction file itself
            t.read(os.path.join(repo, 'docs', 'design.md'), size=12000)
            t.read(os.path.join(vault, 'notes', 'index.md'), size=12000)
            t.call()
            self.save(t)
        hits = of(run(self.root), 'E08')
        targets = sorted(h['targets'][0] for h in hits)
        self.assertEqual(targets, [os.path.join(repo, 'CLAUDE.md'), os.path.join(vault, 'CLAUDE.md')])
        outside = next(h for h in hits if h['targets'][0].startswith(repo))
        self.assertTrue(outside['metrics']['outside_cwd'])
        self.assertEqual(outside['read_path'], os.path.join(repo, 'docs', 'design.md'))
        self.assertEqual(outside['metrics']['sessions'], 3)

    def test_e08_guards(self):
        for _ in range(2):
            t = self.session()
            t.prompt('hello')
            t.read('/work/vault/ref.md', size=8000)
            self.save(t)
        t = self.session()
        t.prompt('hello')
        t.read('/work/vault/ref.md', size=400)                        # small read
        self.save(t)
        self.assertEqual(of(run(self.root), 'E08'), [])

    # ---- E14
    def preamble_session(self, ctx, version=b.VERSION, first='hello', lines=40):
        t = self.session(version=version)
        t.preamble(instr_lines=lines)
        t.prompt(first)
        t.call(ctx=ctx, fresh=True)
        for _ in range(4):
            t.call(ctx=ctx + 1000)
        self.save(t)
        return t

    def test_e14_preamble_above_the_usual(self):
        for _ in range(3):
            self.preamble_session(50_000)
        big = self.preamble_session(75_000, lines=300)
        [h] = of(run(self.root), 'E14')
        self.assertEqual(h['session'], big.session)
        self.assertEqual((h['metrics']['baseline'], h['metrics']['excess']), (50_000, 25_000))
        self.assertEqual(h['impact_w'], 25_000 * 5 * 0.1)
        self.assertEqual((h['remedy_kind'], h['change']), ('fix', 'move'))
        self.assertEqual(h['targets'], ['/work/vault/CLAUDE.md', '/work/vault/CLAUDE.reference.md'])

    def test_e14_guards(self):
        for _ in range(3):
            self.preamble_session(50_000)
        self.preamble_session(75_000, version='2.1.999')            # no peers on its version
        self.preamble_session(55_000)                               # usual
        self.preamble_session(75_000, first='z' * 6000)             # long first prompt
        self.assertEqual(of(run(self.root), 'E14'), [])

    # ---- E16
    def test_e16_correction_round_trips(self):
        sc.history(self.root, 'en', heavy=True)
        hits = run(self.root)
        [h] = of(hits, 'E16')
        self.assertTrue(h['needs_llm'])
        self.assertEqual(h['metrics']['corrections'], 2)
        self.assertEqual(h['session'], sc.SCENARIO)
        self.assertNotIn('E16', [x['cause'] for x in impact.breakdown(
            [c for s in load(self.root) for c in s['calls']], hits)])

    def test_e16_guards(self):
        sc.history(self.root, 'en', heavy=False)                    # too few calls
        self.assertEqual(of(run(self.root), 'E16'), [])
        shutil.rmtree(self.root)
        os.makedirs(self.root)
        sc.baseline_sessions(self.root, 'en', count=20)
        sc.scenario(self.root, 'en', heavy=True)                    # too few prompts: stopped
        self.assertEqual(of(run(self.root), 'E16'), [])

    # ---- E17
    def few_clues_session(self, lang, first):
        t = b.Transcript(sc.SCENARIO, sc.NOW - 2 * sc.DAY)
        t.prompt(first)
        t.edit('/work/vault/src/a.py', 'a0', 'a1')
        t.prompt(b.SHORT[lang], after=60)               # rework: short, soon, the same file
        t.edit('/work/vault/src/a.py', 'a1', 'a2')
        t.write(os.path.join(b.project_dir(self.root), sc.SCENARIO + '.jsonl'))

    def test_e17_short_first_request_then_rework(self):
        sc.baseline_sessions(self.root, 'en')
        self.few_clues_session('en', b.SHORT['en'])
        [h] = of(run(self.root), 'E17')
        self.assertTrue(h['needs_llm'])
        self.assertEqual(h['session'], sc.SCENARIO)
        self.assertEqual(h['metrics']['corrections'], 1)
        self.assertGreater(h['impact_w'], 0)

    def test_e17_guards(self):
        sc.baseline_sessions(self.root, 'en')
        self.few_clues_session('en', b.text_of('en', sc.LONG))     # an ordinary first request
        self.assertEqual(of(run(self.root), 'E17'), [])
        shutil.rmtree(self.root)
        os.makedirs(self.root)
        sc.baseline_sessions(self.root, 'en', count=20)             # too few starts: stopped
        self.few_clues_session('en', b.SHORT['en'])
        self.assertEqual(of(run(self.root), 'E17'), [])

    def test_e17_same_in_every_language(self):
        found = []
        for lang in ('en', 'ja', 'es'):
            self.root = os.path.join(tempfile.mkdtemp(), lang)
            self.addCleanup(shutil.rmtree, os.path.dirname(self.root))
            sc.baseline_sessions(self.root, lang)
            self.few_clues_session(lang, b.SHORT[lang])
            found.append([(h['id'], h['impact_w']) for h in of(run(self.root), 'E17')])
        self.assertEqual(len(found[0]), 1)
        self.assertEqual(found[0], found[1])
        self.assertEqual(found[0], found[2])

    # ---- language
    def test_three_languages_give_the_same_hits(self):
        results = []
        for lang in ('en', 'ja', 'es'):
            root = os.path.join(self.root, lang)
            sc.history(root, lang, heavy=True)
            hits = run(root)
            self.assertTrue(hits)
            results.append([(h['id'], h['detector'], h['task'], h['impact_w'], h['needs_llm'])
                            for h in hits])
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0], results[2])


class BreakdownTest(unittest.TestCase):
    def test_each_call_goes_to_its_largest_cause(self):
        calls = [{'chain': 'main', 'id': 'a', 'chain_kind': 'main', 'in': 100, 'cw': 0, 'cw1h': 0, 'cr': 0, 'out': 0},
                 {'chain': 'main', 'id': 'b', 'chain_kind': 'main', 'in': 50, 'cw': 0, 'cw1h': 0, 'cr': 0, 'out': 0},
                 {'chain': 'x', 'id': 'c', 'chain_kind': 'teammate', 'in': 10, 'cw': 0, 'cw1h': 0, 'cr': 0, 'out': 0}]
        hits = [{'detector': 'E01', 'needs_llm': False, '_contrib': {'main\0a': 5}},
                {'detector': 'E02', 'needs_llm': False, '_contrib': {'main\0a': 9}},
                {'detector': 'E16', 'needs_llm': True, '_contrib': {'main\0b': 50}}]
        self.assertEqual(impact.breakdown(calls, hits),
                         [{'cause': 'E02', 'w': 100}, {'cause': 'other', 'w': 50}, {'cause': 'team', 'w': 10}])


if __name__ == '__main__':
    unittest.main()

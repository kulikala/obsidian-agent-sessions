import glob
import json
import os
import shutil
import tempfile
import unittest

from agentsessions.efficiency import normalize, tasks
from agentsessions.sessions import activity
from tests.efficiency import builder as b
from tests.efficiency import scenario as sc


def load(root):
    out = []
    for path in sorted(glob.glob(os.path.join(root, '*', '*.jsonl'))):
        subs = [normalize.read_file(p) for p in activity.subagent_files(path)]
        out.append(tasks.assemble(normalize.read_file(path), subs))
    return out


def analyse(root, rng=(sc.NOW - 7 * sc.DAY, sc.NOW)):
    sessions = load(root)
    base = tasks.baselines(sessions, sc.NOW)
    scen = next(s for s in sessions if s['id'] == sc.SCENARIO)
    return base, tasks.session_tasks(scen, base, rng)


def shape(task_list):
    """Language-free summary: turn indices per task and rework rules per prompt."""
    return [(t['id'], t['turn_idx'], [(p['ref'], p['rework']) for p in t['prompts']])
            for t in task_list]


class TasksTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)

    def test_boundaries_and_rework(self):
        uuids = sc.history(self.root, 'en')
        base, ts = analyse(self.root)
        self.assertEqual(base['disabled'], [])
        self.assertEqual([t['turn_idx'] for t in ts], [[0, 1, 2, 3, 4], [5, 6, 7, 8], [9]])
        rework = {p['turn']: p['rework'] for t in ts for p in t['prompts']}
        self.assertEqual(rework, {0: [], 1: [1], 2: [], 3: [], 4: [], 5: [], 6: [1, 2], 7: [3],
                                  8: [], 9: []})
        self.assertEqual(ts[0]['id'], tasks.task_id(sc.SCENARIO, uuids['A']))
        self.assertEqual(ts[1]['reverts'], 1)
        self.assertEqual(ts[1]['interrupts'], 1)
        self.assertEqual(ts[1]['corrections'], 2)
        self.assertEqual(ts[0]['max_rewrites'], 4)
        self.assertEqual(ts[0]['prompts'][1]['ref'], ts[0]['id'] + '.p2')

    def test_three_languages_give_the_same_tasks(self):
        shapes = []
        for lang in ('en', 'ja', 'es'):
            root = os.path.join(self.root, lang)
            sc.history(root, lang)
            base, ts = analyse(root)
            self.assertEqual(base['disabled'], [])
            # every prompt is far from the 0.5 x L_med edge (outside +-20%)
            for t in ts:
                for p in t['prompts']:
                    ratio = p['est'] / base['L_med']
                    self.assertTrue(ratio <= 0.4 or ratio >= 0.6, (lang, ratio))
            shapes.append(shape(ts))
        self.assertEqual(shapes[0], shapes[1])
        self.assertEqual(shapes[0], shapes[2])

    def test_ids_do_not_change_when_lines_are_added(self):
        sc.history(self.root, 'en')
        _base, before = analyse(self.root)
        path = os.path.join(b.project_dir(self.root), sc.SCENARIO + '.jsonl')
        t = b.Transcript(sc.SCENARIO, sc.NOW - sc.DAY)
        t.prompt(b.text_of('en', sc.LONG))
        t.read('/work/vault/src/z.py')
        with open(path, 'a', encoding='utf-8') as f:
            for rec in t.lines:
                f.write(json.dumps(rec) + '\n')
        _base, after = analyse(self.root)
        self.assertEqual(shape(after)[:3], shape(before))
        self.assertEqual(len(after), 4)

    def test_baselines_do_not_depend_on_the_range(self):
        sc.history(self.root, 'en')
        sessions = load(self.root)
        base = tasks.baselines(sessions, sc.NOW)
        scen = next(s for s in sessions if s['id'] == sc.SCENARIO)
        wide = tasks.session_tasks(scen, base, (sc.NOW - 7 * sc.DAY, sc.NOW))
        narrow = tasks.session_tasks(scen, base, (sc.NOW - 2 * sc.DAY, sc.NOW - 2 * sc.DAY + 3 * 3600))
        self.assertEqual(shape(narrow), shape(wide)[:2])
        self.assertEqual(base['inputs'], 140 + 10)
        self.assertEqual(base['L_med'], round(b.est(b.text_of('en', sc.LONG)), 1))
        self.assertGreaterEqual(base['starts'], 70)

    def test_starting_prompts_only_feed_l1(self):
        sc.history(self.root, 'en')
        sessions = load(self.root)
        base = tasks.baselines(sessions, sc.NOW)
        # starting prompts: each session's first, and the scenario's three after 2 hours
        self.assertEqual(base['starts'], 70 + 1 + 3)

    def test_c_med_counts_sub_agent_calls(self):
        root = self.root
        for i in range(3):
            sid = b.session_uuid(i)
            t = b.Transcript(sid, sc.NOW - sc.DAY + i * 3600)
            t.prompt('go')
            t.spawn('sub%d' % i)
            t.write(os.path.join(b.project_dir(root), sid + '.jsonl'))
            s = b.Transcript(sid, t.t - 2, agent_id='sub%d' % i)
            for _ in range(5):
                s.call()
            s.write(os.path.join(b.project_dir(root), sid, 'subagents', 'agent-sub%d.jsonl' % i))
        base = tasks.baselines(load(root), sc.NOW)
        self.assertEqual(base['C_med'], 6)

    def test_too_few_prompts_stop_the_rules_that_need_them(self):
        sc.baseline_sessions(self.root, 'en', count=20)
        sc.scenario(self.root, 'en')
        base, ts = analyse(self.root)
        self.assertLess(base['inputs'], tasks.MIN_INPUTS)
        self.assertEqual(base['disabled'], ['rework_short', 'E16', 'E17'])
        rework = {p['turn']: p['rework'] for t in ts for p in t['prompts']}
        self.assertEqual(rework[1], [])
        self.assertEqual(rework[6], [2])
        self.assertEqual(rework[7], [3])

    def test_window_is_fourteen_days(self):
        sc.baseline_sessions(self.root, 'en', count=70, start=sc.NOW - 30 * sc.DAY)
        base = tasks.baselines(load(self.root), sc.NOW)
        self.assertLess(base['inputs'], 140)


if __name__ == '__main__':
    unittest.main()

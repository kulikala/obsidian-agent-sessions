import json
import os
import unittest

from agentsessions.efficiency import normalize, tasks

HERE = os.path.dirname(__file__)
PROJ = os.path.join(HERE, 'fixtures', 'claude', '-work-vault')
SID = '00000000-0000-4000-8000-000000000001'
MAIN = os.path.join(PROJ, SID + '.jsonl')
SUB = os.path.join(PROJ, SID, 'subagents', 'agent-a1b2c3d4e5f6a7b8.jsonl')
MATE = os.path.join(PROJ, SID, 'subagents', 'agent-ahelper-0011223344556677.jsonl')


class FixtureShapeTest(unittest.TestCase):
    """The committed fixtures (shapes of real transcripts, made-up content)."""

    @classmethod
    def setUpClass(cls):
        cls.main = normalize.read_file(MAIN)
        cls.sub = normalize.read_file(SUB)
        cls.mate = normalize.read_file(MATE)

    def test_session_cwd_version(self):
        self.assertEqual(self.main['session'], SID)
        self.assertEqual(self.main['cwd'], '/work/vault')
        self.assertEqual(self.main['version'], '2.1.280')
        self.assertEqual(self.main['kind'], 'main')

    def test_duplicate_message_id_is_one_call_with_the_last_usage(self):
        ids = [c['id'] for c in self.main['calls']]
        self.assertEqual(len(ids), len(set(ids)))
        drafts = [c for c in self.main['calls'] if c['out'] in (100, 180)]
        self.assertEqual([c['out'] for c in drafts], [180])

    def test_synthetic_line_is_not_a_call(self):
        self.assertNotIn('syn1', [c['id'] for c in self.main['calls']])
        self.assertTrue(all(c['model'] != '<synthetic>' for c in self.main['calls']))

    def test_tool_result_is_measured_from_the_block_not_tool_use_result(self):
        with open(MAIN, encoding='utf-8') as f:
            lines = [json.loads(x) for x in f]
        line = next(r for r in lines if '<persisted-output>' in json.dumps(r))
        block = line['message']['content'][0]['content']
        raw = json.dumps(line['toolUseResult'])
        self.assertGreater(len(raw), 10 * len(block))
        bash = next(r for r in self.main['results'] if r['tool'] == 'Bash')
        self.assertEqual(bash['chars'], len(block))
        self.assertEqual(bash['est'], round(normalize.est_tokens(block)))

    def test_no_conversation_text_in_the_record(self):
        dumped = json.dumps([self.main, self.sub, self.mate], ensure_ascii=False)
        for fragment in ('tidy the parser', 'write the summary', 'npm test', 'first draft',
                         'old body', 'new body', 'Check the docs', 'def parse'):
            self.assertNotIn(fragment, dumped)

    def test_edit_hashes_and_paths_relative_to_cwd(self):
        edits = [e for c in self.main['calls'] for e in c['edits']]
        self.assertEqual([e['p'] for e in edits], ['src/parser.py', 'src/parser.py'])
        self.assertEqual(edits[0]['n'], edits[1]['o'])

    def test_events(self):
        kinds = [e['k'] for e in self.main['events']]
        self.assertIn('interrupt', kinds)
        self.assertIn('compaction', kinds)
        self.assertIn('team_start', kinds)
        comp = next(e for e in self.main['events'] if e['k'] == 'compaction')
        self.assertEqual((comp['trigger'], comp['pre']), ('auto', 990000))

    def test_links_and_chain_kinds(self):
        agents = {link['agent'] for link in self.main['links']}
        self.assertEqual(agents, {'a1b2c3d4e5f6a7b8', 'ahelper-0011223344556677'})
        self.assertEqual((self.sub['kind'], self.sub['chain']), ('subagent', 'a1b2c3d4e5f6a7b8'))
        self.assertEqual((self.mate['kind'], self.mate['chain']), ('teammate', 'ahelper-0011223344556677'))
        self.assertEqual(self.sub['prompts'], [])

    def test_preamble(self):
        pre = self.main['preamble']
        self.assertEqual(pre['skills'], 64)
        self.assertEqual(pre['instr'], [{'p': 'CLAUDE.md', 'type': 'Project',
                                         'bytes': pre['instr'][0]['bytes'], 'lines': 30}])

    def test_prompts(self):
        prompts = self.main['prompts']
        self.assertEqual(len(prompts), 3)
        self.assertIsNone(prompts[0]['gap'])
        self.assertGreaterEqual(prompts[1]['gap'], 60)
        self.assertEqual(prompts[1]['est'], 1.2)    # "again"


class WeightTest(unittest.TestCase):
    def test_one_hour_write_counts_twice(self):
        call = {'in': 10, 'cw': 1000, 'cw1h': 1000, 'cr': 10000, 'out': 100}
        self.assertEqual(normalize.w_of(call), 10 + 2000 + 1000 + 500)
        call['cw1h'] = 0
        self.assertEqual(normalize.w_of(call), 10 + 1250 + 1000 + 500)
        call['cw1h'] = 400
        self.assertEqual(normalize.w_of(call), 10 + 1.25 * 600 + 800 + 1000 + 500)

    def test_est_tokens(self):
        self.assertEqual(normalize.est_tokens('abcd'), 1)
        self.assertEqual(normalize.est_tokens('あいう'), 2)


class AssembleTest(unittest.TestCase):
    def test_sub_and_teammate_calls_join_the_parent_task(self):
        s = tasks.assemble(normalize.read_file(MAIN), [normalize.read_file(SUB), normalize.read_file(MATE)])
        turns = tasks.turns_of(s)
        self.assertEqual(len(turns), 3)
        # the sub-agent is linked to the turn whose Agent call started it
        self.assertEqual({c['chain'] for c in turns[1]['sub']}, {'a1b2c3d4e5f6a7b8', 'ahelper-0011223344556677'})
        self.assertTrue(turns[1]['team'])
        self.assertEqual(turns[1]['interrupts'], 1)
        self.assertEqual(turns[2]['compactions'], 1)


if __name__ == '__main__':
    unittest.main()

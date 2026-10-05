import json
import os
import shutil
import tempfile
import time
import unittest
from datetime import datetime, timezone
from unittest import mock

from agentsessions import config
from agentsessions.cli import json_cmd, json_output as jsonout
from tests.agents.codex_helpers import (assistant_message, event_user_message, rollout_path,
                                        session_meta, write_rollout)
from tests.agents.opencode_helpers import Fixture, make_db
from tests.cli.test_json_output import write_jsonl

CLAUDE_ID = '11111111-1111-1111-1111-111111111111'
CLAUDE_OLD = '33333333-3333-3333-3333-333333333333'
CODEX_ID = '01000000-0000-0000-0000-00000000dead'
OC_ID = 'ses_cccccccccccc01'

DAY = '2026-09-24'


def epoch(hms, day=DAY):
    return datetime.strptime('%sT%s' % (day, hms), '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc).timestamp()


def pairs(session):
    return [[b['start'], b['end']] for b in session['spans']]


def claude_line(kind, hms, **extra):
    d = {'type': kind, 'timestamp': '%sT%s.000Z' % (DAY, hms)}
    d.update(extra)
    return d


class TestActivityOutput(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.proj_root = os.path.join(self.tmp, 'projects')
        proj = os.path.join(self.proj_root, '-Users-k-vault')
        os.makedirs(proj)
        write_jsonl(os.path.join(proj, CLAUDE_ID + '.jsonl'), [
            claude_line('user', '01:00:00', cwd='/Users/k/vault', message={'role': 'user', 'content': 'hello'}),
            claude_line('assistant', '01:05:00', message={'role': 'assistant', 'content': 'hi'}),
            # a second prompt 15 minutes after the first turn ended: joined into one block
            claude_line('user', '01:20:00', message={'role': 'user', 'content': 'more'}),
            claude_line('assistant', '01:25:00', message={'role': 'assistant', 'content': 'x'}),
            # 45 minutes later: a new block; one short turn
            claude_line('user', '02:10:00', message={'role': 'user', 'content': 'again'}),
            claude_line('assistant', '02:10:20', message={'role': 'assistant', 'content': 'y'}),
            {'type': 'custom-title', 'customTitle': 'RIM: Notes', 'sessionId': CLAUDE_ID},
        ])
        self.codex_home = os.path.join(self.tmp, 'codex-home')
        write_rollout(rollout_path(self.codex_home, CODEX_ID), [
            session_meta(CODEX_ID, '/work/x', ts='%sT03:00:00Z' % DAY),
            event_user_message('# AGENTS.md instructions for /work/x', '%sT03:00:01Z' % DAY),
            event_user_message('codex prompt', '%sT03:00:05Z' % DAY),
            assistant_message('done', '%sT03:10:00Z' % DAY),
            event_user_message('and again', '%sT03:20:00Z' % DAY),
            assistant_message('done again', '%sT03:21:00Z' % DAY),
        ])
        oc = make_db(self.tmp)
        with Fixture(oc) as f:
            f.session(OC_ID, title='Oc title', created=int(epoch('04:00:00') * 1000),
                      updated=int(epoch('04:25:00') * 1000))
            f.user(OC_ID, 'hi', int(epoch('04:00:00') * 1000))
            f.assistant(OC_ID, 'yo', int(epoch('04:10:00') * 1000))
            f.user(OC_ID, 'once more', int(epoch('04:20:00') * 1000))
            f.assistant(OC_ID, 'sure', int(epoch('04:25:00') * 1000))
        patches = [
            mock.patch.object(config, 'PROJECTS_DIR', self.proj_root),
            mock.patch.object(config, 'STORE_PATH', os.path.join(self.tmp, 'sessions.json')),
            mock.patch.object(config, 'CACHE_PATH', os.path.join(self.tmp, 'scan-cache.json')),
            mock.patch.object(config, 'ACTIVITY_CACHE_PATH', os.path.join(self.tmp, 'activity-cache.json')),
            mock.patch.object(config, 'UI_STATE_PATH', os.path.join(self.tmp, 'ui.json')),
            mock.patch.dict(os.environ, {'CODEX_HOME': self.codex_home, 'XDG_DATA_HOME': self.tmp,
                                         'AGENT_SESSIONS_AGENTS': 'claude,codex,opencode'}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def by_id(self, out):
        return {s['id']: s for s in out['sessions']}

    def test_spans_per_agent(self):
        out = jsonout.activity_output(epoch('00:00:00'), epoch('23:59:59'), 1800)
        by = self.by_id(out)
        self.assertEqual(set(by), {CLAUDE_ID, CODEX_ID, OC_ID})
        c = by[CLAUDE_ID]
        self.assertEqual((c['agent'], c['name'], c['category'], c['label']), ('claude', 'RIM: Notes', 'RIM', 'Notes'))
        self.assertEqual(pairs(c), [[epoch('01:00:00'), epoch('01:25:00')],
                                    [epoch('02:10:00'), epoch('02:11:00')]])
        first = c['spans'][0]['turns']
        self.assertEqual([(t['prompt'], t['kind']) for t in first], [('hello', 'prompt'), ('more', 'prompt')])
        self.assertEqual((first[0]['start'], first[0]['end']), (epoch('01:00:00'), epoch('01:05:00')))
        x = by[CODEX_ID]
        self.assertEqual(x['agent'], 'codex')
        self.assertEqual(pairs(x), [[epoch('03:00:05'), epoch('03:21:00')]])
        self.assertEqual([t['prompt'] for t in x['spans'][0]['turns']], ['codex prompt', 'and again'])
        o = by[OC_ID]
        self.assertEqual(o['agent'], 'opencode')
        self.assertEqual(pairs(o), [[epoch('04:00:00'), epoch('04:25:00')]])
        self.assertEqual([t['prompt'] for t in o['spans'][0]['turns']], ['hi', 'once more'])

    def test_clipped_to_range_and_filtered(self):
        out = jsonout.activity_output(epoch('01:10:00'), epoch('01:15:00'), 1800)
        self.assertEqual(pairs(self.by_id(out)[CLAUDE_ID]), [[epoch('01:10:00'), epoch('01:15:00')]])
        self.assertEqual(set(self.by_id(out)), {CLAUDE_ID})

    def test_range_without_activity_is_empty(self):
        out = jsonout.activity_output(epoch('06:00:00'), epoch('07:00:00'))
        self.assertEqual(out, {'sessions': []})

    def test_gap_minutes_option(self):
        # with a 5-minute gap the 01:00 and 01:20 turns are no longer joined
        out = jsonout.activity_output(epoch('00:00:00'), epoch('23:59:59'), 5 * 60)
        self.assertEqual(pairs(self.by_id(out)[CLAUDE_ID]), [
            [epoch('01:00:00'), epoch('01:05:00')], [epoch('01:20:00'), epoch('01:25:00')],
            [epoch('02:10:00'), epoch('02:11:00')]])

    def test_the_join_gap_decides_how_far_apart_turns_still_make_one_block(self):
        # the Claude fixture's turns end 01:25:00 and start again 02:10:00: 45 minutes apart
        def blocks(minutes):
            out = jsonout.activity_output(epoch('00:00:00'), epoch('23:59:59'), minutes * 60)
            return pairs(self.by_id(out)[CLAUDE_ID])
        self.assertEqual(len(blocks(30)), 2)
        self.assertEqual(blocks(60), [[epoch('01:00:00'), epoch('02:10:20')]])
        self.assertEqual(blocks(120), [[epoch('01:00:00'), epoch('02:10:20')]])

    def test_raw_returns_the_building_blocks_not_joined_spans(self):
        out = jsonout.activity_output(epoch('00:00:00'), epoch('23:59:59'), raw=True)
        c = self.by_id(out)[CLAUDE_ID]
        self.assertNotIn('spans', c)
        self.assertEqual([(t['prompt'], t['kind']) for t in c['turns']], [('hello', 'prompt'), ('more', 'prompt'), ('again', 'prompt')])
        # each turn is its own run: the 01:00 and 01:20 turns are not joined, and nothing is stretched
        self.assertEqual([[r['start'], r['end']] for r in c['runs']], [
            [epoch('01:00:00'), epoch('01:05:00')], [epoch('01:20:00'), epoch('01:25:00')],
            [epoch('02:10:00'), epoch('02:10:20')]])
        self.assertEqual([r['turn'] for r in c['runs']], [epoch('01:00:00'), epoch('01:20:00'), epoch('02:10:00')])

    def test_a_turn_still_being_written_ends_now(self):
        now = epoch('02:11:30')   # 70 s after the last record
        out = jsonout.activity_output(epoch('00:00:00'), epoch('23:59:59'), 1800, now=now)
        self.assertEqual(pairs(self.by_id(out)[CLAUDE_ID])[-1], [epoch('02:10:00'), now])

    def test_turns_are_cached_and_recomputed_only_for_a_changed_file(self):
        from agentsessions.agents import claude as claude_agent
        args = (epoch('00:00:00'), epoch('23:59:59'), 1800)
        path = os.path.join(self.proj_root, '-Users-k-vault', CLAUDE_ID + '.jsonl')
        old = time.time() - 3600      # a file written moments ago is never trusted from the cache
        os.utime(path, (old, old))
        jsonout.activity_output(*args)
        self.assertTrue(os.path.exists(config.ACTIVITY_CACHE_PATH))
        with mock.patch.object(claude_agent, 'activity_turns', wraps=claude_agent.activity_turns) as spy:
            jsonout.activity_output(*args)
            self.assertEqual(spy.call_count, 0)           # unchanged: from the cache
            with open(path, 'a') as f:
                f.write(json.dumps(claude_line('assistant', '02:12:00', message={'role': 'assistant', 'content': 'z'}), separators=(',', ':')) + '\n')
            os.utime(path, (old + 10, old + 10))
            out = jsonout.activity_output(*args)
            self.assertEqual(spy.call_count, 1)           # grew: parsed again
            self.assertEqual(pairs(self.by_id(out)[CLAUDE_ID])[-1], [epoch('02:10:00'), epoch('02:12:00')])

    def test_subagent_work_makes_up_the_block_not_just_the_main_thread(self):
        sid = '44444444-4444-4444-4444-444444444444'
        proj = os.path.join(self.proj_root, '-Users-k-vault')
        write_jsonl(os.path.join(proj, sid + '.jsonl'), [
            claude_line('user', '04:00:00', cwd='/Users/k/vault', message={'role': 'user', 'content': 'build it'}),
            claude_line('assistant', '04:00:30', message={'role': 'assistant', 'content': [{'type': 'text', 'text': 'dispatching'}]}),
            # the main thread only wakes for seconds when a background agent reports back
            claude_line('user', '04:50:00', message={'role': 'user', 'content': '<task-notification>done</task-notification>'}),
            claude_line('assistant', '04:50:20', message={'role': 'assistant', 'content': [{'type': 'text', 'text': 'all done'}]}),
            {'type': 'custom-title', 'customTitle': 'Big job', 'sessionId': sid},
        ])
        args = (epoch('00:00:00'), epoch('23:59:59'), 1800)
        before = self.by_id(jsonout.activity_output(*args))[sid]
        self.assertEqual([round(b['end'] - b['start']) for b in before['spans']], [60, 60])   # two 1-minute blocks

        subdir = os.path.join(proj, sid, 'subagents')
        os.makedirs(subdir)
        write_jsonl(os.path.join(subdir, 'agent-a.jsonl'), [
            claude_line(k, hms, isSidechain=True, message={'role': k, 'content': 'x'})
            for k, hms in (('user', '04:00:30'), ('assistant', '04:10:00'), ('assistant', '04:20:00'),
                           ('assistant', '04:30:00'), ('assistant', '04:40:00'), ('assistant', '04:49:00'))])
        after = self.by_id(jsonout.activity_output(*args))[sid]
        self.assertEqual(pairs(after), [[epoch('04:00:00'), epoch('04:50:20')]])             # one 50-minute block
        span = after['spans'][0]
        # one human turn: the notification at 04:50 continues it (it counted as work, it isn't a turn),
        # and the turn's own work is 30 s + 20 s; the hours of sub-agent work make up the block
        self.assertEqual([(t['prompt'], t['kind'], t['reply'], round(t['active'])) for t in span['turns']],
                         [('build it', 'prompt', 'all done', 50)])

    def test_real_shaped_subagent_files_lengthen_the_blocks(self):
        sid = '55555555-5555-5555-5555-555555555555'
        proj = os.path.join(self.proj_root, '-Users-k-vault')
        write_jsonl(os.path.join(proj, sid + '.jsonl'), [
            claude_line('user', '05:00:00', cwd='/Users/k/vault', message={'role': 'user', 'content': 'run the team'}),
            claude_line('assistant', '05:00:20', message={'role': 'assistant', 'content': 'started'}),
            claude_line('user', '07:30:00', message={'role': 'user', 'content': 'status?'}),
            claude_line('assistant', '07:30:20', message={'role': 'assistant', 'content': 'reporting'}),
            {'type': 'custom-title', 'customTitle': 'Team job', 'sessionId': sid},
        ])
        args = (epoch('00:00:00'), epoch('23:59:59'), 1800)
        before = self.by_id(jsonout.activity_output(*args))[sid]
        self.assertEqual([round(b['end'] - b['start']) for b in before['spans']], [60, 60])

        # the exact line shape of a teammate / background-agent transcript, several files, plus a meta file
        subdir = os.path.join(proj, sid, 'subagents')
        os.makedirs(subdir)

        def agent_line(kind, hms, agent):
            return {'parentUuid': None, 'isSidechain': True, 'agentId': agent, 'type': kind,
                    'message': {'role': kind, 'content': 'x'}, 'timestamp': '%sT%s.000Z' % (DAY, hms),
                    'sessionId': sid, 'cwd': '/Users/k/vault'}

        for agent, hours in (('acalendar-aaaa', ('05:00:30', '05:20:00', '05:45:00', '06:10:00')),
                             ('aonb-bbbb', ('06:00:00', '06:25:00', '06:50:00', '07:15:00', '07:29:00'))):
            write_jsonl(os.path.join(subdir, 'agent-%s.jsonl' % agent),
                        [agent_line('user' if i == 0 else 'assistant', h, agent) for i, h in enumerate(hours)])
        with open(os.path.join(subdir, 'agent-acalendar-aaaa.meta.json'), 'w') as f:
            f.write('{"agentType": "teammate"}')
        after = self.by_id(jsonout.activity_output(*args))[sid]
        self.assertEqual(pairs(after), [[epoch('05:00:00'), epoch('07:30:20')]])   # one 2.5-hour block

    def test_cli_args(self):
        import io
        import json
        from contextlib import redirect_stderr, redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = json_cmd.main(['activity', '--from', '%sT00:00:00Z' % DAY, '--to', '%sT23:00:00Z' % DAY,
                                '--gap-minutes', '30'])
        self.assertEqual(rc, 0)
        self.assertEqual(len(json.loads(buf.getvalue())['sessions']), 3)
        with redirect_stderr(io.StringIO()):
            self.assertEqual(json_cmd.main(['activity', '--from', 'bad', '--to', 'bad']), 2)
            self.assertEqual(json_cmd.main(['activity']), 2)


if __name__ == '__main__':
    unittest.main()

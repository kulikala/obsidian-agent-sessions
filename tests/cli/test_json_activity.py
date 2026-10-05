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

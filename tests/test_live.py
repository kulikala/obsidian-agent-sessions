import json, os, tempfile, unittest

from agentsessions.live import Live, live_sessions

SID1 = 'aaaaaaaa-1111-1111-1111-111111111111'
SID2 = 'bbbbbbbb-2222-2222-2222-222222222222'


def write(dirpath, pid, **kw):
    d = {'pid': pid, 'sessionId': kw.pop('sid', SID1), 'status': 'idle',
         'statusUpdatedAt': 1000, 'entrypoint': 'cli', 'kind': 'interactive'}
    d.update(kw)
    with open(os.path.join(dirpath, '%d.json' % pid), 'w') as f:
        json.dump(d, f)


class TestLive(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_keeps_running_claude_only(self):
        write(self.dir, 11, sid=SID1, status='busy')
        write(self.dir, 22, sid=SID2)               # pid は生きていない
        live = live_sessions(self.dir, claude_pids={11})
        self.assertEqual(set(live), {SID1})
        self.assertTrue(live[SID1].busy)
        self.assertEqual(live[SID1].label, '実行中')

    def test_shell_counts_as_busy_and_idle_does_not(self):
        write(self.dir, 11, sid=SID1, status='shell')
        write(self.dir, 12, sid=SID2, status='idle')
        live = live_sessions(self.dir, claude_pids={11, 12})
        self.assertTrue(live[SID1].busy)
        self.assertFalse(live[SID2].busy)
        self.assertEqual(live[SID2].label, '待機中')

    def test_newest_entry_wins_for_same_session(self):
        write(self.dir, 11, sid=SID1, status='idle', statusUpdatedAt=1000)
        write(self.dir, 12, sid=SID1, status='busy', statusUpdatedAt=5000)
        live = live_sessions(self.dir, claude_pids={11, 12})
        self.assertEqual(live[SID1].pid, 12)
        self.assertTrue(live[SID1].busy)

    def test_ignores_broken_files(self):
        with open(os.path.join(self.dir, 'broken.json'), 'w') as f:
            f.write('{ not json')
        with open(os.path.join(self.dir, 'list.json'), 'w') as f:
            json.dump([1, 2], f)
        write(self.dir, 11, sid=SID1)
        self.assertEqual(set(live_sessions(self.dir, claude_pids={11})), {SID1})

    def test_empty_dir(self):
        self.assertEqual(live_sessions(self.dir), {})

    def test_unknown_status_label(self):
        self.assertEqual(Live(SID1, 1, status='').label, '起動中')

    def test_waiting_status_and_waiting_for(self):
        # claude 自身が AskUserQuestion・許可プロンプト等で書く値（T-77）。
        write(self.dir, 11, sid=SID1, status='waiting', waitingFor='input needed')
        live = live_sessions(self.dir, claude_pids={11})
        self.assertEqual(live[SID1].status, 'waiting')
        self.assertEqual(live[SID1].waiting_for, 'input needed')
        self.assertEqual(live[SID1].label, '回答待ち')

    def test_waiting_is_not_busy(self):
        write(self.dir, 11, sid=SID1, status='waiting', waitingFor='permission prompt')
        live = live_sessions(self.dir, claude_pids={11})
        self.assertFalse(live[SID1].busy)

    def test_waiting_for_defaults_to_empty_string(self):
        write(self.dir, 11, sid=SID1, status='idle')
        live = live_sessions(self.dir, claude_pids={11})
        self.assertEqual(live[SID1].waiting_for, '')

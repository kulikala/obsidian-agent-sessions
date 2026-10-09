import json
import os
import tempfile
import time
import unittest
from datetime import datetime

from agentsessions.sessions import schedule
from agentsessions.sessions.scan import _iso_ts

T0 = '2026-10-08T03:00:00.000Z'
T0_EPOCH = _iso_ts(T0)


def write(path, recs, mode='w'):
    with open(path, mode, encoding='utf-8') as f:
        for r in recs:
            f.write((r if isinstance(r, str) else json.dumps(r, separators=(',', ':'))) + '\n')


def create_use(tid, cron='*/5 * * * *', recurring=True, ts=T0, **extra):
    return {'type': 'assistant', 'timestamp': ts, 'message': {'content': [
        {'type': 'tool_use', 'id': tid, 'name': 'CronCreate',
         'input': {'cron': cron, 'prompt': 'p', 'recurring': recurring}}]}, **extra}


def result(tid, payload, ts=T0, **extra):
    return {'type': 'user', 'timestamp': ts, 'message': {'content': [
        {'type': 'tool_result', 'tool_use_id': tid, 'content': 'ok'}]}, 'toolUseResult': payload, **extra}


def created(jid, tid='t1', **kw):
    return [create_use(tid, **kw), result(tid, {'id': jid, 'humanSchedule': 'Every 5 minutes'})]


def fire(task_id, kind=None, ts=T0):
    rec = {'type': 'system', 'subtype': 'scheduled_task_fire', 'timestamp': ts, 'taskId': task_id}
    if kind:
        rec['cronKind'] = kind
    return rec


def user(text, ts=T0, **extra):
    return {'type': 'user', 'timestamp': ts, 'message': {'role': 'user', 'content': text}, **extra}


class FoldTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 's.jsonl')

    def tearDown(self):
        self.tmp.cleanup()

    def summary(self, recs, now=T0_EPOCH + 60):
        write(self.path, recs)
        return schedule.summarize(schedule.fold(self.path), now)

    def test_nothing_scheduled(self):
        self.assertIsNone(self.summary([user('hi')]))

    def test_created_job(self):
        s = self.summary(created('aaaa1111'))
        self.assertEqual(s['job_count'], 1)
        self.assertTrue(s['jobs'][0]['recurring'])
        self.assertEqual(s['jobs'][0]['human'], 'Every 5 minutes')
        self.assertIsNotNone(s['next'])
        self.assertGreater(s['next'], T0_EPOCH + 60)

    def test_create_without_result_is_ignored(self):
        self.assertIsNone(self.summary([create_use('t1')]))

    def test_errored_result_is_ignored(self):
        bad = result('t1', {'id': 'x'})
        bad['message']['content'][0]['is_error'] = True
        self.assertIsNone(self.summary([create_use('t1'), bad]))

    def test_delete(self):
        delete = {'type': 'assistant', 'timestamp': T0, 'message': {'content': [
            {'type': 'tool_use', 'id': 't2', 'name': 'CronDelete', 'input': {'id': 'aaaa1111'}}]}}
        self.assertIsNone(self.summary(created('aaaa1111') + [delete]))

    def test_one_shot_consumed_by_its_fire(self):
        recs = created('bbbb2222', recurring=False)
        self.assertEqual(self.summary(recs)['job_count'], 1)
        self.assertIsNone(self.summary(recs + [fire('bbbb2222')]))

    def test_recurring_survives_fire(self):
        self.assertEqual(self.summary(created('a') + [fire('a')])['job_count'], 1)

    def test_recurring_expires_after_seven_days_with_margin(self):
        recs = created('a')
        self.assertEqual(self.summary(recs, T0_EPOCH + 7 * 86400 + 600)['job_count'], 1)
        self.assertIsNone(self.summary(recs, T0_EPOCH + 7 * 86400 + 7200))

    def test_sidechain_records_are_ignored(self):
        recs = [dict(r, isSidechain=True) for r in created('a')]
        self.assertIsNone(self.summary(recs))

    def test_cron_list_overrides_fold(self):
        lst = [{'type': 'assistant', 'timestamp': T0, 'message': {'content': [
            {'type': 'tool_use', 'id': 'tl', 'name': 'CronList', 'input': {}}]}},
            result('tl', {'jobs': [{'id': 'b', 'cron': '0 9 * * *', 'recurring': True}]})]
        s = self.summary(created('a') + lst)
        self.assertEqual(s['job_count'], 1)
        self.assertEqual(s['jobs'][0]['cron'], '0 9 * * *')

    def wake_use(self, tid, **inp):
        return {'type': 'assistant', 'timestamp': T0, 'message': {'content': [
            {'type': 'tool_use', 'id': tid, 'name': 'ScheduleWakeup', 'input': inp}]}}

    def test_wakeup_pending_then_stopped(self):
        when = int((T0_EPOCH + 600) * 1000)
        recs = [self.wake_use('w1', delaySeconds=600), result('w1', {'scheduledFor': when})]
        s = self.summary(recs)
        self.assertEqual(s['wakeup'], when / 1000)
        self.assertEqual(s['next'], when / 1000)
        self.assertIsNone(self.summary(recs + [self.wake_use('w2', stop=True)]))

    def test_wakeup_cleared_by_loop_fire(self):
        when = int((T0_EPOCH + 600) * 1000)
        recs = [self.wake_use('w1', delaySeconds=600), result('w1', {'scheduledFor': when}),
                fire('x', kind='loop')]
        self.assertIsNone(self.summary(recs))

    def test_overdue_wakeup_is_dropped(self):
        when = int((T0_EPOCH + 600) * 1000)
        recs = [self.wake_use('w1', delaySeconds=600), result('w1', {'scheduledFor': when})]
        self.assertIsNone(self.summary(recs, T0_EPOCH + 600 + 3600))

    def fold_turn(self, recs):
        write(self.path, recs)
        return schedule.fold(self.path)['scheduled_turn']

    def test_scheduled_turn_by_turn_origin(self):
        self.assertTrue(self.fold_turn([user('p', isMeta=True, turnOrigin='scheduled', scheduledTaskId='a')]))

    def test_scheduled_turn_by_task_id_in_old_versions(self):
        self.assertTrue(self.fold_turn([user('p', isMeta=True, scheduledTaskId='a')]))

    def test_meta_alone_is_not_scheduled(self):
        self.assertFalse(self.fold_turn([user('x', isMeta=True, turnOrigin='peer')]))

    def test_human_input_clears(self):
        recs = [user('p', turnOrigin='scheduled', scheduledTaskId='a'), user('hello', turnOrigin='human')]
        self.assertFalse(self.fold_turn(recs))

    def test_old_version_human_input_clears(self):
        recs = [user('p', isMeta=True, scheduledTaskId='a'), user('hello')]
        self.assertFalse(self.fold_turn(recs))

    def test_tool_result_and_peer_do_not_clear(self):
        recs = [user('p', isMeta=True, turnOrigin='scheduled', scheduledTaskId='a'),
                result('zz', {}), user('hi', isMeta=True, turnOrigin='peer'),
                user('done', turnOrigin='task_notification', isMeta=True)]
        self.assertTrue(self.fold_turn(recs))

    def test_incremental_fold_reads_only_the_new_tail(self):
        write(self.path, created('a'))
        state = schedule.fold(self.path)
        offset = state['offset']
        self.assertEqual(offset, os.path.getsize(self.path))
        write(self.path, [user('p', turnOrigin='scheduled', scheduledTaskId='a')], mode='a')
        state = schedule.fold(self.path, state)
        self.assertGreater(state['offset'], offset)
        self.assertTrue(state['scheduled_turn'])
        self.assertIn('a', state['jobs'])

    def test_partial_last_line_is_left_for_next_time(self):
        write(self.path, created('a'))
        with open(self.path, 'a') as f:
            f.write('{"type":"user"')
        state = schedule.fold(self.path)
        self.assertLess(state['offset'], os.path.getsize(self.path))

    def test_truncated_file_restarts(self):
        write(self.path, created('a'))
        state = schedule.fold(self.path)
        write(self.path, [user('x')])
        self.assertEqual(schedule.fold(self.path, state)['jobs'], {})

    def test_pending_without_result_is_bounded(self):
        write(self.path, [create_use('t%d' % i) for i in range(200)])
        self.assertLessEqual(len(schedule.fold(self.path)['pending']), schedule.MAX_PENDING)


class NextCronTest(unittest.TestCase):
    def at(self, y, mo, d, h, mi):
        return datetime(y, mo, d, h, mi).timestamp()

    def test_every_five_minutes(self):
        nxt = schedule.next_cron_fire('*/5 * * * *', self.at(2026, 10, 8, 12, 7))
        self.assertEqual(nxt, self.at(2026, 10, 8, 12, 10))

    def test_daily(self):
        nxt = schedule.next_cron_fire('30 9 * * *', self.at(2026, 10, 8, 10, 0))
        self.assertEqual(nxt, self.at(2026, 10, 9, 9, 30))

    def test_weekday_range(self):
        # 2026-10-10 is a Saturday; the next Monday is the 12th.
        nxt = schedule.next_cron_fire('0 9 * * 1-5', self.at(2026, 10, 9, 9, 30))
        self.assertEqual(nxt, self.at(2026, 10, 12, 9, 0))

    def test_unparsable(self):
        self.assertIsNone(schedule.next_cron_fire('every day', time.time()))
        self.assertIsNone(schedule.next_cron_fire('*/0 * * * *', time.time()))
        self.assertIsNone(schedule.next_cron_fire('99 * * * *', time.time()))


if __name__ == '__main__':
    unittest.main()

import multiprocessing
import os
import shutil
import tempfile
import time
import unittest

from agentsessions import config
from agentsessions.sessions import store


def _bump(path, tag, n):
    """The side that hammers `store.update` from multiple processes. Appends n entries to folded."""
    for i in range(n):
        def _apply(st, tag=tag, i=i):
            st.folded.append('%s-%d' % (tag, i))
        store.update(_apply, path=path)


class TestStoreRoundTrip(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.path = os.path.join(self.tmpdir, 'sessions.json')

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_round_trip(self):
        st = store.Store(
            folded=['RIM'],
            archived=[{'id': 'a', 'name': 'x', 'agent': 'claude'}],
            pendingRenames={'a': 'new name'},
            sessions={'a': {'agent': 'claude', 'cwd': '/v'}},
            categoryColors={'RIM': 3},
        )
        store.save(st, path=self.path)
        self.assertEqual(store.load(path=self.path), st)

    def test_category_colors_round_trip(self):
        """categoryColors must not be dropped: whatever assignment the TS side wrote is passed through by Python unchanged."""
        st = store.Store(categoryColors={'RIM': 3, 'Skill Development': 0})
        store.save(st, path=self.path)
        self.assertEqual(store.load(path=self.path).categoryColors, {'RIM': 3, 'Skill Development': 0})

    def test_category_colors_defaults_to_empty_dict(self):
        self.assertEqual(store.Store().categoryColors, {})
        self.assertEqual(store.load(path=self.path).categoryColors, {})

    def test_missing_file_is_empty(self):
        missing = os.path.join(self.tmpdir, 'missing.json')
        self.assertEqual(store.load(path=missing), store.Store())

    def test_broken_file_is_moved_aside_and_load_returns_empty(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write('{not json')
        self.assertEqual(store.load(path=self.path), store.Store())
        self.assertFalse(os.path.exists(self.path))
        broken = [n for n in os.listdir(self.tmpdir) if n.startswith('sessions.json.broken-')]
        self.assertEqual(len(broken), 1)
        with open(os.path.join(self.tmpdir, broken[0]), encoding='utf-8') as f:
            self.assertEqual(f.read(), '{not json')

    def test_non_object_json_is_treated_as_broken(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write('[1, 2, 3]')
        self.assertEqual(store.load(path=self.path), store.Store())
        broken = [n for n in os.listdir(self.tmpdir) if n.startswith('sessions.json.broken-')]
        self.assertEqual(len(broken), 1)


class TestSharingErrors(unittest.TestCase):
    """Windows refuses to open a file being replaced, and to replace a file a reader holds open
    without delete sharing, for a moment: `PermissionError`."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.path = os.path.join(self.tmpdir, 'sessions.json')
        st = store.Store()
        st.folded.append('a')
        store.save(st, path=self.path)
        self.real_read = store._read
        self.real_replace = os.replace
        self.real_retry = store.SHARING_RETRY_SECONDS

    def tearDown(self):
        store._read = self.real_read
        store.os.replace = self.real_replace
        store.SHARING_RETRY_SECONDS = self.real_retry
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def refuse(self, times, real):
        state = {'left': times}

        def op(*args):
            if state['left'] != 0:
                state['left'] -= 1
                raise PermissionError(13, 'in use')
            return real(*args)
        return op

    def test_a_refused_read_is_tried_again(self):
        store._read = self.refuse(3, self.real_read)
        self.assertEqual(store.load(path=self.path).folded, ['a'])

    def test_a_file_that_stays_refused_is_not_moved_aside(self):
        store.SHARING_RETRY_SECONDS = 0.05
        store._read = self.refuse(-1, self.real_read)
        self.assertEqual(store.load(path=self.path), store.Store())
        self.assertEqual(os.listdir(self.tmpdir), ['sessions.json'])

    def test_a_writer_does_not_save_over_a_file_it_could_not_read(self):
        store.SHARING_RETRY_SECONDS = 0.05
        store._read = self.refuse(-1, self.real_read)
        with self.assertRaises(PermissionError):
            store.update(lambda st: st.folded.append('b'), path=self.path)
        store._read = self.real_read
        self.assertEqual(store.load(path=self.path).folded, ['a'])

    def test_a_refused_replace_is_tried_again(self):
        store.os.replace = self.refuse(2, self.real_replace)
        store.update(lambda st: st.folded.append('b'), path=self.path)
        self.assertEqual(store.load(path=self.path).folded, ['a', 'b'])
        self.assertEqual(sorted(os.listdir(self.tmpdir)), ['sessions.json'])


class TestArchiveAndFold(unittest.TestCase):
    def test_archive_is_idempotent(self):
        st = store.Store()
        store.archive(st, 'a', 'name', 'claude')
        store.archive(st, 'a', 'name2', 'claude')
        self.assertEqual(len(st.archived), 1)
        self.assertTrue(store.is_archived(st, 'a'))

    def test_unarchive_removes_entry(self):
        st = store.Store(archived=[{'id': 'a', 'name': 'x', 'agent': 'claude'}])
        store.unarchive(st, 'a')
        self.assertFalse(store.is_archived(st, 'a'))
        self.assertEqual(st.archived, [])

    def test_set_folded_toggles(self):
        st = store.Store()
        store.set_folded(st, 'RIM', True)
        self.assertEqual(st.folded, ['RIM'])
        store.set_folded(st, 'RIM', True)  # already folded, so it isn't added again
        self.assertEqual(st.folded, ['RIM'])
        store.set_folded(st, 'RIM', False)
        self.assertEqual(st.folded, [])


class TestLock(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.lockpath = os.path.join(self.tmpdir, 'sessions.json.lock')

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_acquire_and_release(self):
        with store.Lock(self.lockpath):
            self.assertTrue(os.path.isdir(self.lockpath))
        self.assertFalse(os.path.isdir(self.lockpath))

    def test_times_out_when_held(self):
        os.mkdir(self.lockpath)
        lock = store.Lock(self.lockpath, timeout=0.2, retry_interval=0.05)
        with self.assertRaises(TimeoutError):
            with lock:
                pass

    def test_stale_lock_is_cleared_and_reacquired(self):
        os.mkdir(self.lockpath)
        old = time.time() - 20
        os.utime(self.lockpath, (old, old))
        start = time.monotonic()
        with store.Lock(self.lockpath, timeout=1.0, retry_interval=0.05, stale_after=10.0):
            pass
        self.assertLess(time.monotonic() - start, 0.5)
        self.assertFalse(os.path.isdir(self.lockpath))


class TestUpdateConcurrency(unittest.TestCase):
    def test_two_processes_do_not_lose_writes(self):
        tmpdir = tempfile.mkdtemp()
        try:
            path = os.path.join(tmpdir, 'sessions.json')
            store.save(store.Store(), path=path)
            ctx = multiprocessing.get_context('fork')
            procs = [ctx.Process(target=_bump, args=(path, tag, 50)) for tag in ('a', 'b')]
            for p in procs:
                p.start()
            for p in procs:
                p.join(timeout=30)
            for p in procs:
                self.assertEqual(p.exitcode, 0)
            self.assertEqual(len(store.load(path=path).folded), 100)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class TestNoVault(unittest.TestCase):
    """Behavior when the vault can't be determined (`path` is `None`): reads return empty, writes are blocked."""

    def test_load_with_none_path_returns_empty_store(self):
        self.assertEqual(store.load(path=None), store.Store())

    def test_save_with_none_path_raises_vault_not_configured(self):
        with self.assertRaises(config.VaultNotConfigured):
            store.save(store.Store(), path=None)

    def test_update_with_none_path_raises_vault_not_configured(self):
        with self.assertRaises(config.VaultNotConfigured):
            store.update(lambda st: None, path=None)


if __name__ == '__main__':
    unittest.main()

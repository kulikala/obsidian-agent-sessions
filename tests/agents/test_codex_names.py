import json
import os
import sqlite3
import tempfile
import unittest
from unittest import mock

from agentsessions.agents.codex import names

ID1 = '07000000-0000-0000-0000-000000000001'
ID2 = '07000000-0000-0000-0000-000000000002'


def _write_wal_db(home: str, rows) -> str:
    """A real WAL-mode `state_5.sqlite` with `rows` = [(id, name, title), ...]."""
    db = os.path.join(home, names.DB_FILENAME)
    conn = sqlite3.connect(db)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)')
    conn.executemany('INSERT INTO threads (id, name, title) VALUES (?, ?, ?)', rows)
    conn.commit()
    conn.close()
    return db


def _strip_wal_files(db: str) -> None:
    """Simulates "codex isn't running right now": WAL checkpointed and
    cleaned up on its last clean exit, so -wal/-shm don't exist."""
    for suffix in ('-wal', '-shm'):
        p = db + suffix
        if os.path.exists(p):
            os.remove(p)


class TestConnectFallback(unittest.TestCase):
    """T-105: a real report -- with no `codex` process running, `-wal`/`-shm`
    can be entirely absent, and opening a WAL-mode database `mode=ro` in that
    state fails outright ("unable to open database file"), silently losing
    every session's name."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        self.cache_path = os.path.join(self.home, 'codex-names-cache.json')

    def test_plain_mode_ro_works_in_the_common_case(self):
        # The common case: nothing unusual about this database right now
        # (whether or not -wal/-shm happen to still be on disk depends on this
        # platform's sqlite build's auto-checkpoint-on-close behavior, which
        # isn't what this test is about -- see the WAL-specific tests below
        # for that).
        _write_wal_db(self.home, [(ID1, 'MyName', 'MyTitle')])
        result = names.lookup_thread_info(self.home, [ID1], names_cache_path=self.cache_path)
        self.assertEqual(result[ID1].name, 'MyName')

    def test_immutable_fallback_recovers_the_name_when_wal_is_absent(self):
        # The real bug (macOS, real ~/.codex data, 2026-09-25): after a clean
        # `codex` exit with no pending WAL data, -wal/-shm can be entirely
        # absent, and plain mode=ro then fails outright ("unable to open
        # database file") since it's not allowed to create the -shm a
        # WAL-mode database needs even just to read. Whether *this* test's
        # sqlite build actually reproduces that after write+close (some
        # auto-checkpoint on close, removing -wal themselves either way) is
        # platform-dependent and not the point -- what's under test is
        # _connect's fallback branching itself, forced deterministically here
        # by simulating the plain mode=ro failure.
        db = _write_wal_db(self.home, [(ID1, 'MyName', 'MyTitle')])
        _strip_wal_files(db)
        self.assertFalse(os.path.exists(db + '-wal'))

        real_connect = sqlite3.connect

        def _fail_plain_mode_ro(target, *a, **kw):
            if kw.get('uri') and 'immutable=1' not in target:
                raise sqlite3.OperationalError('simulated: unable to open database file')
            return real_connect(target, *a, **kw)

        with mock.patch('sqlite3.connect', side_effect=_fail_plain_mode_ro):
            result = names.lookup_thread_info(self.home, [ID1], names_cache_path=self.cache_path)
        self.assertEqual(result[ID1].name, 'MyName')

    def test_copy_fallback_is_used_when_wal_exists_but_mode_ro_fails(self):
        db = _write_wal_db(self.home, [(ID1, 'MyName', 'MyTitle')])
        # Force the "-wal exists" branch regardless of whether this platform's
        # sqlite build happened to leave a real one behind after close (see
        # test_plain_mode_ro_works_in_the_common_case) -- _connect only checks
        # os.path.exists(wal_path), so a placeholder is enough to route into
        # the copy fallback rather than the immutable=1 one.
        open(db + '-wal', 'wb').close()
        # ...then simulate mode=ro still failing for some other reason (e.g.
        # this process can't create -shm) by making every URI-mode connect
        # attempt fail; only a plain (non-URI) connect -- what the copy
        # fallback uses -- should succeed.
        real_connect = sqlite3.connect

        def _flaky_connect(target, *a, **kw):
            if kw.get('uri'):
                raise sqlite3.OperationalError('simulated: unable to open database file')
            return real_connect(target, *a, **kw)

        with mock.patch('sqlite3.connect', side_effect=_flaky_connect):
            result = names.lookup_thread_info(self.home, [ID1], names_cache_path=self.cache_path)
        self.assertEqual(result[ID1].name, 'MyName')

    def test_copy_fallback_cleans_up_its_temp_directory(self):
        db = _write_wal_db(self.home, [(ID1, 'MyName', 'MyTitle')])
        real_connect = sqlite3.connect
        seen_tmpdirs = []

        def _flaky_connect(target, *a, **kw):
            if kw.get('uri'):
                raise sqlite3.OperationalError('simulated')
            seen_tmpdirs.append(os.path.dirname(target))
            return real_connect(target, *a, **kw)

        with mock.patch('sqlite3.connect', side_effect=_flaky_connect):
            names.lookup_thread_info(self.home, [ID1], names_cache_path=self.cache_path)
        self.assertEqual(len(seen_tmpdirs), 1)
        self.assertFalse(os.path.exists(seen_tmpdirs[0]))   # cleaned up afterward

    def test_all_strategies_failing_falls_back_to_last_known_cache(self):
        db = _write_wal_db(self.home, [(ID1, 'MyName', 'MyTitle')])
        # First, a successful lookup persists MyName to the cache.
        first = names.lookup_thread_info(self.home, [ID1], names_cache_path=self.cache_path)
        self.assertEqual(first[ID1].name, 'MyName')
        self.assertTrue(os.path.exists(self.cache_path))

        # Now every connection strategy fails (simulates the db becoming
        # entirely unreadable -- corrupted, permissions, whatever).
        with mock.patch('sqlite3.connect', side_effect=sqlite3.OperationalError('simulated')):
            second = names.lookup_thread_info(self.home, [ID1], names_cache_path=self.cache_path)
        self.assertEqual(second[ID1].name, 'MyName')   # not lost -- from the cache

    def test_missing_database_falls_back_to_last_known_cache_too(self):
        _write_wal_db(self.home, [(ID1, 'MyName', 'MyTitle')])
        names.lookup_thread_info(self.home, [ID1], names_cache_path=self.cache_path)
        os.remove(os.path.join(self.home, names.DB_FILENAME))
        result = names.lookup_thread_info(self.home, [ID1], names_cache_path=self.cache_path)
        self.assertEqual(result[ID1].name, 'MyName')

    def test_no_database_and_no_cache_returns_empty_not_an_error(self):
        result = names.lookup_thread_info(self.home, [ID1], names_cache_path=self.cache_path)
        self.assertEqual(result, {})

    def test_cache_merges_rather_than_overwriting_other_ids(self):
        db = _write_wal_db(self.home, [(ID1, 'Name1', 'Title1'), (ID2, 'Name2', 'Title2')])
        names.lookup_thread_info(self.home, [ID1, ID2], names_cache_path=self.cache_path)
        # A later lookup for only ID1 (e.g. a scan that only touched ID1) must
        # not drop ID2's previously-cached entry.
        names.lookup_thread_info(self.home, [ID1], names_cache_path=self.cache_path)
        with open(self.cache_path, encoding='utf-8') as f:
            cached = json.load(f)
        self.assertIn(ID2, cached)
        self.assertEqual(cached[ID2]['name'], 'Name2')


if __name__ == '__main__':
    unittest.main()

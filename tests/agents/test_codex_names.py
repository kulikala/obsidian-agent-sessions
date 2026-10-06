import json
import os
import sqlite3
import tempfile
import unittest
from unittest import mock

from agentsessions import config
from agentsessions.agents.codex import names, rollout

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
    """With no `codex` process running, `-wal`/`-shm`
    can be entirely absent, and opening a WAL-mode database `mode=ro` in that
    state fails outright ("unable to open database file"), silently losing
    every session's name."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
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


class TestSqliteHome(unittest.TestCase):
    """`state_5.sqlite`'s folder, by Codex's own order: `sqlite_home` in config.toml, then
    `CODEX_SQLITE_HOME`, then CODEX_HOME."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = os.path.join(self.tmp.name, 'p2')
        os.makedirs(self.home)
        self.ui = os.path.join(self.tmp.name, 'ui.json')
        p = mock.patch.object(config, 'UI_STATE_PATH', self.ui)
        p.start()
        self.addCleanup(p.stop)

    def config(self, text):
        with open(os.path.join(self.home, 'config.toml'), 'w') as f:
            f.write(text)

    def test_codex_home_by_default(self):
        self.assertEqual(names.sqlite_home(self.home, {}), self.home)

    def test_environment_then_config(self):
        db = os.path.join(self.tmp.name, 'db')
        self.assertEqual(names.sqlite_home(self.home, {'CODEX_SQLITE_HOME': db}), db)
        self.config('model = "m"\nsqlite_home = "%s" # here\n[tui]\n' % os.path.join(self.tmp.name, 'cfg').replace('\\', '\\\\'))
        self.assertEqual(names.sqlite_home(self.home, {'CODEX_SQLITE_HOME': db}), os.path.join(self.tmp.name, 'cfg'))

    def test_only_the_top_level_key_counts_and_relative_paths_are_under_home(self):
        self.config("[profiles.x]\nsqlite_home = '/nope'\n")
        self.assertEqual(names.sqlite_home(self.home, {}), self.home)
        self.config("sqlite_home = 'state'\n")
        self.assertEqual(names.sqlite_home(self.home, {}), os.path.join(self.home, 'state'))

    def test_names_are_read_from_the_sqlite_home(self):
        db_dir = os.path.join(self.tmp.name, 'db')
        os.makedirs(db_dir)
        _write_wal_db(db_dir, [(ID1, 'Elsewhere', None)])
        cache = os.path.join(self.tmp.name, 'cache.json')
        with mock.patch.dict(os.environ, {'CODEX_SQLITE_HOME': db_dir}):
            self.assertEqual(names.lookup_thread_info(self.home, [ID1], names_cache_path=cache)[ID1].name, 'Elsewhere')


class TestProfileFromSettings(unittest.TestCase):
    """Outside a Codex session (no CODEX_HOME in the environment) the profile comes from the
    plugin's Codex setting, mirrored into ui.json."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ui = os.path.join(self.tmp.name, 'ui.json')

    def write_ui(self, env):
        with open(self.ui, 'w') as f:
            json.dump({'agentLaunch': {'codex': {'path': '', 'env': env}}}, f)

    def test_environment_first_then_the_setting_then_the_default(self):
        self.write_ui({'CODEX_HOME': '/p2', 'CODEX_SQLITE_HOME': '/db'})
        self.assertEqual(rollout.codex_home({'CODEX_HOME': '/env'}, self.ui), '/env')
        self.assertEqual(rollout.codex_home({}, self.ui), '/p2')
        self.assertEqual(rollout.codex_variable('CODEX_SQLITE_HOME', {}, self.ui), '/db')
        self.write_ui({})
        self.assertEqual(rollout.codex_home({}, self.ui), os.path.join(os.path.expanduser('~'), '.codex'))
        self.assertEqual(rollout.codex_home({}, os.path.join(self.tmp.name, 'missing.json')),
                         os.path.join(os.path.expanduser('~'), '.codex'))

import os
import tempfile
import time
import unittest

from agentsessions.agents.opencode import db


class TestDbPath(unittest.TestCase):
    """OpenCode's own rule (packages/core/src/database/database.ts)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.data = self._tmp.name

    def touch(self, name, age=0.0):
        path = os.path.join(self.data, name)
        with open(path, 'w'):
            pass
        t = time.time() - age
        os.utime(path, (t, t))
        return path

    def test_opencode_db_by_default(self):
        self.assertEqual(db.db_path({}, self.data), os.path.join(self.data, 'opencode.db'))
        self.touch('opencode.db')
        self.assertEqual(db.db_path({}, self.data), os.path.join(self.data, 'opencode.db'))

    def test_opencode_db_variable(self):
        self.assertEqual(db.db_path({'OPENCODE_DB': 'mine.db'}, self.data), os.path.join(self.data, 'mine.db'))
        absolute = os.path.join(self.data, 'elsewhere', 'x.db')
        self.assertEqual(db.db_path({'OPENCODE_DB': absolute}, self.data), absolute)
        self.assertIsNone(db.db_path({'OPENCODE_DB': ':memory:'}, self.data))

    def test_a_channel_database_written_last_wins(self):
        self.touch('opencode.db', age=100)
        dev = self.touch('opencode-dev.db', age=10)
        self.touch('opencode-beta-x.db', age=50)
        self.touch('opencode.db.bak')
        self.assertEqual(db.db_path({}, self.data), dev)
        # A WAL counts as a write to its database.
        self.touch('opencode.db-wal')
        self.assertEqual(db.db_path({}, self.data), os.path.join(self.data, 'opencode.db'))

    def test_disabling_channel_databases(self):
        self.touch('opencode-dev.db')
        for value in ('1', 'true'):
            self.assertEqual(db.db_path({'OPENCODE_DISABLE_CHANNEL_DB': value}, self.data),
                             os.path.join(self.data, 'opencode.db'))
        self.assertTrue(db.db_path({'OPENCODE_DISABLE_CHANNEL_DB': '0'}, self.data).endswith('opencode-dev.db'))

    def test_in_memory_database_opens_nothing(self):
        old = os.environ.get('OPENCODE_DB')
        os.environ['OPENCODE_DB'] = ':memory:'
        try:
            self.assertIsNone(db.open_db())
        finally:
            if old is None:
                del os.environ['OPENCODE_DB']
            else:
                os.environ['OPENCODE_DB'] = old


if __name__ == '__main__':
    unittest.main()

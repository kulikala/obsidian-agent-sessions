import sqlite3
import tempfile
import os
import unittest
from unittest import mock

from agentsessions import paths


class TestFolderKey(unittest.TestCase):
    def test_unix_is_the_string_itself(self):
        self.assertEqual(paths.folder_key('/Users/me/Vault/', windows=False), '/Users/me/Vault/')
        self.assertFalse(paths.same_folder('/Users/me/vault', '/Users/me/Vault', windows=False))

    def test_windows_spellings_of_one_folder(self):
        same = ['C:\\Users\\me\\Vault', 'c:\\users\\me\\vault\\', 'C:/Users/me/Vault',
                '\\\\?\\C:\\Users\\me\\Vault', 'C:\\Users\\me\\.\\Vault']
        for other in same:
            self.assertTrue(paths.same_folder(same[0], other, windows=True), other)
        self.assertFalse(paths.same_folder('C:\\Users\\me\\Vault', 'D:\\Users\\me\\Vault', windows=True))
        self.assertFalse(paths.same_folder('C:\\Users\\me\\Vault', 'C:\\Users\\me\\Vault2', windows=True))

    def test_windows_roots_and_unc(self):
        self.assertEqual(paths.folder_key('C:\\', windows=True), 'c:\\')
        self.assertEqual(paths.folder_key('\\\\?\\UNC\\server\\share\\x', windows=True),
                         paths.folder_key('\\\\server\\share\\x\\', windows=True))
        self.assertEqual(paths.folder_key('', windows=True), '')

    def test_default_follows_the_platform_flag(self):
        with mock.patch.object(paths, 'IS_WINDOWS', True):
            self.assertTrue(paths.same_folder('C:\\A', 'c:/a'))
        with mock.patch.object(paths, 'IS_WINDOWS', False):
            self.assertFalse(paths.same_folder('C:\\A', 'c:/a'))


class TestSqliteUri(unittest.TestCase):
    def test_windows_drive_path(self):
        self.assertEqual(paths.sqlite_uri('C:\\Users\\A B\\.codex\\state_5.sqlite', 'mode=ro', windows=True),
                         'file:/C:/Users/A%20B/.codex/state_5.sqlite?mode=ro')

    def test_unix_path_is_percent_encoded(self):
        self.assertEqual(paths.sqlite_uri('/tmp/a?b#c%d.db', 'mode=ro&immutable=1', windows=False),
                         'file:/tmp/a%3Fb%23c%25d.db?mode=ro&immutable=1')

    def test_opens_a_real_database_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, 'x y#%.db')
            conn = sqlite3.connect(db)
            conn.execute('CREATE TABLE t (v)')
            conn.commit()
            conn.close()
            ro = sqlite3.connect(paths.sqlite_uri(db, 'mode=ro'), uri=True)
            try:
                self.assertEqual(ro.execute('SELECT count(*) FROM t').fetchone(), (0,))
                with self.assertRaises(sqlite3.OperationalError):
                    ro.execute('INSERT INTO t VALUES (1)')
            finally:
                ro.close()


if __name__ == '__main__':
    unittest.main()

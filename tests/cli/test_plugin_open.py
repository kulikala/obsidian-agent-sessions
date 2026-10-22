"""`plugin_open`: the shared one-frame request to `plugin.sock`, and the `open` op's payload."""
import os
import shutil
import tempfile
import unittest
from unittest import mock

from agentsessions.cli import plugin_open
from tests.cli.test_new import FakePlugin


class TestPluginOpen(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='agsd-open-')
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.sock_path = os.path.join(self.dir, 'plugin.sock')

    def test_no_plugin_answers_with_none(self):
        self.assertIsNone(plugin_open.open_in_obsidian('s1', 'claude', '/v', sock_path=self.sock_path))
        self.assertIsNone(plugin_open.request({'op': 'rename', 'seq': 1, 'session': 's', 'name': 'n'},
                                             sock_path=self.sock_path))

    def test_open_sends_the_daemon_and_name_only_when_given(self):
        plugin = FakePlugin(self.sock_path, {'ok': True})
        self.addCleanup(plugin.close)
        reply = plugin_open.open_in_obsidian('thread-1', 'codex', '/v', daemon='daemon-1', name='Docs',
                                             sock_path=self.sock_path)
        self.assertEqual(reply, {'ok': True, 'seq': 1})
        self.assertEqual(plugin.wait(), {'op': 'open', 'seq': 1, 'session': 'thread-1', 'agent': 'codex',
                                         'cwd': '/v', 'daemon': 'daemon-1', 'name': 'Docs'})

    def test_the_socket_path_from_the_environment_is_used(self):
        plugin = FakePlugin(self.sock_path, {'ok': True})
        self.addCleanup(plugin.close)
        with mock.patch.dict(os.environ, {plugin_open.SOCK_ENV: self.sock_path}):
            self.assertEqual(plugin_open.open_in_obsidian('s1', 'claude', '/v'), {'ok': True, 'seq': 1})
        self.assertEqual(plugin.wait()['op'], 'open')


if __name__ == '__main__':
    unittest.main()

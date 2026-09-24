import json
import os
import shutil
import tempfile
import time
import unittest
from unittest import mock

from agentsessions.sessions import cache
from agentsessions.sessions.scan import scan

ID1 = '11111111-1111-1111-1111-111111111111'


def write_jsonl(path, records):
    with open(path, 'w') as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')


class TestCacheRoundTrip(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.path = os.path.join(self.tmpdir, 'scan-cache.json')

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_round_trip(self):
        data = {'/a/b.jsonl': {'mtime': 1.0, 'size': 10, 'head': {'cwd': '/a'}, 'last_activity': 2.0}}
        cache.save(data, path=self.path)
        self.assertEqual(cache.load(path=self.path), data)

    def test_missing_file_is_empty(self):
        self.assertEqual(cache.load(path=os.path.join(self.tmpdir, 'missing.json')), {})

    def test_broken_file_is_ignored(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write('{not json')
        self.assertEqual(cache.load(path=self.path), {})

    def test_non_object_json_is_ignored(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write('[1, 2]')
        self.assertEqual(cache.load(path=self.path), {})

    def test_save_after_broken_load_rebuilds_file(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write('not json at all')
        loaded = cache.load(path=self.path)
        self.assertEqual(loaded, {})
        loaded['/x.jsonl'] = {'mtime': 1.0, 'size': 1, 'head': {}, 'last_activity': None}
        cache.save(loaded, path=self.path)
        self.assertEqual(cache.load(path=self.path), loaded)


class TestScanUsesCache(unittest.TestCase):
    """Verifies that when scan() is given a cache dict, a second call doesn't invoke
    read_head_info / read_last_activity again for an unchanged file (i.e. it never
    opens the transcript)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.proj = os.path.join(self.tmp.name, 'proj')
        os.makedirs(self.proj)
        self.path = os.path.join(self.proj, ID1 + '.jsonl')
        write_jsonl(self.path, [
            {'type': 'user', 'cwd': '/a', 'message': {'role': 'user', 'content': 'initial question'}},
        ])
        # Back-date the mtime a bit: scan() always re-reads a file whose mtime is within
        # `RACY_WINDOW` seconds of now, since two rewrites in the same clock tick might
        # be indistinguishable by mtime alone (this guards against coarse-grained clocks
        # on some filesystems). This test calls scan() immediately after writing, so
        # back-dating the mtime sidesteps that guard and lets us exercise the cache-hit
        # path itself.
        old = time.time() - 10.0
        os.utime(self.path, (old, old))

    def tearDown(self):
        self.tmp.cleanup()

    def test_second_scan_does_not_open_the_transcript(self):
        c = {}
        first = scan([self.path], cache=c)
        self.assertIn(ID1, first)
        self.assertIn(self.path, c)

        real_open = open
        with mock.patch('builtins.open', wraps=real_open) as mocked:
            second = scan([self.path], cache=c)
        self.assertEqual(mocked.call_count, 0)
        self.assertEqual(second[ID1].cwd, first[ID1].cwd)
        self.assertEqual(second[ID1].first_prompt, first[ID1].first_prompt)
        self.assertEqual(second[ID1].mtime, first[ID1].mtime)

    def test_changed_file_is_reread(self):
        c = {}
        scan([self.path], cache=c)
        write_jsonl(self.path, [
            {'type': 'user', 'cwd': '/a', 'message': {'role': 'user', 'content': 'updated content'}},
        ])
        second = scan([self.path], cache=c)
        self.assertEqual(second[ID1].first_prompt, 'updated content')

    def test_racy_mtime_forces_reread_even_if_cache_matches(self):
        """On filesystems with coarse mtime granularity (tmpfs, some containers), two
        rewrites that land within the same clock tick can leave both mtime and size
        unchanged. Simulate that here by building a cache entry whose mtime/size match
        the file's current stat exactly ("the cache agrees, but the mtime is recent"),
        and confirm that scan() still re-reads the file instead of trusting it
        (this is what RACY_WINDOW guards against)."""
        # setUp backdated the mtime, so here we make it look like the file was just
        # written, and build a cache entry from that same mtime/size (so the cache
        # matches, but is recent). We seed the cached head with stale content so it's
        # distinguishable from what's actually in the file.
        os.utime(self.path, None)
        st = os.stat(self.path)
        c = {self.path: {
            'mtime': st.st_mtime, 'size': st.st_size,
            'head': {'cwd': '/a', 'prompt': 'stale cached content', 'child': False},
            'last_activity': None,
        }}
        result = scan([self.path], cache=c)
        self.assertEqual(result[ID1].first_prompt, 'initial question')


if __name__ == '__main__':
    unittest.main()

import json
import os
import shutil
import tempfile
import time
import unittest
from unittest import mock

from agentsessions import cache
from agentsessions.scan import scan

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
    """scan() に cache dict を渡すと、2 回目は read_head_info・read_last_activity を
    呼ばない（= 該当 transcript を open しない）ことを確認する。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.proj = os.path.join(self.tmp.name, 'proj')
        os.makedirs(self.proj)
        self.path = os.path.join(self.proj, ID1 + '.jsonl')
        write_jsonl(self.path, [
            {'type': 'user', 'cwd': '/a', 'message': {'role': 'user', 'content': '最初の質問'}},
        ])
        # mtime を少し過去にずらす：scan() は `RACY_WINDOW` 秒以内の mtime を「同じ tick の
        # 書換えを mtime だけでは見分けられないかもしれない」として常に読み直す（クロックの
        # 粒度が粗い環境向け）。直後に scan するこのテストでは、その扱いを外して
        # キャッシュ命中の経路そのものを確かめる。
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
            {'type': 'user', 'cwd': '/a', 'message': {'role': 'user', 'content': '書き換え後'}},
        ])
        second = scan([self.path], cache=c)
        self.assertEqual(second[ID1].first_prompt, '書き換え後')

    def test_racy_mtime_forces_reread_even_if_cache_matches(self):
        """mtime の粒度が粗いクロック（tmpfs・一部のコンテナ等）では、同じ tick に収まる
        2 度の書換えで mtime も size も変わらないことがある。そのケースを模して、
        「キャッシュは一致しているが mtime が新しい」状態を直接作り、それでも読み直す
        ことを確かめる（RACY_WINDOW）。"""
        # setUp で mtime を過去にずらしているので、ここで「たった今書かれた」ことにし、
        # その時点の mtime・size をそのままキャッシュに仕立てる（＝キャッシュは一致するが
        # 新しい）。中身は古いキャッシュの値を仕込み、実ファイルの中身と区別できるようにする。
        os.utime(self.path, None)
        st = os.stat(self.path)
        c = {self.path: {
            'mtime': st.st_mtime, 'size': st.st_size,
            'head': {'cwd': '/a', 'prompt': '古いキャッシュの内容', 'child': False},
            'last_activity': None,
        }}
        result = scan([self.path], cache=c)
        self.assertEqual(result[ID1].first_prompt, '最初の質問')


if __name__ == '__main__':
    unittest.main()

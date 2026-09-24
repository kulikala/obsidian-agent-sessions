import time, unittest
from agentsessions.sessions.model import Session, Row, Doc, split_name, fmt_time, folder_of, row_from

class TestModel(unittest.TestCase):
    def test_split_name_grouped(self):
        self.assertEqual(split_name('RIM: Fit&Gap approach'), ('RIM', 'Fit&Gap approach'))

    def test_split_name_single(self):
        self.assertEqual(split_name('swimlane-app'), (None, 'swimlane-app'))

    def test_split_name_first_separator_only(self):
        self.assertEqual(split_name('A: B: C'), ('A', 'B: C'))

    def test_split_name_colon_without_space_is_single(self):
        self.assertEqual(split_name('http://x'), (None, 'http://x'))

    def test_fmt_time(self):
        t = time.mktime((2026, 8, 28, 16, 6, 0, 0, 0, -1))
        self.assertEqual(fmt_time(t), '2026-08-28 16:06')

    def test_folder_of(self):
        self.assertEqual(folder_of('/Users/k/work/slide-tool'), 'slide-tool')
        self.assertEqual(folder_of('/'), '/')
        self.assertEqual(folder_of(''), '')

    def test_row_from(self):
        s = Session(id='abc', name='RIM: X', cwd='/a/b', mtime=0.0, path='/p', first_prompt='')
        r = row_from(s)
        self.assertEqual((r.id, r.name, r.folder), ('abc', 'RIM: X', 'b'))
        self.assertRegex(r.updated, r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$')

    def test_doc_defaults(self):
        d = Doc()
        self.assertEqual((d.folded, d.hidden, d.rows, d.extra_front), ([], {}, [], []))

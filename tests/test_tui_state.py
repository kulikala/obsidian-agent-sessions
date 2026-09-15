import unittest
from unittest import mock

from agentsessions.config import OTHER_GROUP
from agentsessions.model import Doc, Row, Session
from agentsessions.tui import State

A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'


def sess(sid, name, mtime=1.0):
    return Session(id=sid, name=name, cwd='/v', mtime=mtime, path='/p')


def row(sid, name):
    return Row(id=sid, name=name, updated='2026-01-01 00:00', folder='v')


class TestTuiState(unittest.TestCase):
    """State は curses に依存しないので、直接組み立てて検証できる。
    persist は agentsessions.tui.persist をパッチし、何も書き込まれないようにする。"""

    def setUp(self):
        self.doc = Doc(rows=[row(A, 'RIM: a'), row(B, 'swimlane')])
        self.scanned = {A: sess(A, 'RIM: a'), B: sess(B, 'swimlane')}
        patcher = mock.patch('agentsessions.tui.persist')
        self.mock_persist = patcher.start()
        self.addCleanup(patcher.stop)
        self.st = State(self.doc, self.scanned)
        # items: group RIM(0), session a(1), session swimlane(0), group その他(0)

    def test_jump_to_group_from_child_lands_on_header(self):
        self.st.cursor = 1
        self.assertEqual(self.st.items[self.st.cursor].kind, 'session')
        self.st.jump_to_group()
        header = self.st.items[self.st.cursor]
        self.assertEqual((header.kind, header.label), ('group', 'RIM'))

    def test_set_fold_named_group_adds_to_doc_folded_and_persists(self):
        header = self.st.items[0]
        self.assertEqual(header.label, 'RIM')
        self.st.set_fold(header, True)
        self.assertIn('RIM', self.st.doc.folded)
        self.mock_persist.assert_called()
        # 折り畳んだので子は items から消える
        self.assertNotIn(('session', 'a'), [(i.kind, i.label) for i in self.st.items])

    def test_set_fold_other_group_flips_flag_without_touching_doc_folded(self):
        other = [i for i in self.st.items if i.kind == 'group' and i.label == OTHER_GROUP][0]
        self.st.set_fold(other, True)
        self.assertTrue(self.st.other_folded)
        self.assertEqual(self.st.doc.folded, [])
        self.mock_persist.assert_not_called()

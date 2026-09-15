import unittest
from unittest import mock

from agentsessions import store as store_mod
from agentsessions.config import OTHER_GROUP
from agentsessions.model import Session
from agentsessions.tui import State, panel_width

A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'


def sess(sid, name, mtime=1.0):
    return Session(id=sid, name=name, cwd='/v', mtime=mtime, path='/p')


class TestTuiState(unittest.TestCase):
    """State は curses に依存しないので、直接組み立てて検証できる。
    `store.update` は `agentsessions.store.update` をパッチし、実ファイルへ書かせない
    代わりに、渡された関数をその場の Store へ適用する。"""

    def setUp(self):
        self.store = store_mod.Store()
        self.scanned = {A: sess(A, 'RIM: a'), B: sess(B, 'swimlane')}

        def fake_update(fn, *a, **kw):
            fn(self.store)
            return self.store

        patcher = mock.patch('agentsessions.store.update', side_effect=fake_update)
        self.mock_update = patcher.start()
        self.addCleanup(patcher.stop)
        self.st = State(self.store, self.scanned)
        # items: group RIM(0), session a(1), session swimlane(0), group その他(0)

    def test_jump_to_group_from_child_lands_on_header(self):
        self.st.cursor = 1
        self.assertEqual(self.st.items[self.st.cursor].kind, 'session')
        self.st.jump_to_group()
        header = self.st.items[self.st.cursor]
        self.assertEqual((header.kind, header.label), ('group', 'RIM'))

    def test_set_fold_named_group_adds_to_store_folded_and_saves(self):
        header = self.st.items[0]
        self.assertEqual(header.label, 'RIM')
        self.st.set_fold(header, True)
        self.assertIn('RIM', self.st.doc.folded)
        self.assertIn('RIM', self.store.folded)
        self.mock_update.assert_called()
        # 折り畳んだので子は items から消える
        self.assertNotIn(('session', 'a'), [(i.kind, i.label) for i in self.st.items])

    def test_set_fold_other_group_flips_flag_without_touching_store(self):
        other = [i for i in self.st.items if i.kind == 'group' and i.label == OTHER_GROUP][0]
        self.st.set_fold(other, True)
        self.assertTrue(self.st.other_folded)
        self.assertEqual(self.st.doc.folded, [])
        self.mock_update.assert_not_called()


class TestArchivedVisibility(unittest.TestCase):
    """h（アーカイブ表示）は Store.archived を Doc.hidden として反映するだけで、
    tui.py に個別セッションを非表示にする操作はもう無い。"""

    def test_archived_session_hidden_until_show_hidden(self):
        store_snapshot = store_mod.Store(archived=[{'id': A, 'name': 'RIM: a', 'agent': 'claude'}])
        scanned = {A: sess(A, 'RIM: a')}
        st = State(store_snapshot, scanned)
        self.assertNotIn(('session', 'a'), [(i.kind, i.label) for i in st.items])

        st.show_hidden = True
        st.rebuild()
        self.assertIn(('session', 'a'), [(i.kind, i.label) for i in st.items])


class TestPanelWidth(unittest.TestCase):
    def test_below_threshold_is_toggle_mode(self):
        self.assertEqual(panel_width(59), 0)

    def test_at_threshold(self):
        self.assertEqual(panel_width(60), 30)

    def test_mid_width(self):
        self.assertEqual(panel_width(100), 40)

    def test_wide_caps_at_60(self):
        self.assertEqual(panel_width(200), 60)

    def test_120_is_48(self):
        self.assertEqual(panel_width(120), 48)


if __name__ == '__main__':
    unittest.main()

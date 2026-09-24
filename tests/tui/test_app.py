import io
import unittest
from unittest import mock

from agentsessions import config, i18n
from agentsessions import store as store_mod
from agentsessions.config import OTHER_GROUP
from agentsessions.model import Session
from agentsessions.tui import State, list_columns, main, panel_width
from agentsessions.tui import _group_label

A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'


def sess(sid, name, mtime=1.0):
    return Session(id=sid, name=name, cwd='/v', mtime=mtime, path='/p')


class TestTuiState(unittest.TestCase):
    """State doesn't depend on curses, so it can be built directly and verified.
    `store.update` is patched (via `agentsessions.store.update`) so tests never write
    to a real file; instead the patch applies the given function to the in-memory Store."""

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
        # items: group RIM(0), session a(1), session swimlane(0), group Other(0)

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
        # Once folded, the child item disappears from items
        self.assertNotIn(('session', 'a'), [(i.kind, i.label) for i in self.st.items])

    def test_set_fold_other_group_flips_flag_without_touching_store(self):
        other = [i for i in self.st.items if i.kind == 'group' and i.label == OTHER_GROUP][0]
        self.st.set_fold(other, True)
        self.assertTrue(self.st.other_folded)
        self.assertEqual(self.st.doc.folded, [])
        self.mock_update.assert_not_called()


class TestArchivedVisibility(unittest.TestCase):
    """The 'h' (show archived) toggle simply mirrors Store.archived into Doc.hidden;
    tui.py no longer has a separate operation for hiding an individual session."""

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


class TestListColumns(unittest.TestCase):
    """The name column is always kept. The date and folder columns are dropped when there isn't enough width."""

    def test_narrow_drops_both_date_and_folder(self):
        self.assertEqual(list_columns(39), (False, False))

    def test_cols_60_with_panel_leaves_list_too_narrow_for_either_column(self):
        # At cols=60, panel_width(60)=30, so list_w works out to 28.
        # Reproduces a regression, caught during acceptance testing, where the name
        # column had ended up 0 characters wide.
        list_w = 60 - (panel_width(60) + 2)
        self.assertEqual(list_w, 28)
        self.assertEqual(list_columns(list_w), (False, False))

    def test_date_shown_once_wide_enough(self):
        self.assertEqual(list_columns(40), (True, False))
        self.assertEqual(list_columns(55), (True, False))

    def test_folder_shown_once_wide_enough(self):
        self.assertEqual(list_columns(56), (True, True))


class TestMainVaultCheck(unittest.TestCase):
    """When the vault can't be determined, execution stops before curses is ever started."""

    def test_returns_1_and_prints_message_when_vault_not_configured(self):
        with mock.patch.object(config, 'VAULT', None), mock.patch('sys.stderr', io.StringIO()) as err:
            code = main()
        self.assertEqual(code, 1)
        self.assertIn('AGENT_SESSIONS_VAULT', err.getvalue())


class TestGroupLabel(unittest.TestCase):
    """`OTHER_GROUP` is a persisted identifier (kept in Japanese on disk, see
    config.py) that isn't itself display text — `_group_label` maps it to the current
    UI language's label instead of showing the raw persisted string."""

    def test_other_group_is_translated(self):
        self.assertEqual(_group_label(OTHER_GROUP), i18n.t('tui.other_group'))

    def test_ordinary_group_label_is_unchanged(self):
        self.assertEqual(_group_label('RIM'), 'RIM')


if __name__ == '__main__':
    unittest.main()

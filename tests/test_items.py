import unittest
from agentsessions.config import OTHER_GROUP
from agentsessions.items import build_items, dw, fit
from agentsessions.model import Doc, Row, Session

A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
C = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
D = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
E = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
F = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
G = 'gggggggg-gggg-gggg-gggg-gggggggggggg'


def sess(sid, name, mtime=1.0, prompt='', child=False):
    return Session(id=sid, name=name, cwd='/v', mtime=mtime, path='/p', first_prompt=prompt, child=child)


def row(sid, name):
    return Row(id=sid, name=name, updated='2026-01-01 00:00', folder='v')


class TestWidth(unittest.TestCase):
    def test_dw(self):
        self.assertEqual(dw('ab'), 2)
        self.assertEqual(dw('フカ'), 4)
        self.assertEqual(dw('a&フ'), 4)

    def test_fit_truncates_by_width(self):
        self.assertEqual(fit('フカガワ', 5), 'フカ…')
        self.assertEqual(fit('abc', 5), 'abc')
        self.assertEqual(fit('abcdef', 4), 'abc…')

    def test_fit_pads(self):
        self.assertEqual(fit('ab', 4, pad=True), 'ab  ')
        self.assertEqual(fit('フ', 3, pad=True), 'フ ')


class TestBuildItems(unittest.TestCase):
    # mtime: RIM b=30, RIM a=20, swimlane=40, Cinderella x=10
    # 群の並びは群内の最新 mtime の降順 → RIM(30) が Cinderella(10) より先。
    # 単独は群のあとにまとめて mtime 降順 → swimlane(40) は最速でも群のあとに来る。
    def setUp(self):
        self.doc = Doc(rows=[row(A, 'RIM: b'), row(B, 'RIM: a'), row(C, 'swimlane'), row(D, 'Cinderella: x')],
                       hidden={E: 'RIM: hidden'})
        self.scanned = {
            A: sess(A, 'RIM: b', mtime=30.0), B: sess(B, 'RIM: a', mtime=20.0),
            C: sess(C, 'swimlane', mtime=40.0), D: sess(D, 'Cinderella: x', mtime=10.0),
            E: sess(E, 'RIM: hidden', mtime=25.0),
            F: sess(F, None, mtime=5.0, prompt='名無しの質問'),
            G: sess(G, None, mtime=6.0, prompt='サブエージェントの質問', child=True),
        }

    def flat(self, **kw):
        kw.setdefault('show_hidden', False)
        kw.setdefault('other_folded', True)
        kw.setdefault('filt', '')
        return [(i.kind, i.label, i.depth) for i in build_items(self.doc, self.scanned, **kw)]

    def test_groups_then_singles_then_other_by_recency(self):
        self.assertEqual(self.flat(), [
            ('group', 'RIM', 0), ('session', 'b', 1), ('session', 'a', 1),
            ('group', 'Cinderella', 0), ('session', 'x', 1),
            ('session', 'swimlane', 0),
            ('group', OTHER_GROUP, 0),
        ])

    def test_folded_group_hides_children(self):
        self.doc.folded = ['RIM']
        self.assertEqual([l for k, l, d in self.flat() if d == 1], ['x'])

    def test_other_expanded_lists_unnamed_by_mtime_desc(self):
        items = build_items(self.doc, self.scanned, show_hidden=False, other_folded=False, filt='')
        last = items[-1]
        self.assertEqual((last.kind, last.label, last.group, last.session.id), ('session', '名無しの質問', OTHER_GROUP, F))
        self.assertEqual(items[-2].count, 1)

    def test_other_label_truncated_to_40(self):
        self.scanned[F].first_prompt = 'あ' * 50
        items = build_items(self.doc, self.scanned, show_hidden=False, other_folded=False, filt='')
        self.assertEqual(len(items[-1].label), 40)

    def test_hidden_shown_in_group_when_requested(self):
        items = build_items(self.doc, self.scanned, show_hidden=True, other_folded=True, filt='')
        rim = [i for i in items if i.group == 'RIM' and i.kind == 'session']
        self.assertEqual([(i.label, i.hidden) for i in rim], [('b', False), ('a', False), ('hidden', True)])

    def test_hidden_not_shown_by_default(self):
        self.assertNotIn(('session', 'hidden', 1), self.flat())

    def test_filter_matches_group_or_name_and_ignores_fold(self):
        self.doc.folded = ['RIM']
        self.assertEqual(self.flat(filt='rim'), [('group', 'RIM', 0), ('session', 'b', 1), ('session', 'a', 1)])
        self.assertEqual(self.flat(filt='swim'), [('session', 'swimlane', 0)])
        self.assertEqual(self.flat(filt='名無し'), [('group', OTHER_GROUP, 0), ('session', '名無しの質問', 1)])

    def test_group_count(self):
        g = [i for i in build_items(self.doc, self.scanned, False, True, '') if i.label == 'RIM'][0]
        self.assertEqual(g.count, 2)

    def test_hidden_unnamed_shown_under_other_when_requested(self):
        self.doc.hidden[F] = ''
        items = build_items(self.doc, self.scanned, show_hidden=True, other_folded=False, filt='')
        last = items[-1]
        self.assertEqual((last.kind, last.group, last.hidden, last.session.id), ('session', OTHER_GROUP, True, F))
        self.assertEqual([i for i in items if i.label == OTHER_GROUP][0].count, 1)

    def test_child_session_excluded_from_other(self):
        items = build_items(self.doc, self.scanned, show_hidden=False, other_folded=False, filt='')
        self.assertNotIn(G, [i.session.id for i in items if i.session is not None])
        other = [i for i in items if i.label == OTHER_GROUP][0]
        self.assertEqual(other.count, 1)   # F のみ、G(child) は数えない


class TestWrap(unittest.TestCase):
    def test_wraps_by_display_width(self):
        from agentsessions.items import dw, wrap
        lines = wrap('あいうえおかきくけこ', 6)
        self.assertEqual(lines, ['あいう', 'えおか', 'きくけ', 'こ'])
        self.assertTrue(all(dw(l) <= 6 for l in lines))

    def test_keeps_words_and_newlines(self):
        from agentsessions.items import wrap
        self.assertEqual(wrap('hello world', 7), ['hello', 'world'])
        self.assertEqual(wrap('a\nb', 5), ['a', 'b'])

    def test_breaks_overlong_word(self):
        from agentsessions.items import wrap
        self.assertEqual(wrap('abcdefgh', 3), ['abc', 'def', 'gh'])

    def test_zero_width(self):
        from agentsessions.items import wrap
        self.assertEqual(wrap('x', 0), [])

import re
import unicodedata
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .config import OTHER_GROUP
from .model import Doc, Session, split_name

OTHER_LABEL_LEN = 40


@dataclass
class Item:
    kind: str                        # 'group' | 'session'
    label: str
    group: Optional[str]
    session: Optional[Session]
    hidden: bool = False
    depth: int = 0
    count: int = 0                   # group のとき子の数


def dw(s: str) -> int:
    return sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in s)


def fit(s: str, width: int, pad: bool = False) -> str:
    if width <= 0:
        return ''
    if dw(s) <= width:
        return s + ' ' * (width - dw(s)) if pad else s
    out = ''
    for c in s:
        if dw(out + c) > width - 1:
            break
        out += c
    out += '…'
    return out + ' ' * (width - dw(out)) if pad else out


_TOKEN_RE = re.compile(r'[A-Za-z0-9_@#/\\.\-:]+|.', re.S)


def wrap(text: str, width: int) -> List[str]:
    """表示幅で折り返す。欧文は語で、和文は字で割る。"""
    if width <= 0:
        return []
    lines: List[str] = []
    for para in text.split('\n'):
        cur = ''
        for tok in _TOKEN_RE.findall(para):
            if tok == ' ' and not cur:
                continue
            if dw(cur + tok) <= width:
                cur += tok
                continue
            if cur:
                lines.append(cur.rstrip())
                cur = ''
            while dw(tok) > width:      # 1 語が幅を超えるときは割る
                cut = ''
                for ch in tok:
                    if dw(cut + ch) > width:
                        break
                    cut += ch
                lines.append(cut)
                tok = tok[len(cut):]
            cur = '' if tok.isspace() else tok
        lines.append(cur.rstrip())
    return lines


def _match(filt: str, *texts: str) -> bool:
    if not filt:
        return True
    f = filt.lower()
    return any(f in (t or '').lower() for t in texts)


def build_items(doc: Doc, scanned: Dict[str, Session], show_hidden: bool,
                other_folded: bool, filt: str) -> List[Item]:
    # (グループ or None, 個別名, Session, hidden)
    entries: List[Tuple[Optional[str], str, Session, bool]] = []
    for r in doc.rows:
        s = scanned.get(r.id)
        if s is None:
            continue
        g, sub = split_name(r.name)
        entries.append((g, sub, s, False))
    if show_hidden:
        for sid, name in doc.hidden.items():
            s = scanned.get(sid)
            if s is None or not s.name:
                continue
            g, sub = split_name(s.name)
            entries.append((g, sub, s, True))

    groups: Dict[str, List[Tuple[str, Session, bool]]] = {}
    singles: List[Tuple[str, Session, bool]] = []
    for g, sub, s, h in entries:
        if g is None:
            singles.append((sub, s, h))
        else:
            groups.setdefault(g, []).append((sub, s, h))

    def by_mtime_desc(children: List[Tuple[str, Session, bool]]) -> List[Tuple[str, Session, bool]]:
        return sorted(children, key=lambda c: (-c[1].mtime, c[0]))

    def group_key(name: str) -> Tuple[float, str]:
        managed = [c for c in groups[name] if not c[2]]
        src = managed or groups[name]   # 管理中が無ければ非表示（show_hidden のときだけ起こる）
        newest = max((c[1].mtime for c in src), default=0.0)
        return (-newest, name)

    items: List[Item] = []
    for name in sorted(groups, key=group_key):
        managed = by_mtime_desc([c for c in groups[name] if not c[2]])
        hidden_c = by_mtime_desc([c for c in groups[name] if c[2]])
        children = managed + hidden_c
        if filt and not _match(filt, name):
            children = [c for c in children if _match(filt, c[0])]
            if not children:
                continue
        items.append(Item('group', name, None, None, depth=0, count=len(children)))
        if name in doc.folded and not filt:
            continue
        for sub, s, h in children:
            items.append(Item('session', sub, name, s, hidden=h, depth=1))

    for sub, s, h in sorted(singles, key=lambda c: (-c[1].mtime, c[0])):
        if _match(filt, sub):
            items.append(Item('session', sub, None, s, hidden=h, depth=0))

    others = [(s, False) for s in scanned.values() if not s.name and not s.child and s.id not in doc.hidden]
    if show_hidden:
        others += [(s, True) for s in scanned.values() if not s.name and not s.child and s.id in doc.hidden]
    others.sort(key=lambda t: -t[0].mtime)
    labeled = [(s.first_prompt[:OTHER_LABEL_LEN] or s.id[:8], s, h) for s, h in others]
    if filt and not _match(filt, OTHER_GROUP):
        labeled = [(l, s, h) for l, s, h in labeled if _match(filt, l)]
        if not labeled:
            return items
    items.append(Item('group', OTHER_GROUP, None, None, depth=0, count=len(labeled)))
    if other_folded and not filt:
        return items
    for label, s, h in labeled:
        items.append(Item('session', label, OTHER_GROUP, s, hidden=h, depth=1))
    return items

import curses
import os
import time
from typing import Dict, List, Optional, Tuple

from . import config, jsonout, store
from .detail import Detail, read_detail
from .items import Item, build_items, dw, fit, wrap
from .live import Live, live_sessions
from .model import Doc, Session, fmt_time, folder_of, row_from, sort_rows
from .scan import list_transcripts, scan

HELP = ('↑↓/jk 移動  ⏎ 起動  ← 親へ/畳む  → 開く  h アーカイブ表示  '
        '/ 絞込  p パネル  r 再走査  q 終了')
DATE_W = 11      # MM-DD HH:MM
FOLDER_W = 18
PANEL_MIN_COLS = 60   # これより狭い端末では一覧とパネルを p で切り替える
LIVE_TTL = 1.0   # 起動中セッションの台帳を読み直す間隔（秒）
MARK_BUSY = '●'
MARK_IDLE = '○'
CP_BUSY, CP_IDLE, CP_HEAD = 1, 2, 3


def panel_width(cols: int) -> int:
    """サイドパネルの幅。`cols < PANEL_MIN_COLS` では 0（一覧⇄パネルの切替モード）。"""
    if cols < PANEL_MIN_COLS:
        return 0
    return max(30, min(60, int(cols * 0.4)))


def list_columns(list_w: int) -> Tuple[bool, bool]:
    """一覧のうち日付・フォルダ列を出すか（`show_date`, `show_folder`）。
    名前の列は幅がどれだけ狭くても常に残す。"""
    show_folder = list_w >= 56
    show_date = list_w >= 40
    return show_date, show_folder


def _doc_from_store(st: store.Store, scanned: Dict[str, Session]) -> Doc:
    """`items.build_items` が読む形（`Doc`）に、`Store` と走査結果を合わせる。
    `archived` が非表示、それ以外の名前付きセッションが管理中の行になる。"""
    hidden = {a['id']: a.get('name', '') for a in st.archived}
    rows = [row_from(s) for s in scanned.values() if s.name and s.id not in hidden]
    return Doc(folded=list(st.folded), hidden=hidden, rows=sort_rows(rows))


class State:
    def __init__(self, store_snapshot: store.Store, scanned: Dict[str, Session]):
        self.store = store_snapshot
        self.scanned = scanned
        self.doc = _doc_from_store(self.store, self.scanned)
        self.show_hidden = False   # 'h' でアーカイブを見せる
        self.other_folded = True
        self.filt = ''
        self.cursor = 0
        self.top = 0
        self.panel_only = False    # cols < PANEL_MIN_COLS のときだけ効く（'p' で切替）
        self.live: Dict[str, Live] = {}
        self.live_at = 0.0
        self.details: Dict[str, Detail] = {}
        self.items: List[Item] = []
        self.refresh_live(force=True)
        self.rebuild()

    def refresh_live(self, force: bool = False) -> None:
        now = time.monotonic()
        if force or now - self.live_at > LIVE_TTL:
            self.live = live_sessions()
            self.live_at = now

    def live_of(self, s: Optional[Session]) -> Optional[Live]:
        return self.live.get(s.id) if s else None

    def detail_of(self, s: Session) -> Detail:
        if s.id not in self.details:
            try:
                self.details[s.id] = read_detail(s.path)
            except OSError:
                self.details[s.id] = Detail()
        return self.details[s.id]

    def rebuild(self) -> None:
        self.items = build_items(self.doc, self.scanned, self.show_hidden, self.other_folded, self.filt)
        self.cursor = max(0, min(self.cursor, len(self.items) - 1))

    def current(self) -> Optional[Item]:
        return self.items[self.cursor] if self.items else None

    def move(self, delta: int) -> None:
        if self.items:
            self.cursor = max(0, min(self.cursor + delta, len(self.items) - 1))

    def toggle_fold(self, item: Item) -> None:
        if item.kind != 'group':
            return
        if item.label == config.OTHER_GROUP:
            self.set_fold(item, not self.other_folded)
        else:
            self.set_fold(item, item.label not in self.doc.folded)

    def set_fold(self, item: Item, folded: bool) -> None:
        if item.kind != 'group':
            return
        if item.label == config.OTHER_GROUP:
            self.other_folded = folded
        else:
            group = item.label
            in_folded = group in self.doc.folded
            if folded != in_folded:
                self.store = store.update(
                    lambda st, group=group, folded=folded: store.set_folded(st, group, folded))
                self.doc.folded = list(self.store.folded)
        self.rebuild()

    def jump_to_group(self) -> None:
        for i in range(self.cursor - 1, -1, -1):
            if self.items[i].kind == 'group':
                self.cursor = i
                return

    def rescan(self) -> None:
        self.store = store.load()
        self.scanned = scan(list_transcripts(config.PROJECTS_DIR))
        self.doc = _doc_from_store(self.store, self.scanned)
        self.details.clear()
        self.refresh_live(force=True)
        self.rebuild()

    def counts(self) -> str:
        managed = len(self.doc.rows)
        hidden = len(self.doc.hidden)
        other = sum(1 for s in self.scanned.values()
                    if not s.name and not s.child and s.id not in self.doc.hidden)
        running = sum(1 for sid in self.live if sid in self.scanned)
        return '管理中 %d ／ アーカイブ %d ／ その他 %d ／ 起動中 %d' % (managed, hidden, other, running)


def _put(stdscr, y: int, x: int, s: str, attr: int = curses.A_NORMAL) -> None:
    rows, cols = stdscr.getmaxyx()
    if y < 0 or y >= rows or x >= cols:
        return
    try:
        stdscr.addstr(y, x, s, attr)
    except curses.error:
        pass


def _color(pair: int, fallback: int = curses.A_NORMAL) -> int:
    try:
        if curses.has_colors():
            return curses.color_pair(pair)
    except curses.error:
        pass
    return fallback


def _mark_of(live: Optional[Live]) -> Tuple[str, int]:
    if live is None:
        return ' ', curses.A_NORMAL
    if live.busy:
        return MARK_BUSY, _color(CP_BUSY, curses.A_BOLD)
    return MARK_IDLE, _color(CP_IDLE)


def _panel_lines(st: State, it: Optional[Item], width: int, height: int) -> List[Tuple[str, int]]:
    """サイドパネルの中身。(文字列, 属性) の並び。"""
    out: List[Tuple[str, int]] = []

    def add(text: str = '', attr: int = curses.A_NORMAL) -> None:
        out.append((text, attr))

    def block(title: str, body: str, limit: int) -> None:
        add()
        add(title, _color(CP_HEAD, curses.A_BOLD) | curses.A_BOLD)
        lines = wrap(body, width) if body else ['（なし）']
        for ln in lines[:limit]:
            add(ln, curses.A_DIM if not body else curses.A_NORMAL)
        if len(lines) > limit:
            add('…', curses.A_DIM)

    if it is None:
        add('セッションがありません', curses.A_DIM)
        return out

    if it.kind == 'group':
        add(it.label, curses.A_BOLD)
        add('グループ ／ %d 件' % it.count, curses.A_DIM)
        kids = [i for i in st.items if i.group == it.label and i.session]
        running = [i for i in kids if st.live_of(i.session)]
        if kids:
            newest = max(i.session.mtime for i in kids)
            add()
            add('最終更新  %s' % fmt_time(newest))
        add('起動中    %d 件' % len(running))
        return out

    s = it.session
    if s is None:
        return out
    live = st.live_of(s)
    compact = height < 18       # 背の低い端末では見出しを削って本文に回す
    add(s.name or it.label, curses.A_BOLD)
    mark, attr = _mark_of(live)
    if live:
        add('%s %s  pid %d' % (mark, live.label, live.pid), attr | curses.A_BOLD)
    else:
        add('  停止中', curses.A_DIM)
    if not compact:
        add()
    add('最終更新  %s' % fmt_time(s.mtime))
    if not compact:
        add('フォルダ  %s' % fit(folder_of(s.cwd), width - 10))
        add('ID        %s' % s.id[:18], curses.A_DIM)
    if it.hidden:
        add('（アーカイブ）', curses.A_DIM)

    d = st.detail_of(s)
    rest = max(0, height - len(out) - 6)
    user_lines = min(8, max(2, rest // 2))
    block('直近の指示', d.last_user, user_lines)
    if d.tools:
        add()
        add('直近のツール', _color(CP_HEAD, curses.A_BOLD) | curses.A_BOLD)
        for ln in wrap('、'.join(d.tools[:6]), width)[:2]:
            add(ln, curses.A_DIM)
    block('直近の応答', d.last_assistant, max(3, height - len(out) - 3))
    return out


def _draw_panel(stdscr, st: State, x0: int, top: int, height: int, border: bool = True) -> None:
    cols = stdscr.getmaxyx()[1]
    width = cols - x0 - (1 if border else 0)
    if width <= 4:
        return
    if border:
        for i in range(height):
            _put(stdscr, top + i, x0 - 1, '│')
    lines = _panel_lines(st, st.current(), width, height)
    for i, (text, attr) in enumerate(lines[:height]):
        _put(stdscr, top + i, x0, fit(text, width, pad=True), attr)


def _draw(stdscr, st: State) -> None:
    stdscr.erase()
    rows, cols = stdscr.getmaxyx()
    body_h = max(0, rows - 4)
    if st.cursor < st.top:
        st.top = st.cursor
    if st.cursor >= st.top + body_h:
        st.top = st.cursor - body_h + 1

    pw = panel_width(cols)
    toggle_mode = pw == 0
    show_panel_only = toggle_mode and st.panel_only
    show_list = not show_panel_only
    show_panel = pw > 0 or show_panel_only

    title = 'Agent Sessions'
    right = st.counts()
    _put(stdscr, 0, 0, fit(' ' + title, cols - dw(right) - 2, pad=True) + right, curses.A_BOLD)
    _put(stdscr, 1, 0, '─' * (cols - 1))

    if show_list:
        list_w = cols - (pw + 2) if pw else cols - 1
        show_date, show_folder = list_columns(list_w)
        if show_folder:
            label_w = list_w - 4 - DATE_W - 2 - FOLDER_W
        elif show_date:
            label_w = list_w - 4 - DATE_W
        else:
            label_w = list_w - 2
        for i in range(body_h):
            idx = st.top + i
            if idx >= len(st.items):
                break
            it = st.items[idx]
            attr = curses.A_REVERSE if idx == st.cursor else curses.A_NORMAL
            if it.kind == 'group':
                folded = (st.other_folded if it.label == config.OTHER_GROUP
                          else it.label in st.doc.folded) and not st.filt
                mark = '▸' if folded else '▾'
                line = fit(' %s %s (%d)' % (mark, it.label, it.count), list_w, pad=True)
                _put(stdscr, 2 + i, 0, line, attr | curses.A_BOLD)
                continue
            s = it.session
            indent = '   ' if it.depth else ' '
            live_mark, live_attr = _mark_of(st.live_of(s))
            label = it.label + (' (アーカイブ)' if it.hidden else '')
            left = fit(indent + label, label_w, pad=True)
            parts = [left]
            if show_date:
                parts.append(fmt_time(s.mtime)[5:] if s else '')
            if show_folder:
                parts.append(fit(folder_of(s.cwd) if s else '', FOLDER_W, pad=True))
            line = fit('  '.join(parts), list_w - 2, pad=True)
            if it.hidden:
                attr |= curses.A_DIM
            _put(stdscr, 2 + i, 0, live_mark, attr if idx == st.cursor else live_attr)
            _put(stdscr, 2 + i, 2, line, attr)

    if show_panel:
        if pw:
            _draw_panel(stdscr, st, cols - pw, 2, body_h, border=True)
        else:
            _draw_panel(stdscr, st, 0, 2, body_h, border=False)

    _put(stdscr, rows - 2, 0, '─' * (cols - 1))
    foot = ('絞込: %s  (Esc で解除)' % st.filt) if st.filt else HELP
    _put(stdscr, rows - 1, 0, fit(' ' + foot, cols - 1))
    stdscr.refresh()


def _read_filter(stdscr, st: State) -> None:
    buf = st.filt
    curses.curs_set(1)
    while True:
        rows, cols = stdscr.getmaxyx()
        stdscr.move(rows - 1, 0)
        stdscr.clrtoeol()
        _put(stdscr, rows - 1, 0, fit(' /' + buf, cols - 1))
        stdscr.refresh()
        ch = stdscr.get_wch()
        if ch in ('\n', '\r') or ch == curses.KEY_ENTER:
            break
        if ch == '\x1b':
            buf = ''
            break
        if ch in ('\x7f', '\b') or ch == curses.KEY_BACKSPACE:
            buf = buf[:-1]
        elif isinstance(ch, str) and ch.isprintable():
            buf += ch
        st.filt = buf
        st.rebuild()
        _draw(stdscr, st)
    curses.curs_set(0)
    st.filt = buf
    st.rebuild()


def _loop(stdscr, st: State) -> Optional[Session]:
    if hasattr(curses, 'set_escdelay'):
        curses.set_escdelay(25)
    curses.curs_set(0)
    try:
        curses.use_default_colors()
        curses.init_pair(CP_BUSY, curses.COLOR_GREEN, -1)
        curses.init_pair(CP_IDLE, curses.COLOR_CYAN, -1)
        curses.init_pair(CP_HEAD, curses.COLOR_YELLOW, -1)
    except curses.error:
        pass
    while True:
        st.refresh_live()
        _draw(stdscr, st)
        ch = stdscr.get_wch()
        it = st.current()
        if ch in ('q', '\x1b'):
            if st.filt and ch == '\x1b':
                st.filt = ''
                st.rebuild()
                continue
            return None
        if ch in ('j',) or ch == curses.KEY_DOWN:
            st.move(1)
        elif ch in ('k',) or ch == curses.KEY_UP:
            st.move(-1)
        elif ch == curses.KEY_NPAGE:
            st.move(10)
        elif ch == curses.KEY_PPAGE:
            st.move(-10)
        elif ch in ('\n', '\r') or ch == curses.KEY_ENTER:
            if it is None:
                continue
            if it.kind == 'group':
                st.toggle_fold(it)
            elif it.session is not None:
                return it.session
        elif ch == ' ':
            if it is not None:
                st.toggle_fold(it)
        elif ch == curses.KEY_LEFT:
            if it is not None:
                if it.kind == 'session' and it.depth == 1:
                    st.jump_to_group()
                elif it.kind == 'group':
                    st.set_fold(it, True)
        elif ch == curses.KEY_RIGHT:
            if it is not None and it.kind == 'group':
                st.set_fold(it, False)
        elif ch == 'h':
            st.show_hidden = not st.show_hidden
            st.rebuild()
        elif ch == 'p':
            st.panel_only = not st.panel_only
        elif ch == '/':
            _read_filter(stdscr, st)
        elif ch == 'r':
            st.rescan()
        elif ch == curses.KEY_RESIZE:
            pass


def run(store_snapshot: store.Store, scanned: Dict[str, Session]) -> Optional[Session]:
    st = State(store_snapshot, scanned)
    try:
        return curses.wrapper(lambda scr: _loop(scr, st))
    except KeyboardInterrupt:
        return None


def _launch(s: Session) -> int:
    """⏎ で選んだセッションを起動する。デーモンに乗っていれば attach、
    終了済みなら forget してから、それ以外はそのまま `claude --resume` する。
    デーモンを起動することはない。"""
    sock_path = jsonout.daemon_sock_path()
    daemon = jsonout.live_output().get('daemon') or {}
    if daemon.get('running'):
        entry = next((d for d in daemon.get('sessions', []) if d.get('id') == s.id), None)
        if entry is not None:
            if entry.get('exited') is not None:
                jsonout.send_daemon_op('forget', id=s.id, sock_path=sock_path)
            else:
                try:
                    from . import attach
                except ImportError:
                    attach = None
                if attach is not None:
                    return attach.run(s.id, sock_path)

    cwd = s.cwd if s.cwd and os.path.isdir(s.cwd) else config.VAULT
    os.chdir(cwd)
    os.execvp('claude', ['claude', '--resume', s.id])


def main() -> int:
    """引数なしの `agent-sessions` の入口。"""
    st = store.load()
    scanned = scan(list_transcripts(config.PROJECTS_DIR))
    s = run(st, scanned)
    if s is None:
        return 0
    return _launch(s)

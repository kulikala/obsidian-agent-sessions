"""`sessions.json` の読み書きとロック（D-3, §3.1）。"""

import json
import os
import tempfile
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

from . import config
from .model import Doc, Session


@dataclass
class Store:
    version: int = 1
    folded: List[str] = field(default_factory=list)
    archived: List[dict] = field(default_factory=list)
    pendingRenames: Dict[str, str] = field(default_factory=dict)
    sessions: Dict[str, dict] = field(default_factory=dict)
    migratedFrom: Optional[dict] = None


def _to_dict(store: Store) -> dict:
    out = {
        'version': store.version,
        'folded': store.folded,
        'archived': store.archived,
        'pendingRenames': store.pendingRenames,
        'sessions': store.sessions,
    }
    if store.migratedFrom is not None:
        out['migratedFrom'] = store.migratedFrom
    return out


def _from_dict(data: dict) -> Store:
    return Store(
        version=data.get('version', 1),
        folded=list(data.get('folded', [])),
        archived=list(data.get('archived', [])),
        pendingRenames=dict(data.get('pendingRenames', {})),
        sessions=dict(data.get('sessions', {})),
        migratedFrom=data.get('migratedFrom'),
    )


def load(path: str = config.STORE_PATH) -> Store:
    """無ければ空の Store。壊れていれば `path+'.broken-<YYYYmmddHHMMSS>'` に
    退避して空の Store を返す。"""
    if not os.path.exists(path):
        return Store()
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError('sessions.json is not an object')
        return _from_dict(data)
    except (OSError, ValueError):
        broken = path + '.broken-' + time.strftime('%Y%m%d%H%M%S')
        try:
            os.replace(path, broken)
        except OSError:
            pass
        return Store()


def save(store: Store, path: str = config.STORE_PATH) -> None:
    """tmp に書いて rename。呼び出し側が `Lock` の中で呼ぶ前提（`update` 参照）。"""
    dirpath = os.path.dirname(path) or '.'
    os.makedirs(dirpath, exist_ok=True)
    data = json.dumps(_to_dict(store), ensure_ascii=False, indent=1).encode('utf-8')
    fd, tmp = tempfile.mkstemp(dir=dirpath, prefix='.sessions.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class Lock:
    """`sessions.json.lock/` を `mkdir` で取る排他。作れた者がロックを持つ。

    `EEXIST` なら `retry_interval` 秒待って再試行し、`timeout` 秒で諦めて
    `TimeoutError`。ロックの mtime が `stale_after` 秒より古ければ壊れたもの
    として `rmdir` して取り直す。
    """

    def __init__(self, path: str = config.LOCK_DIR, timeout: float = 2.0,
                 retry_interval: float = 0.05, stale_after: float = 10.0):
        self.path = path
        self.timeout = timeout
        self.retry_interval = retry_interval
        self.stale_after = stale_after

    def __enter__(self) -> 'Lock':
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                os.mkdir(self.path)
                return self
            except FileExistsError:
                self._clear_if_stale()
                if time.monotonic() >= deadline:
                    raise TimeoutError('lock timed out: %s' % self.path)
                time.sleep(self.retry_interval)

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            os.rmdir(self.path)
        except OSError:
            pass

    def _clear_if_stale(self) -> None:
        try:
            age = time.time() - os.stat(self.path).st_mtime
        except OSError:
            return
        if age > self.stale_after:
            try:
                os.rmdir(self.path)
            except OSError:
                pass


def update(fn: Callable[[Store], None], path: str = config.STORE_PATH,
           lock_path: Optional[str] = None) -> Store:
    """ロックの中で読み→`fn(store)` で書き換え→保存。書き換えた Store を返す。"""
    if lock_path is None:
        lock_path = path + '.lock'
    with Lock(lock_path):
        store = load(path)
        fn(store)
        save(store, path)
    return store


def is_archived(store: Store, sid: str) -> bool:
    return any(a.get('id') == sid for a in store.archived)


def archive(store: Store, sid: str, name: str, agent: str) -> None:
    if is_archived(store, sid):
        return
    store.archived.append({'id': sid, 'name': name, 'agent': agent})


def unarchive(store: Store, sid: str) -> None:
    store.archived = [a for a in store.archived if a.get('id') != sid]


def set_folded(store: Store, group: str, folded: bool) -> None:
    has = group in store.folded
    if folded and not has:
        store.folded.append(group)
    elif not folded and has:
        store.folded.remove(group)


# --- tui.py（T-8 で書き換わる）向けの一時的な橋渡し ---
#
# 現在の tui.py は旧 md 形式の Doc（rows・hidden）を State に持つ。ここでは
# scan() の結果に sessions.json の archived を当てるだけの簡易実装を置く。
# pendingRenames・sessions（起動直後の控え）は見ない。


def sessions_for_tui() -> Tuple[Doc, Dict[str, Session]]:
    from .model import row_from, sort_rows
    from .scan import list_transcripts, scan

    scanned = scan(list_transcripts(config.PROJECTS_DIR))
    st = load()
    hidden = {a['id']: a.get('name', '') for a in st.archived}
    rows = [row_from(s) for s in scanned.values() if s.name and s.id not in hidden]
    doc = Doc(folded=list(st.folded), hidden=hidden, rows=sort_rows(rows))
    return doc, scanned


def persist(doc: Doc) -> None:
    want = dict(doc.hidden)

    def _apply(st: Store) -> None:
        st.folded = list(doc.folded)
        st.archived = [a for a in st.archived if a.get('id') in want]
        have = {a.get('id') for a in st.archived}
        for sid, name in want.items():
            if sid not in have:
                st.archived.append({'id': sid, 'name': name, 'agent': 'claude'})

    update(_apply)

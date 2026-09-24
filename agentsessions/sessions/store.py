"""Reading, writing, and locking for `sessions.json`."""

import json
import os
import tempfile
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from .. import config


@dataclass
class Store:
    version: int = 1
    folded: List[str] = field(default_factory=list)
    archived: List[dict] = field(default_factory=list)
    pendingRenames: Dict[str, str] = field(default_factory=dict)
    sessions: Dict[str, dict] = field(default_factory=dict)
    # Maps category name → palette index (0-11). Once assigned, an entry
    # never changes (the assignment logic itself lives in the plugin, in
    # `category.ts`'s `assignCategoryColor`). This module just passes the
    # mapping through and holds no assignment logic of its own.
    categoryColors: Dict[str, int] = field(default_factory=dict)
    migratedFrom: Optional[dict] = None


def _to_dict(store: Store) -> dict:
    out = {
        'version': store.version,
        'folded': store.folded,
        'archived': store.archived,
        'pendingRenames': store.pendingRenames,
        'sessions': store.sessions,
        'categoryColors': store.categoryColors,
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
        categoryColors=dict(data.get('categoryColors', {})),
        migratedFrom=data.get('migratedFrom'),
    )


def load(path: Optional[str] = config.STORE_PATH) -> Store:
    """Returns an empty Store if the file doesn't exist (including when
    `path` is `None`, meaning no vault is configured). If the file is
    corrupt, moves it aside to `path+'.broken-<YYYYmmddHHMMSS>'` and returns
    an empty Store. A reader must never crash just because no vault is
    configured — `json scan` normally gets its env from the plugin, but if
    it doesn't, it should simply return empty rather than fail."""
    if not path or not os.path.exists(path):
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


def save(store: Store, path: Optional[str] = config.STORE_PATH) -> None:
    """Writes to a temp file and renames it into place. Assumes the caller
    invokes this from inside a `Lock` (see `update`). If `path` is `None`
    (no vault configured), there's nowhere to write, so raises
    `VaultNotConfigured`."""
    if not path:
        raise config.VaultNotConfigured(config.VAULT_NOT_CONFIGURED_MESSAGE)
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
    """Mutual exclusion via `mkdir` on `sessions.json.lock/`: whoever creates
    the directory holds the lock.

    On `EEXIST`, waits `retry_interval` seconds and retries, giving up with
    a `TimeoutError` after `timeout` seconds. If the lock's mtime is older
    than `stale_after` seconds, treats it as abandoned, removes it with
    `rmdir`, and retries.
    """

    def __init__(self, path: Optional[str] = config.LOCK_DIR, timeout: float = 2.0,
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


def update(fn: Callable[[Store], None], path: Optional[str] = config.STORE_PATH,
           lock_path: Optional[str] = None) -> Store:
    """Reads inside the lock, applies the mutation via `fn(store)`, then
    saves. Returns the mutated Store. If `path` is `None` (no vault
    configured), raises `VaultNotConfigured`."""
    if not path:
        raise config.VaultNotConfigured(config.VAULT_NOT_CONFIGURED_MESSAGE)
    if lock_path is None:
        lock_path = path + '.lock'
    os.makedirs(os.path.dirname(lock_path) or '.', exist_ok=True)
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

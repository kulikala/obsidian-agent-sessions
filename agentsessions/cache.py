"""Scan cache used by `scan()` (`CACHE_PATH`).

Maps `path → {mtime, size, head, last_activity}`. Before reading a file,
`scan()` checks it against this cache, and skips calling `read_head_info`
and `read_last_activity` when `mtime` and `size` both match.
"""

import json
import os
import tempfile
from typing import Dict

from . import config


def load(path: str = config.CACHE_PATH) -> Dict[str, dict]:
    """Returns empty if the file doesn't exist. If it's corrupt, ignores it
    and returns empty too (the next `save` call rebuilds it)."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save(cache: Dict[str, dict], path: str = config.CACHE_PATH) -> None:
    dirpath = os.path.dirname(path) or '.'
    os.makedirs(dirpath, exist_ok=True)
    data = json.dumps(cache, ensure_ascii=False).encode('utf-8')
    fd, tmp = tempfile.mkstemp(dir=dirpath, prefix='.scan-cache.', suffix='.tmp')
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

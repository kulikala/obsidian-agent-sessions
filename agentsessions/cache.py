"""`scan()` の走査キャッシュ（`CACHE_PATH`。§5「キャッシュ」）。

`path → {mtime, size, head, last_activity}`。`scan()` は読む前にこれと照合し、
`mtime`・`size` が一致すれば `read_head_info`・`read_last_activity` を呼ばない。
"""

import json
import os
import tempfile
from typing import Dict

from . import config


def load(path: str = config.CACHE_PATH) -> Dict[str, dict]:
    """無ければ空。壊れていれば無視して空（次の `save` で作り直す）。"""
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

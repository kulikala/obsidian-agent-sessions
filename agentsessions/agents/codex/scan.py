"""Enumerating and caching Codex rollout transcripts -- the codex analogue of
`agentsessions.sessions.scan.scan`.

Shares the same cache-entry shape (`path -> {mtime, size, head, last_activity}`)
and the same `RACY_WINDOW` guard against coarse filesystem clocks (see
`agentsessions.sessions.scan`'s module docstring) as the claude adapter, so both
agents can share one `scan-cache.json` without collisions -- the path itself is
the cache key, and a Codex rollout path never collides with a Claude transcript
path.
"""
import os
import time
from typing import Dict, List, Optional

from ...sessions.model import Session
from . import names as _names
from . import rollout
from .rollout import Head, RACY_WINDOW


def scan(paths: List[str], cache: Optional[Dict[str, dict]] = None,
         home: Optional[str] = None) -> Dict[str, Session]:
    """Same contract as `sessions.scan.scan`, plus a one-shot batched `/rename`
    lookup (`names.lookup_names`) for every id found, applied before the
    "no name and no first message -> drop" rule so a renamed-but-empty thread
    isn't dropped."""
    home = home if home is not None else rollout.codex_home()
    now = time.time()
    heads: Dict[str, tuple] = {}   # sid -> (Head, last_activity, path)
    for p in paths:
        sid = rollout.session_id_of(p)
        if not sid:
            continue
        try:
            st = os.stat(p)
            cached = cache.get(p) if cache is not None else None
            racy = (now - st.st_mtime) < RACY_WINDOW
            if cached and not racy and cached.get('mtime') == st.st_mtime and cached.get('size') == st.st_size:
                head_d = cached.get('head') or {}
                h = Head(cwd=head_d.get('cwd', ''), prompt=head_d.get('prompt', ''),
                         child=bool(head_d.get('child')), source=head_d.get('source', ''))
                last_activity = cached.get('last_activity')
            else:
                last_activity = rollout.read_last_activity(p)
                h = rollout.read_head(p)
                if cache is not None:
                    cache[p] = {
                        'mtime': st.st_mtime,
                        'size': st.st_size,
                        'head': {'cwd': h.cwd, 'prompt': h.prompt, 'child': h.child, 'source': h.source},
                        'last_activity': last_activity,
                    }
        except OSError:
            continue
        heads[sid] = (h, last_activity, st.st_mtime, p)

    names = _names.lookup_names(home, list(heads.keys()))

    out: Dict[str, Session] = {}
    for sid, (h, last_activity, file_mtime, p) in heads.items():
        name = names.get(sid)
        if not name and not h.prompt:
            continue
        mtime = last_activity or file_mtime
        out[sid] = Session(id=sid, name=name, cwd=h.cwd, mtime=mtime, path=p,
                            first_prompt=h.prompt, child=h.child, agent='codex')
    return out

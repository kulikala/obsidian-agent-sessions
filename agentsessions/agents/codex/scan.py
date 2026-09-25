"""Enumerating and caching Codex rollout transcripts -- the codex analogue of
`agentsessions.sessions.scan.scan`.

Shares the same cache-entry shape (`path -> {mtime, size, schema_version, head,
last_activity}`) and the same `RACY_WINDOW` guard against coarse filesystem
clocks (see `agentsessions.sessions.scan`'s module docstring) as the claude
adapter, so both agents can share one `scan-cache.json` without collisions --
the path itself is the cache key, and a Codex rollout path never collides with
a Claude transcript path. `schema_version` (see `SCAN_SCHEMA_VERSION`, below) is
codex's own, independent of claude's `SCAN_SCHEMA_VERSION` -- an entry with a
stale or missing version is never trusted regardless of mtime/size.
"""
import os
import time
from typing import Dict, List, Optional

from ...sessions.model import Session
from . import names as _names
from . import rollout
from .rollout import Head, RACY_WINDOW

# Bumped whenever `rollout.read_head`'s extraction logic changes in a way that
# would make an old cache entry's `head` wrong -- same mechanism and same
# reasoning as `sessions.scan.SCAN_SCHEMA_VERSION`, versioned independently
# since claude's and codex's extraction logic change on their own schedules.
# 2: read_head switched from response_item role=user (which mixes in Codex's
# own injected context) to event_msg.user_message, and started filtering bare
# slash commands (see rollout.py's INJECTED_PREFIXES/is_real_user_text).
# 3 (T-101): read_head also recognizes event_msg.item_completed(UserMessage)
# (some Codex CLI versions, e.g. 0.156.1, have neither user_message events nor
# a cleanly-recoverable response_item -- this is the only source they do have),
# and a filtered response_item is now used as a last resort instead of never.
SCAN_SCHEMA_VERSION = 3


def scan(paths: List[str], cache: Optional[Dict[str, dict]] = None,
         home: Optional[str] = None) -> Dict[str, Session]:
    """Same contract as `sessions.scan.scan`, plus a one-shot batched lookup
    (`names.lookup_thread_info`) of `state_5.sqlite`'s `threads.name` (an
    explicit `/rename`) and `.title` (Codex's own auto-generated summary) for
    every id found. Name resolution, highest priority first: `threads.name` ->
    `threads.title` -> `rollout.read_head`'s own extraction (itself tiered --
    see that function). `threads.title` outranks the rollout extraction because
    it's computed by Codex itself from data this project doesn't always have
    cheap access to (T-101), not because the rollout extraction is unreliable
    -- when sqlite has nothing (unavailable, locked, or a thread not yet
    indexed there), the rollout-derived `first_prompt` is exactly as good as
    before.

    Unlike `sessions.scan.scan`, a session with no name and no usable first
    message is NOT dropped: the fallback chain above can legitimately come up
    empty without that meaning the session itself is empty or bogus -- it's
    still a real rollout the user ran. It's included with `name=None`,
    `first_prompt=''`, which `cli/json_output._session_dict` already renders as
    an untitled row (falling back to the id's first 8 characters), landing in
    "Other" like any other nameless session."""
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
            if cached and not racy and cached.get('mtime') == st.st_mtime and cached.get('size') == st.st_size \
                    and cached.get('schema_version') == SCAN_SCHEMA_VERSION:
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
                        'schema_version': SCAN_SCHEMA_VERSION,
                        'head': {'cwd': h.cwd, 'prompt': h.prompt, 'child': h.child, 'source': h.source},
                        'last_activity': last_activity,
                    }
        except OSError:
            continue
        heads[sid] = (h, last_activity, st.st_mtime, p)

    thread_info = _names.lookup_thread_info(home, list(heads.keys()))

    out: Dict[str, Session] = {}
    for sid, (h, last_activity, file_mtime, p) in heads.items():
        info = thread_info.get(sid)
        name = info.name if info else None
        first_prompt = (info.title if info and info.title else None) or h.prompt
        mtime = last_activity or file_mtime
        out[sid] = Session(id=sid, name=name, cwd=h.cwd, mtime=mtime, path=p,
                            first_prompt=first_prompt, child=h.child, agent='codex')
    return out

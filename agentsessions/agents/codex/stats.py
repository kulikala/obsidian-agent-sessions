"""Codex's contribution to `json stats`: the `rate_limits.primary/secondary`
windows from the most recent `token_count` event across all rollouts. Codex
(unlike Claude Code) has no status-line hook writing these out separately -- the
rollout itself is the only place they're recorded.

Additive to `json stats`'s existing (Claude-only) `windows` key, not a
replacement -- the plugin only looks for an `agents.codex` key when Codex is
enabled, so an unchanged Claude-only deployment sees no difference (see
`agentsessions/cli/json_output.py::stats_output`). Deliberately not built on the
same historical-bucket accumulation as `usage.stats.compute` (5h/7d totals summed
from every transcript): `rate_limits.primary/secondary` already carry their own
`used_percent`/`resets_at`, computed server-side by Codex, so there's nothing to
accumulate locally -- this just needs whichever rollout was touched most recently.
"""
import json
import os
from typing import Optional

from ...sessions.scan import TAIL_CHUNK, TAIL_LIMIT, iter_tail_lines
from . import rollout


def _mtime(path: str) -> float:
    try:
        return os.stat(path).st_mtime
    except OSError:
        return -1.0


def _latest_rate_limits(paths) -> Optional[dict]:
    if not paths:
        return None
    newest_path = max(paths, key=_mtime)
    for line in iter_tail_lines(newest_path, TAIL_CHUNK, TAIL_LIMIT):
        if b'"rate_limits"' not in line or b'"token_count"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if not isinstance(d, dict) or d.get('type') != 'event_msg':
            continue
        payload = d.get('payload') or {}
        if payload.get('type') != 'token_count':
            continue
        rl = payload.get('rate_limits')
        if isinstance(rl, dict):
            return rl
    return None


def windows(home: Optional[str] = None) -> dict:
    """`{'primary': {...} | None, 'secondary': {...} | None}`, each (when present)
    straight from Codex's own payload -- no local recomputation, since Codex
    already reports `used_percent`/`resets_at` server-side."""
    rl = _latest_rate_limits(rollout.list_transcripts(home))
    if not rl:
        return {'primary': None, 'secondary': None}
    return {'primary': rl.get('primary'), 'secondary': rl.get('secondary')}

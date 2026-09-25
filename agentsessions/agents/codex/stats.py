"""Codex's contribution to `json stats` (T-103): `{"windows": {"five_hour": W,
"seven_day": W}}`, the same `W` shape Claude Code's `usage.stats.compute`
already produces (`{start, end, used_percentage, total, sessions}`), so the
plugin's analysis views (5h/7d cards, pace, category bars, the side panel's
rate-limit bars) can render either agent through the same code.

Two things Codex needs that Claude Code doesn't:

- **Window identification.** Claude Code's `status/*.json` always labels its
  two windows `five_hour`/`seven_day` explicitly. Codex's `rate_limits` instead
  has two positional slots, `primary`/`secondary`, whose *meaning* is only
  knowable from each slot's own `window_minutes` -- checked against real local
  data (2026-09-25), the same account reported `primary` as a ~5-hour window in
  one rollout, a ~7-day window in another, and a ~30-day window (no 7d/5h
  equivalent at all -- this account's current, real state) in the most recent
  one, with `secondary` similarly not fixed to one meaning. `_classify` reads
  `window_minutes` itself rather than trusting position. A window kind with no
  matching reading anywhere reports `used_percentage: None` -- Codex genuinely
  isn't tracking it for this account right now, same as Claude's "no
  status/*.json yet" case.
- **No incremental cache.** `usage.stats`'s per-file offset/bucket cache exists
  because `message.usage` in a Claude Code transcript is already a per-call
  delta; a Codex rollout's `token_count` is a *running total*, so recovering a
  delta for a line read from the middle of a file needs the total immediately
  before it, which a naive offset-only cache doesn't have. Every call re-reads
  every rollout in range from the start -- for a personal-use dataset (tens,
  not thousands, of Codex sessions) this is fast enough to skip the added
  complexity of also caching each file's running total.
"""
import os
from typing import Dict, List, Optional, Tuple

from ...usage import pricing
from ...usage.stats import (
    FIVE_HOUR_SECONDS, SEVEN_DAY_SECONDS, _bucket_key, _empty_totals, _roll_forward,
)
from . import rollout

# Real `window_minutes` values wobble by a minute or two (299 vs. 300); classify
# by nearest, not exact match. A window far from both known kinds (e.g. Codex's
# own ~30-day/43200-minute quota, seen on the free plan) matches neither and is
# ignored -- it doesn't fit this project's five_hour/seven_day shape.
_FIVE_HOUR_MINUTES = FIVE_HOUR_SECONDS / 60
_SEVEN_DAY_MINUTES = SEVEN_DAY_SECONDS / 60
_CLASSIFY_TOLERANCE_MINUTES = 30


def _classify(window_minutes) -> Optional[str]:
    if not isinstance(window_minutes, (int, float)) or isinstance(window_minutes, bool):
        return None
    if abs(window_minutes - _FIVE_HOUR_MINUTES) <= _CLASSIFY_TOLERANCE_MINUTES:
        return 'five_hour'
    if abs(window_minutes - _SEVEN_DAY_MINUTES) <= _CLASSIFY_TOLERANCE_MINUTES:
        return 'seven_day'
    return None


def _mtime(path: str) -> float:
    try:
        return os.stat(path).st_mtime
    except OSError:
        return -1.0


def _find_reading(paths: List[str], kind: str) -> Optional[dict]:
    """The most recent `{used_percent, resets_at}` reading of `kind`
    (`'five_hour'`/`'seven_day'`), searching rollouts newest-mtime-first and,
    within each, its tail. `None` if no rollout has ever reported this kind."""
    for path in sorted(paths, key=_mtime, reverse=True):
        for line_rl in rollout.iter_rate_limits_tail(path):
            for slot in ('primary', 'secondary'):
                w = line_rl.get(slot)
                if isinstance(w, dict) and _classify(w.get('window_minutes')) == kind:
                    return w
    return None


def _window_bounds(paths: List[str], kind: str, duration: float, now: float) -> Tuple[float, Optional[float]]:
    reading = _find_reading(paths, kind)
    if reading is None:
        return now, None
    resets_at = reading.get('resets_at')
    if not isinstance(resets_at, (int, float)) or isinstance(resets_at, bool):
        return now, None
    used_raw = reading.get('used_percent')
    used = float(used_raw) if isinstance(used_raw, (int, float)) and not isinstance(used_raw, bool) else None
    return _roll_forward(float(resets_at), used, duration, now)


# ---- Token/cost aggregation --------------------------------------------------

def _bucket_rollout(path: str) -> Dict[int, dict]:
    """`{bucket_start: {calls, input, output, cache_read, cache_create, cost,
    unknown_cost}}` for one rollout, from scratch (no incremental cache -- see
    module docstring). Mirrors `agents.codex.usage.collect`'s delta-from-running-total
    logic, but bucketed by each `token_count` event's own timestamp rather than
    grouped into turns -- `json stats` needs to place usage precisely against
    the 5h/7d window boundaries, which a turn (spanning from one `task_started`
    to the next) can straddle."""
    buckets: Dict[int, dict] = {}
    current_model: Optional[str] = None
    prev_total = {'input_tokens': 0, 'cached_input_tokens': 0,
                  'cache_write_input_tokens': 0, 'output_tokens': 0}

    def _int(v):
        return v if isinstance(v, int) and not isinstance(v, bool) else 0

    for rec in rollout.iter_records(path):
        t = rec.get('type')
        if t == 'turn_context':
            model = (rec.get('payload') or {}).get('model')
            if isinstance(model, str) and model:
                current_model = model
            continue
        if t != 'event_msg':
            continue
        payload = rec.get('payload') or {}
        if payload.get('type') != 'token_count':
            continue
        info = payload.get('info') or {}
        total = info.get('total_token_usage')
        if not isinstance(total, dict):
            continue
        delta = {k: max(0, _int(total.get(k)) - prev_total.get(k, 0)) for k in prev_total}
        prev_total = {k: _int(total.get(k)) for k in prev_total}
        if not any(delta.values()):
            continue
        ts = rollout.parse_ts(rec.get('timestamp'))
        if ts is None:
            continue

        bucket = buckets.setdefault(_bucket_key(ts), dict(_empty_totals(), unknown_cost=False))
        bucket['calls'] += 1
        bucket['input'] += delta['input_tokens']
        bucket['cache_read'] += delta['cached_input_tokens']
        bucket['cache_create'] += delta['cache_write_input_tokens']
        bucket['output'] += delta['output_tokens']
        usage_like = {
            'input_tokens': delta['input_tokens'], 'output_tokens': delta['output_tokens'],
            'cache_read_input_tokens': delta['cached_input_tokens'],
            'cache_creation_input_tokens': delta['cache_write_input_tokens'],
        }
        cost = pricing.cost(usage_like, current_model, agent='codex')
        if cost is None:
            bucket['unknown_cost'] = True
        elif not bucket['unknown_cost']:
            bucket['cost'] += cost
    return buckets


def _window_totals(per_file: List[Tuple[str, Dict[int, dict]]], start: float, end: float) -> Tuple[dict, Dict[str, dict]]:
    total = dict(_empty_totals(), unknown_cost=False)
    sessions: Dict[str, dict] = {}
    for sid, buckets in per_file:
        for bucket_start, b in buckets.items():
            if bucket_start < start or bucket_start >= end:
                continue
            s = sessions.setdefault(sid, dict(_empty_totals(), unknown_cost=False))
            for key in ('calls', 'input', 'output', 'cache_read', 'cache_create'):
                v = b.get(key, 0)
                s[key] += v
                total[key] += v
            if b.get('unknown_cost'):
                s['unknown_cost'] = True
                total['unknown_cost'] = True
            else:
                s['cost'] += b.get('cost', 0.0)
                total['cost'] += b.get('cost', 0.0)
    sessions = {sid: s for sid, s in sessions.items() if s['calls'] > 0}
    return total, sessions


# ---- Main entry point ---------------------------------------------------------

def compute(now: float, home: Optional[str] = None) -> dict:
    home = home if home is not None else rollout.codex_home()
    paths = rollout.list_transcripts(home)

    five_end, five_used = _window_bounds(paths, 'five_hour', FIVE_HOUR_SECONDS, now)
    seven_end, seven_used = _window_bounds(paths, 'seven_day', SEVEN_DAY_SECONDS, now)
    five_start = five_end - FIVE_HOUR_SECONDS
    seven_start = seven_end - SEVEN_DAY_SECONDS
    min_start = min(five_start, seven_start)

    per_file: List[Tuple[str, Dict[int, dict]]] = []
    for p in paths:
        if _mtime(p) < min_start:
            continue   # untouched within either window -- can't contribute a bucket in range
        sid = rollout.session_id_of(p)
        if not sid:
            continue
        per_file.append((sid, _bucket_rollout(p)))

    windows = {}
    for key, start, end, used in (
        ('five_hour', five_start, five_end, five_used),
        ('seven_day', seven_start, seven_end, seven_used),
    ):
        total, sessions = _window_totals(per_file, start, end)
        windows[key] = {'start': start, 'end': end, 'used_percentage': used,
                         'total': total, 'sessions': sessions}
    return {'windows': windows}

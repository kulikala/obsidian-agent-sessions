"""Codex's contribution to `json stats` (T-103, extended T-103-followup):
`{"windows": {"five_hour": W, "seven_day": W, ...}}`, the same `W` shape
Claude Code's `usage.stats.compute` already produces (`{start, end,
used_percentage, total, sessions}`, now also carrying `key`/`minutes` -- see
that module), so the plugin's analysis views (5h/7d cards, pace, category
bars, the side panel's rate-limit bars) can render either agent through the
same code.

Three things Codex needs that Claude Code doesn't:

- **Window identification.** Claude Code's `status/*.json` always labels its
  two windows `five_hour`/`seven_day` explicitly. Codex's `rate_limits` instead
  has two positional slots, `primary`/`secondary`, whose *meaning* is only
  knowable from each slot's own `window_minutes` -- checked against real local
  data (2026-09-25), the same account reported `primary` as a ~5-hour window in
  one rollout and a ~7-day window in another, with `secondary` similarly not
  fixed to one meaning. `_classify` reads `window_minutes` itself rather than
  trusting position.
- **A window that's neither 5h nor 7d isn't discarded.** This account's actual
  current state (free plan) is a single ~30-day/43200-minute quota -- no 5h or
  7d window at all. `five_hour`/`seven_day` are still always present in the
  output (with `used_percentage: null` if this account isn't tracking that
  length right now, same convention as Claude's "no status/*.json yet"), but
  any *other* window Codex reports is also included, keyed by
  `window_<minutes>m` and carrying a best-effort `label_key` (`window.30d` for
  a day-aligned length, `window.5h`-style for an hour-aligned one, or
  `window.<n>m` as a last resort) for the plugin to look up display text for a
  length it may not have a hardcoded string for.
- **No incremental cache.** `usage.stats`'s per-file offset/bucket cache exists
  because `message.usage` in a Claude Code transcript is already a per-call
  delta; a Codex rollout's `token_count` is a *running total*, so recovering a
  delta for a line read from the middle of a file needs the total immediately
  before it, which a naive offset-only cache doesn't have. Every call re-reads
  every rollout in range from the start -- for a personal-use dataset (tens,
  not thousands, of Codex sessions) this is fast enough to skip the added
  complexity of also caching each file's running total.

All windows come from a single `rate_limits` snapshot -- the most recent
`token_count` event found across all rollouts -- rather than hunting each
window kind independently across different files/times: `primary` and
`secondary` are only ever reported together, so mixing one slot's *current*
reading with another slot's reading from an older, possibly stale snapshot
would show two windows that don't actually describe the same moment.
"""
import os
from typing import Dict, List, Optional, Tuple

from ...usage import pricing
from ...usage.stats import (
    FIVE_HOUR_SECONDS, SEVEN_DAY_SECONDS, _bucket_key, _empty_totals, _roll_forward,
)
from . import rollout

# Real `window_minutes` values wobble by a minute or two (299 vs. 300); classify
# by nearest, not exact match.
_FIVE_HOUR_MINUTES = FIVE_HOUR_SECONDS / 60
_SEVEN_DAY_MINUTES = SEVEN_DAY_SECONDS / 60
_CLASSIFY_TOLERANCE_MINUTES = 30

_MINUTES_PER_HOUR = 60
_MINUTES_PER_DAY = 1440


def _classify(window_minutes) -> Optional[str]:
    """`'five_hour'`/`'seven_day'`/`None` (a window of some other length --
    still surfaced, just not one of the two fixed keys)."""
    if not isinstance(window_minutes, (int, float)) or isinstance(window_minutes, bool):
        return None
    if abs(window_minutes - _FIVE_HOUR_MINUTES) <= _CLASSIFY_TOLERANCE_MINUTES:
        return 'five_hour'
    if abs(window_minutes - _SEVEN_DAY_MINUTES) <= _CLASSIFY_TOLERANCE_MINUTES:
        return 'seven_day'
    return None


def _label_key(minutes: float) -> str:
    """A best-effort i18n key for a window length the plugin may not have a
    hardcoded string for (`window.<n>d`/`window.<n>h`/`window.<n>m`, whichever
    divides evenly) -- `minutes` itself (carried on the window alongside this)
    is the authoritative value; this is just a display hint."""
    n = int(round(minutes))
    if n % _MINUTES_PER_DAY == 0:
        return 'window.%dd' % (n // _MINUTES_PER_DAY)
    if n % _MINUTES_PER_HOUR == 0:
        return 'window.%dh' % (n // _MINUTES_PER_HOUR)
    return 'window.%dm' % n


def _mtime(path: str) -> float:
    try:
        return os.stat(path).st_mtime
    except OSError:
        return -1.0


def _latest_rate_limits(paths: List[str]) -> Optional[dict]:
    """The single most recent `rate_limits` payload across all rollouts
    (newest-mtime file first, then that file's own tail) -- see module
    docstring for why `primary`/`secondary` are read together from one
    snapshot rather than hunted independently."""
    for path in sorted(paths, key=_mtime, reverse=True):
        for line_rl in rollout.iter_rate_limits_tail(path):
            return line_rl
    return None


def _bounds_from_reading(reading: dict, duration: float, now: float) -> Tuple[float, Optional[float]]:
    resets_at = reading.get('resets_at')
    if not isinstance(resets_at, (int, float)) or isinstance(resets_at, bool):
        return now, None
    used_raw = reading.get('used_percent')
    used = float(used_raw) if isinstance(used_raw, (int, float)) and not isinstance(used_raw, bool) else None
    return _roll_forward(float(resets_at), used, duration, now)


def _window_defs(paths: List[str], now: float) -> List[dict]:
    """Every window to report: always `five_hour`/`seven_day` (first, in that
    order, even if this account isn't tracking one of them right now -- so a
    consumer can keep relying on those two keys always existing), then any
    other window found in the latest snapshot, in the order that snapshot
    lists its slots. Each: `{key, minutes, label_key, start, end,
    used_percentage}`."""
    rl = _latest_rate_limits(paths)
    slots: Dict[str, dict] = {}   # classified key or generated key -> raw slot
    if rl:
        for slot_name in ('primary', 'secondary'):
            w = rl.get(slot_name)
            if not isinstance(w, dict):
                continue
            wm = w.get('window_minutes')
            if not isinstance(wm, (int, float)) or isinstance(wm, bool):
                continue
            kind = _classify(wm)
            key = kind or ('window_%dm' % int(round(wm)))
            slots.setdefault(key, w)   # first (more recent, per read order) wins if duplicated

    defs: List[dict] = []
    for kind, duration in (('five_hour', FIVE_HOUR_SECONDS), ('seven_day', SEVEN_DAY_SECONDS)):
        w = slots.pop(kind, None)
        minutes = duration / 60
        end, used = _bounds_from_reading(w, duration, now) if w is not None else (now, None)
        defs.append({'key': kind, 'minutes': minutes, 'label_key': _label_key(minutes),
                     'start': end - duration, 'end': end, 'used_percentage': used})

    for key, w in slots.items():
        minutes = float(w['window_minutes'])
        duration = minutes * 60
        end, used = _bounds_from_reading(w, duration, now)
        defs.append({'key': key, 'minutes': minutes, 'label_key': _label_key(minutes),
                     'start': end - duration, 'end': end, 'used_percentage': used})
    return defs


# ---- Token/cost aggregation --------------------------------------------------

def _bucket_rollout(path: str) -> Dict[int, dict]:
    """`{bucket_start: {calls, input, output, cache_read, cache_create, cost,
    unknown_cost}}` for one rollout, from scratch (no incremental cache -- see
    module docstring). Mirrors `agents.codex.usage.collect`'s delta-from-running-total
    logic, but bucketed by each `token_count` event's own timestamp rather than
    grouped into turns -- `json stats` needs to place usage precisely against
    each window's boundaries, which a turn (spanning from one `task_started`
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

    defs = _window_defs(paths, now)
    min_start = min(d['start'] for d in defs)

    per_file: List[Tuple[str, Dict[int, dict]]] = []
    for p in paths:
        if _mtime(p) < min_start:
            continue   # untouched within any window -- can't contribute a bucket in range
        sid = rollout.session_id_of(p)
        if not sid:
            continue
        per_file.append((sid, _bucket_rollout(p)))

    windows = {}
    for d in defs:
        total, sessions = _window_totals(per_file, d['start'], d['end'])
        windows[d['key']] = {
            'key': d['key'],
            'minutes': d['minutes'],
            'label_key': d['label_key'],
            'start': d['start'],
            'end': d['end'],
            'used_percentage': d['used_percentage'],
            'total': total,
            'sessions': sessions,
        }
    return {'windows': windows}

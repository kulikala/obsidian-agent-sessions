"""Activity spans: when an agent was actually working in a session.

A session's transcript carries a timestamp on each message. Consecutive timestamps
closer than the gap belong to one *span*; a longer silence starts a new one. This
module holds the pure span arithmetic and the Claude Code transcript reader; the
Codex and OpenCode readers live next to their own parsing
(`agents/codex/rollout.py`, `agents/opencode/scan.py`).
"""

import re
from datetime import datetime, timezone
from typing import Iterable, List, Optional

DEFAULT_GAP_SECONDS = 30 * 60
MIN_SPAN_SECONDS = 60.0

_TS_RE = re.compile(rb'"timestamp":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z"')


def spans_from_times(times: Iterable[float], gap: float = DEFAULT_GAP_SECONDS,
                     min_len: float = MIN_SPAN_SECONDS) -> List[List[float]]:
    """`[[start, end], ...]` from message timestamps (any order). A new span starts
    when the distance to the previous timestamp is `gap` or more; a span shorter
    than `min_len` is extended to `min_len` so a single message stays visible."""
    ordered = sorted(times)
    spans: List[List[float]] = []
    for t in ordered:
        if spans and t - spans[-1][1] < gap:
            spans[-1][1] = t
        else:
            spans.append([t, t])
    for s in spans:
        if s[1] - s[0] < min_len:
            s[1] = s[0] + min_len
    return spans


def clip_spans(spans: List[List[float]], start: float, end: float) -> List[List[float]]:
    """The parts of `spans` inside `[start, end)`; empty ones are dropped."""
    out = []
    for a, b in spans:
        a, b = max(a, start), min(b, end)
        if b > a:
            out.append([a, b])
    return out


def parse_utc(value: str) -> Optional[float]:
    fmt = '%Y-%m-%dT%H:%M:%S.%f' if '.' in value else '%Y-%m-%dT%H:%M:%S'
    try:
        return datetime.strptime(value, fmt).replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def claude_times(path: str) -> List[float]:
    """Timestamps of every user and assistant line of a Claude Code transcript
    (sub-agent sidechains and tool results included: the agent was working then)."""
    out: List[float] = []
    try:
        f = open(path, 'rb')
    except OSError:
        return out
    with f:
        for line in f:
            if b'"timestamp"' not in line:
                continue
            if b'"type":"user"' not in line and b'"type":"assistant"' not in line:
                continue
            m = _TS_RE.search(line)
            if not m:
                continue
            t = parse_utc(m.group(1).decode())
            if t is not None:
                out.append(t)
    return out

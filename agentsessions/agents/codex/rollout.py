"""Low-level parsing shared across the codex adapter's scan/detail/live/usage.

A rollout file (`CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>
[_<n>].jsonl`) is a line-per-event JSONL transcript, structurally different from a
Claude Code transcript but read the same way: forward from the start for the head
(cwd, source, first message), backward from the end for the most recent activity
-- see `agentsessions.sessions.scan.iter_tail_lines`/`RACY_WINDOW`, reused here
rather than duplicated.

Line shapes below are from real `~/.codex/sessions` data plus openai/codex's
codex-rs source (see plan/他エージェント対応-検討.md), checked 2026-09-25:
- `session_meta`: once, the first line. `payload.session_id` (== the thread id,
  also the file's trailing UUID), `.cwd`, `.source` ('cli' | 'vscode' | 'exec' |
  ...; anything but 'cli' means a child/headless launch from another tool),
  `.originator`, `.cli_version`.
- `turn_context`: one per turn. `payload.model`, `.effort`, `.cwd`.
- `response_item`: a message/reasoning/function_call. `payload.type == 'message'`
  has `.role` ('developer' | 'user' | 'assistant') and `.content` (a list of
  `{type: 'input_text'|'output_text', text}`).
- `event_msg`: `payload.type` is one of `task_started`, `task_complete`,
  `turn_aborted`, `token_count` (carries `.rate_limits.primary/secondary`),
  `user_message` (older CLI versions -- `.message`, a plain string), `agent_message`,
  `item_completed` (newer CLI versions, e.g. 0.156.1 -- `.item`, an object; when
  `.item.type == 'UserMessage'` this is the newer versions' equivalent of
  `user_message`, with the literal text at `.item.content[].text`, blocks typed
  `'text'` rather than `'input_text'`), `patch_apply_end`, `web_search_end`, and
  (per codex-rs, not seen in local fixtures) approval requests -- see
  `WAITING_EVENTS` in `live.py`. `user_message` and `item_completed`(UserMessage)
  are mutually exclusive in every rollout checked so far (one CLI version writes
  one, a newer version the other), but both are read for wherever a rollout
  came from.
- `token_usage_record`: per-call token accounting (separate from `token_count`'s
  running total).
"""
import glob
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterator, List, Optional, Tuple

from ...sessions.scan import RACY_WINDOW, TAIL_CHUNK, TAIL_LIMIT, iter_tail_lines  # noqa: F401  (re-exported for callers)

SESSION_ID_RE = re.compile(
    r'rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_\d+)?\.jsonl$')

HEAD_LIMIT = 2000   # max number of lines to scan for the head (mirrors sessions.scan)

# Prefixes marking Codex-injected context, never something the user actually
# typed. Checked against real local `~/.codex/sessions` data (62+ rollouts,
# 2026-09-25): every one of these was found only in a `response_item` role=user
# message, never in an `event_msg.user_message`/`item_completed`(UserMessage) --
# both of the latter are preferred over `response_item` for exactly this reason
# (see `read_head`'s tiered `PROMPT_TIER_*`), but `response_item` -- filtered by
# this list -- is still read as a last resort (T-101): some Codex CLI versions'
# rollouts have neither of the other two at all. `<user_instructions>`/
# `<permissions` weren't observed in the checked data but are filtered anyway,
# per codex-rs's context-injection code cited in plan/他エージェント対応-検討.md.
INJECTED_PREFIXES = (
    '# AGENTS.md instructions',
    '<environment_context>',
    '<user_instructions>',
    '<permissions',
)


def is_real_user_text(text: str) -> bool:
    """False for Codex-injected context (`INJECTED_PREFIXES`) and for a bare
    slash command (`/exit`, `/compact`, ...) -- neither belongs in a session's
    name or "last instruction" (mirrors `sessions.detail.is_human_prompt`'s role
    for Claude Code, adapted to what Codex actually injects)."""
    stripped = text.lstrip()
    if not stripped or stripped.startswith('/'):
        return False
    return not any(stripped.startswith(p) for p in INJECTED_PREFIXES)


def codex_home() -> str:
    """env `CODEX_HOME`, or `~/.codex`. Re-read on every call (not cached at import
    time) since the plugin can pass a different value per invocation."""
    return os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex')


def session_id_of(path: str) -> Optional[str]:
    m = SESSION_ID_RE.search(os.path.basename(path))
    return m.group(1) if m else None


def list_transcripts(home: Optional[str] = None) -> List[str]:
    home = home if home is not None else codex_home()
    paths = glob.glob(os.path.join(home, 'sessions', '*', '*', '*', 'rollout-*.jsonl'))
    return sorted(p for p in paths if session_id_of(p))


def parse_ts(value) -> Optional[float]:
    """Convert a rollout `timestamp` (ISO 8601 UTC, `...Z` suffix) to epoch seconds."""
    if not isinstance(value, str) or not value.endswith('Z'):
        return None
    raw = value[:-1]
    fmt = '%Y-%m-%dT%H:%M:%S.%f' if '.' in raw else '%Y-%m-%dT%H:%M:%S'
    try:
        return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def iter_records(path: str) -> Iterator[dict]:
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if isinstance(d, dict):
                yield d


def text_of(content) -> str:
    """First non-empty text block's text (mirrors `sessions.scan._text_of`'s
    "first text block wins" convention). Recognizes `response_item`'s
    `input_text`/`output_text` block types and `item_completed`'s plain `text`
    (`event_msg.payload.item.content[]`, e.g. `{"type": "text", "text": ...}`) --
    different `event_msg`/`response_item` shapes for what's structurally the
    same "typed text block" idea."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get('type') in ('input_text', 'output_text', 'text') \
                    and block.get('text'):
                return block['text']
    return ''


@dataclass
class Head:
    cwd: str = ''
    prompt: str = ''          # first line of the first human message
    child: bool = False       # session_meta.payload.source != 'cli'
    source: str = ''


# `prompt`'s source, best first (lower wins) -- see `read_head`. `agents.codex.scan.scan`
# additionally ranks `state_5.sqlite`'s `threads.title` above all of these (T-101).
PROMPT_TIER_ITEM_COMPLETED = 1   # event_msg.item_completed, item.type == 'UserMessage'
PROMPT_TIER_USER_MESSAGE = 2     # event_msg.user_message
PROMPT_TIER_RESPONSE_ITEM = 3    # response_item, role=user, filtered


def read_head(path: str, limit: int = HEAD_LIMIT) -> Head:
    """`prompt` never comes from `response_item`'s role=user *by itself* --
    Codex's own reconstructed prompt for the model, which mixes in injected
    context (AGENTS.md instructions, `<environment_context>`, ...; see
    `INJECTED_PREFIXES`) -- but a `response_item` that passes `is_real_user_text`
    (i.e. the injected ones are filtered out, and only a genuine typed message
    survives) is still used as a last resort, ranked below `event_msg.user_message`
    and `event_msg.item_completed`(UserMessage), which real data shows carry the
    literal typed text with nothing injected mixed in whenever they're present
    at all -- some Codex CLI versions' rollouts don't have either (T-101, a real
    report: 0.156.1 has neither `user_message` events nor the pre-T-101 filtering
    on `response_item`, so no name was ever recovered for those sessions).

    Keeps scanning past a candidate that fails `is_real_user_text` (injected
    text, or a bare slash command) rather than settling for it, and past a
    lower-tier candidate once a higher tier is already in hand (`PROMPT_TIER_*`).
    If nothing ever passes, `prompt` stays `''` (the session is still listed,
    just nameless -- see `agents.codex.scan.scan`)."""
    h = Head()
    prompt_tier: Optional[int] = None
    for n, d in enumerate(iter_records(path)):
        if n >= limit or (h.cwd and h.source and prompt_tier == PROMPT_TIER_ITEM_COMPLETED):
            break
        t = d.get('type')
        if t == 'session_meta':
            payload = d.get('payload') or {}
            if not h.cwd and isinstance(payload.get('cwd'), str):
                h.cwd = payload['cwd']
            source = payload.get('source')
            if isinstance(source, str) and source:
                h.source = source
                h.child = source != 'cli'
        elif t == 'event_msg':
            payload = d.get('payload') or {}
            etype = payload.get('type')
            if etype == 'item_completed' and (prompt_tier is None or prompt_tier > PROMPT_TIER_ITEM_COMPLETED):
                item = payload.get('item') or {}
                if item.get('type') == 'UserMessage':
                    text = text_of(item.get('content'))
                    if text.strip() and is_real_user_text(text):
                        h.prompt = text.strip().splitlines()[0].strip()
                        prompt_tier = PROMPT_TIER_ITEM_COMPLETED
            elif etype == 'user_message' and (prompt_tier is None or prompt_tier > PROMPT_TIER_USER_MESSAGE):
                msg = payload.get('message')
                if isinstance(msg, str) and msg.strip() and is_real_user_text(msg):
                    h.prompt = msg.strip().splitlines()[0].strip()
                    prompt_tier = PROMPT_TIER_USER_MESSAGE
        elif t == 'response_item' and (prompt_tier is None or prompt_tier > PROMPT_TIER_RESPONSE_ITEM):
            payload = d.get('payload') or {}
            if payload.get('type') == 'message' and payload.get('role') == 'user':
                text = text_of(payload.get('content'))
                if text.strip() and is_real_user_text(text):
                    h.prompt = text.strip().splitlines()[0].strip()
                    prompt_tier = PROMPT_TIER_RESPONSE_ITEM
    return h


def _activity_ts(line: bytes) -> Optional[float]:
    """If the line is a user/assistant `response_item` message, its timestamp as
    epoch seconds. Mirrors `sessions.scan._activity_ts`'s role in `read_last_activity`."""
    if b'"response_item"' not in line or b'"timestamp"' not in line:
        return None
    try:
        d = json.loads(line)
    except ValueError:
        return None
    if not isinstance(d, dict) or d.get('type') != 'response_item':
        return None
    payload = d.get('payload') or {}
    if payload.get('type') != 'message' or payload.get('role') not in ('user', 'assistant'):
        return None
    if not text_of(payload.get('content')):
        return None
    return parse_ts(d.get('timestamp'))


def read_last_activity(path: str) -> Optional[float]:
    for line in iter_tail_lines(path, TAIL_CHUNK, TAIL_LIMIT):
        t = _activity_ts(line)
        if t is not None:
            return t
    return None


def iter_rate_limits_tail(path: str) -> Iterator[Tuple[dict, Optional[float]]]:
    """Yields `(rate_limits, event_ts)` for each `event_msg.token_count` found
    while walking `path`'s tail, most recent first. Used by `agents.codex.stats`
    to find the newest reading of a given rate-limit window kind (`primary`/
    `secondary` -- see that module for why position alone doesn't say which).
    `event_ts` (the line's own `timestamp`, epoch seconds) is needed because an
    older Codex CLI version's `primary`/`secondary` slot carries
    `resets_in_seconds` (relative to *this event*) instead of `resets_at`
    (absolute) -- resolving the former to an absolute time needs to know when
    the event happened."""
    for line in iter_tail_lines(path, TAIL_CHUNK, TAIL_LIMIT):
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
            yield rl, parse_ts(d.get('timestamp'))

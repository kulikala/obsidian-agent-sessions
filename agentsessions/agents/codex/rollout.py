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
  `user_message`, `agent_message`, `item_completed`, `patch_apply_end`,
  `web_search_end`, and (per codex-rs, not seen in local fixtures) approval
  requests -- see `WAITING_EVENTS` in `live.py`.
- `token_usage_record`: per-call token accounting (separate from `token_count`'s
  running total).
"""
import glob
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterator, List, Optional

from ...sessions.scan import RACY_WINDOW, TAIL_CHUNK, TAIL_LIMIT, iter_tail_lines  # noqa: F401  (re-exported for callers)

SESSION_ID_RE = re.compile(
    r'rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_\d+)?\.jsonl$')

HEAD_LIMIT = 2000   # max number of lines to scan for the head (mirrors sessions.scan)


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
    """First non-empty `input_text`/`output_text` block's text (mirrors
    `sessions.scan._text_of`'s "first text block wins" convention)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get('type') in ('input_text', 'output_text') \
                    and block.get('text'):
                return block['text']
    return ''


@dataclass
class Head:
    cwd: str = ''
    prompt: str = ''          # first line of the first human message
    child: bool = False       # session_meta.payload.source != 'cli'
    source: str = ''


def read_head(path: str, limit: int = HEAD_LIMIT) -> Head:
    h = Head()
    for n, d in enumerate(iter_records(path)):
        if n >= limit or (h.cwd and h.prompt and h.source):
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
        elif t == 'response_item' and not h.prompt:
            payload = d.get('payload') or {}
            if payload.get('type') == 'message' and payload.get('role') == 'user':
                text = text_of(payload.get('content'))
                text = text.strip().splitlines()[0].strip() if text.strip() else ''
                if text and not text.startswith('<'):
                    h.prompt = text
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

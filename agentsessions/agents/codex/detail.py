"""Read the most recent exchange (user instruction / Codex's response) from the
end of a rollout -- the codex analogue of `agentsessions.sessions.detail`.

Reuses `agentsessions.sessions.detail.Detail` (same shape the JSON API and the
plugin's detail panel already expect) and `clean_text`. `last_user` is the most
recent candidate (walking backward) from any of `event_msg.item_completed`
(item.type == 'UserMessage', newer Codex CLI versions), `event_msg.user_message`
(older versions), or `response_item`'s role=user -- filtered by
`rollout.is_real_user_text` in every case, since `response_item` mixes in
Codex's own injected context (AGENTS.md instructions, `<environment_context>`,
...; see `rollout.INJECTED_PREFIXES`) and would surface that instead of what
the user actually last said if it weren't filtered (T-101: some Codex CLI
versions have neither `item_completed`(UserMessage) nor `user_message` events
at all, so `response_item` -- filtered -- is a needed last resort, not
skippable the way it used to be assumed). Recency, not source, decides which
candidate wins: whichever passes the filter first while walking backward is
the most recent one, regardless of which of the three event shapes produced
it -- no separate tier logic is needed here the way `rollout.read_head` needs
one (see that function), since `item_completed`/`user_message` don't coexist
in one rollout in practice. `last_command` is left `None` -- Codex's `/rename`
and `/compact` are plugin-side concerns (T-96), not something this phase reads
out of the transcript. `model`/`effort` come from the most recent
`turn_context` (Codex has no statusLine to carry them the way Claude Code does
-- see plan/段9-Codex対応.md).
"""
import json
from typing import Optional

from ...sessions.detail import Detail, clean_text
from ...sessions.scan import TAIL_CHUNK, TAIL_LIMIT, iter_tail_lines
from . import rollout

# `response_item.payload.type` values that represent a tool call, and the field
# each uses for the tool's name (from real local rollouts plus codex-rs's
# `ResponseItem` enum; a variant not listed here is simply not counted as a tool).
_TOOL_CALL_TYPES = {
    'function_call': 'name',
    'local_shell_call': 'name',
    'custom_tool_call': 'name',
}


def read_detail(path: str) -> Detail:
    d = Detail()
    tools = []
    try:
        lines = list(iter_tail_lines(path, TAIL_CHUNK, TAIL_LIMIT))
    except OSError:
        return d
    for line in lines:
        if b'"turn_context"' in line and d.model is None:
            try:
                rec = json.loads(line)
            except ValueError:
                rec = None
            if isinstance(rec, dict) and rec.get('type') == 'turn_context':
                payload = rec.get('payload') or {}
                model = payload.get('model')
                effort = payload.get('effort')
                if isinstance(model, str) and model:
                    d.model = model
                if isinstance(effort, str) and effort:
                    d.effort = effort
        elif b'"item_completed"' in line and not d.last_user:
            try:
                rec = json.loads(line)
            except ValueError:
                rec = None
            if isinstance(rec, dict) and rec.get('type') == 'event_msg':
                payload = rec.get('payload') or {}
                if payload.get('type') == 'item_completed':
                    item = payload.get('item') or {}
                    if item.get('type') == 'UserMessage':
                        text = rollout.text_of(item.get('content'))
                        # keep scanning past a filtered-out candidate (injected
                        # text, a bare slash command) for an earlier real one
                        if text.strip() and rollout.is_real_user_text(text):
                            cleaned = clean_text(text)
                            if cleaned:
                                d.last_user = cleaned
        elif b'"user_message"' in line and not d.last_user:
            try:
                rec = json.loads(line)
            except ValueError:
                rec = None
            if isinstance(rec, dict) and rec.get('type') == 'event_msg':
                payload = rec.get('payload') or {}
                if payload.get('type') == 'user_message':
                    msg = payload.get('message')
                    # keep scanning past a filtered-out candidate (injected text,
                    # a bare slash command) rather than settling for it -- an
                    # earlier real message may still be found further back
                    if isinstance(msg, str) and msg.strip() and rollout.is_real_user_text(msg):
                        cleaned = clean_text(msg)
                        if cleaned:
                            d.last_user = cleaned
        elif b'"response_item"' in line:
            try:
                rec = json.loads(line)
            except ValueError:
                rec = None
            if isinstance(rec, dict) and rec.get('type') == 'response_item':
                payload = rec.get('payload') or {}
                ptype = payload.get('type')
                if ptype in _TOOL_CALL_TYPES:
                    name = payload.get(_TOOL_CALL_TYPES[ptype])
                    if isinstance(name, str) and name and not d.last_assistant:
                        tools.append(name)
                elif ptype == 'message' and payload.get('role') == 'assistant' and not d.last_assistant:
                    text = rollout.text_of(payload.get('content'))
                    if text.strip():
                        d.last_assistant = clean_text(text)
                        d.tools = list(reversed(tools))   # tools called after the response = what's currently running
                elif ptype == 'message' and payload.get('role') == 'user' and not d.last_user:
                    # last resort: only used when neither item_completed(UserMessage)
                    # nor user_message produced anything (T-101 -- some CLI versions
                    # have neither), filtered the same way read_head's fallback is
                    text = rollout.text_of(payload.get('content'))
                    if text.strip() and rollout.is_real_user_text(text):
                        cleaned = clean_text(text)
                        if cleaned:
                            d.last_user = cleaned
        # keep scanning (bounded by TAIL_LIMIT) until model is found too, same
        # convention as sessions.detail.read_detail's last_command
        if d.last_user and d.last_assistant and d.model is not None:
            break
    return d


def read_detail_for(path: Optional[str]) -> Detail:
    return read_detail(path) if path else Detail()

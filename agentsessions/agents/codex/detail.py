"""Read the most recent exchange (user instruction / Codex's response) from the
end of a rollout -- the codex analogue of `agentsessions.sessions.detail`.

Reuses `agentsessions.sessions.detail.Detail` (same shape the JSON API and the
plugin's detail panel already expect) and `clean_text` (machine-inserted content
like `<recommended_plugins>` wrappers gets stripped the same way `<system-reminder>`
does for Claude). `last_command` is left `None` -- Codex's `/rename` and `/compact`
are plugin-side concerns (T-96), not something this phase reads out of the
transcript.
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
        if b'"response_item"' not in line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict) or rec.get('type') != 'response_item':
            continue
        payload = rec.get('payload') or {}
        ptype = payload.get('type')
        if ptype in _TOOL_CALL_TYPES:
            name = payload.get(_TOOL_CALL_TYPES[ptype])
            if isinstance(name, str) and name and not d.last_assistant:
                tools.append(name)
            continue
        if ptype != 'message':
            continue
        role = payload.get('role')
        text = rollout.text_of(payload.get('content'))
        if role == 'assistant':
            if d.last_assistant or not text.strip():
                continue
            d.last_assistant = clean_text(text)
            d.tools = list(reversed(tools))   # tools called after the response = what's currently running
        elif role == 'user':
            if d.last_user or not text.strip():
                continue
            cleaned = clean_text(text)
            if cleaned:
                d.last_user = cleaned
        if d.last_user and d.last_assistant:
            break
    return d


def read_detail_for(path: Optional[str]) -> Detail:
    return read_detail(path) if path else Detail()

"""The advisor model a Claude Code session consults (`/advisor`).

Claude Code's statusLine JSON doesn't carry the advisor. The transcript does: each main
assistant line records `advisorModel` (a model id such as `claude-opus-5-5`) while an advisor
is set, and leaves it out while none is. So the latest main assistant line is the source;
`<synthetic>` lines (a usage-limit notice, an API error) are skipped, since Claude Code writes
them without the field either way. Before the session's first reply there is no such line,
and the user's `settings.json` `advisorModel` (what `/advisor` saves, e.g. `opus`) stands in.
A change made with `/advisor` shows from the next reply on.
"""

import json
import os
import re
from typing import Optional

from ..sessions.scan import TAIL_CHUNK, iter_tail_lines

# How far back to look for the latest assistant line. A tool-heavy turn can leave long user
# lines (tool results) after it; past this the settings stand in, as before a first reply.
TAIL_LIMIT = 1 << 22


def _settings_path() -> str:
    base = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
    return os.path.join(base, 'settings.json')


def read_from_transcript(path: Optional[str], limit: int = TAIL_LIMIT) -> Optional[str]:
    """The latest main assistant line's `advisorModel`: the id, `''` when that line has none
    (no advisor), or None when there is no such line within `limit` bytes (or no file)."""
    if not isinstance(path, str) or not path:
        return None
    try:
        for line in iter_tail_lines(path, TAIL_CHUNK, limit):
            if b'"type":"assistant"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if not isinstance(d, dict) or d.get('type') != 'assistant' or d.get('isSidechain'):
                continue
            if (d.get('message') or {}).get('model') == '<synthetic>':
                continue
            model = d.get('advisorModel')
            return model if isinstance(model, str) else ''
    except OSError:
        return None
    return None


def read_from_settings() -> Optional[str]:
    """`advisorModel` in the user's Claude Code `settings.json`, or None."""
    try:
        with open(_settings_path(), encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    model = data.get('advisorModel') if isinstance(data, dict) else None
    return model if isinstance(model, str) and model else None


def current(transcript_path: Optional[str]) -> Optional[str]:
    """The advisor model id the session uses, or None when it has none."""
    model = read_from_transcript(transcript_path)
    if model is None:
        model = read_from_settings()
    return model or None


def display_name(model: str) -> str:
    """A short name for a model id or alias: `claude-opus-5-5` -> `Opus 5.5`, `opus` -> `Opus`,
    `claude-sonnet-4-5-20250929[1m]` -> `Sonnet 4.5`. An id it can't read comes back as is."""
    m = re.sub(r'\[[^\]]*\]$', '', model.strip())
    if m.startswith('claude-'):
        m = m[len('claude-'):]
    m = re.sub(r'-\d{8}$', '', m)
    parts = [p for p in m.split('-') if p]
    words = [p for p in parts if not p.isdigit()]
    numbers = [p for p in parts if p.isdigit()]
    if not words or any(not w.isalpha() for w in words):
        return model
    name = ' '.join(w.capitalize() for w in words)
    return '%s %s' % (name, '.'.join(numbers)) if numbers else name

"""Which agents (Claude Code, Codex, ...) this process scans/tracks.

Enabled-agent resolution, in order:
1. env `AGENT_SESSIONS_AGENTS` (comma-separated, e.g. "claude,codex") -- set by the
   plugin whenever it calls Python, so it always reflects the toggles in Settings.
   Unknown names are dropped; if nothing recognized remains, falls through to step 2.
2. `agents` in `~/.agents/sessions/ui.json` (an array the plugin writes) -- the
   fallback for callers outside Obsidian (the TUI, a bare CLI invocation) that
   don't get the env var.
3. `['claude']` -- the original, single-agent behavior, so an environment where
   no plugin has ever run keeps working exactly as before.

Each agent's scan/detail/live/usage logic lives in its own subpackage
(`agents.claude`, `agents.codex`), each exposing the same small surface:
`list_transcripts()`, `scan(paths, cache)`, `find_transcript(session_id)`,
`read_detail_for(path)`, `live_sessions()`, `collect_usage(path)`.
`agentsessions/cli/json_output.py` loops over `enabled_agents()` and merges
their results; that's the "registered adapters, looped over and merged" dispatch
point referred to in plan/段9-Codex対応.md.
"""
import json
import os
from typing import List

from .. import config

ALL_AGENTS = ('claude', 'codex')
DEFAULT_AGENTS = ('claude',)


def _env_agents() -> List[str]:
    raw = os.environ.get('AGENT_SESSIONS_AGENTS')
    if not raw:
        return []
    return [a for a in (part.strip() for part in raw.split(',')) if a in ALL_AGENTS]


def _ui_state_agents() -> List[str]:
    """Reads `agents` from `ui.json` (an array the plugin writes). `[]` if there is
    none, the file is missing, or it doesn't parse."""
    try:
        with open(config.UI_STATE_PATH, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    agents = data.get('agents')
    if not isinstance(agents, list):
        return []
    return [a for a in agents if isinstance(a, str) and a in ALL_AGENTS]


def enabled_agents() -> List[str]:
    return _env_agents() or _ui_state_agents() or list(DEFAULT_AGENTS)

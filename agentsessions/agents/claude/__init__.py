"""The `claude` agent adapter: Claude Code's own transcripts
(`~/.claude/projects/*/<uuid>.jsonl`).

This is a thin wrapper, not a rewrite -- the actual parsing predates the
multi-agent adapter layer and stays where a lot of other code already imports it
directly and unwrapped (the TUI, `agentsessions.claude`'s hooks/setup/keybindings,
the daemon's status-line formatting): `agentsessions.sessions.scan/detail/live` and
`agentsessions.usage.turns`. This module is just the uniform surface
`agentsessions/cli/json_output.py` dispatches through for every agent, so adding a
new agent never means touching that call site's Claude-specific code.

Note the name collision with `agentsessions.claude` (Claude Code's *own* CLI
integration -- hooks, setup, keybindings -- unrelated to scanning transcripts as
one of possibly several supported agents). The two are deliberately kept separate.
"""
import glob
import os
from typing import Dict, List, Optional

from ... import config
from ...sessions import detail as _detail
from ...sessions import live as _live
from ...sessions import scan as _scan
from ...sessions.model import Session
from ...usage import turns as _turns

NAME = 'claude'


def list_transcripts() -> List[str]:
    return _scan.list_transcripts(config.PROJECTS_DIR)


def scan(paths: List[str], cache: Optional[Dict[str, dict]] = None) -> Dict[str, Session]:
    return _scan.scan(paths, cache=cache)


def find_transcript(session_id: str) -> Optional[str]:
    matches = glob.glob(os.path.join(config.PROJECTS_DIR, '*', '%s.jsonl' % session_id))
    return matches[0] if matches else None


def read_detail_for(path: Optional[str]) -> _detail.Detail:
    return _detail.read_detail_for(path)


def live_sessions(sessions: Optional[Dict[str, Session]] = None) -> Dict[str, _live.Live]:
    """`sessions` (the already-scanned `{id: Session}` map) is accepted but unused --
    Claude Code writes its own status ledger (`~/.claude/sessions/<pid>.json`),
    independent of any particular scan. It's part of the signature only so every
    adapter's `live_sessions` takes the same argument (see `agents.codex.live_sessions`,
    which needs it, having no ledger of its own)."""
    return _live.live_sessions()


def collect_usage(path: str) -> list:
    return _turns.collect(path)


def summarize_usage(turns: list, from_ts: Optional[float] = None,
                     to_ts: Optional[float] = None) -> dict:
    return _turns.summarize(turns, from_ts=from_ts, to_ts=to_ts)

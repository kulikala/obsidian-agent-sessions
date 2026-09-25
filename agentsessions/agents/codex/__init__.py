"""The `codex` agent adapter: OpenAI Codex CLI sessions
(`CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, `CODEX_HOME` defaulting to
`~/.codex`).

Same uniform surface as `agents.claude` (`list_transcripts`, `scan`,
`find_transcript`, `read_detail_for`, `live_sessions`, `collect_usage`), so
`agentsessions/cli/json_output.py` can loop over `agentsessions.agents.enabled_agents()`
without an agent-specific branch. Everything here only ever *reads*
`CODEX_HOME` -- no file under it is written, and the one thing that touches its
sqlite database (`names.lookup_thread_info`) opens it `mode=ro` -- so this adapter can
run safely alongside a live `codex` process without disturbing it.
"""
from typing import Dict, List, Optional

from ...sessions.detail import Detail
from ...sessions.model import Session
from . import detail as _detail
from . import live as _live
from . import resolve  # noqa: F401  (re-exported: agentsessions.agents.codex.resolve.resolve())
from . import rollout
from . import scan as _scan
from . import stats  # noqa: F401  (re-exported: agentsessions.agents.codex.stats.windows())
from . import usage as _usage

NAME = 'codex'


def list_transcripts() -> List[str]:
    return rollout.list_transcripts()


def scan(paths: List[str], cache: Optional[Dict[str, dict]] = None) -> Dict[str, Session]:
    return _scan.scan(paths, cache=cache)


def find_transcript(session_id: str) -> Optional[str]:
    for p in rollout.list_transcripts():
        if rollout.session_id_of(p) == session_id:
            return p
    return None


def read_detail_for(path: Optional[str]) -> Detail:
    return _detail.read_detail_for(path)


def live_sessions(sessions: Dict[str, Session]) -> Dict[str, _live.Live]:
    """Unlike `agents.claude.live_sessions` (which needs no input -- Claude Code
    writes its own ledger keyed by session id), Codex has nothing to enumerate
    from except the rollouts themselves, so this takes the already-scanned
    `{id: Session}` map (from `scan`, above) rather than re-listing transcripts."""
    return _live.live_sessions(sessions)


def collect_usage(path: str) -> list:
    return _usage.collect(path)


def summarize_usage(turns: list, from_ts: Optional[float] = None,
                     to_ts: Optional[float] = None) -> dict:
    return _usage.summarize(turns, from_ts=from_ts, to_ts=to_ts)

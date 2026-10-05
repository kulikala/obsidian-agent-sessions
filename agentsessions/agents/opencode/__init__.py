"""The `opencode` agent adapter: OpenCode sessions, read from its SQLite database
(`$XDG_DATA_HOME/opencode/opencode.db`, default `~/.local/share/opencode/`).

Same uniform surface as `agents.codex` (`list_transcripts`, `scan`,
`find_transcript`, `read_detail_for`, `live_sessions`, `collect_usage`), so
`agentsessions/cli/json_output.py` needs no agent-specific branch beyond its
dispatch table. OpenCode has no transcript files: a "transcript" here is the
pseudo path `opencode:<ses_id>` (see `db.py`). Everything only ever *reads* the
database (`mode=ro`), so it runs safely alongside a live `opencode`. Busy/idle/
waiting comes from the plugin `setup.py` installs (see `live.py`). There are no
vendor rate-limit windows, so there is no `stats`.
"""
from typing import Dict, List, Optional

from ...sessions.detail import Detail
from ...sessions.model import Session
from . import detail as _detail
from . import live as _live
from . import resolve  # noqa: F401  (re-exported: agentsessions.agents.opencode.resolve.resolve())
from . import scan as _scan
from . import setup  # noqa: F401  (re-exported: agentsessions.agents.opencode.setup.install())
from . import usage as _usage

NAME = 'opencode'
# Prefix of every pseudo transcript path; `json_output` uses it as this agent's
# "root" when deciding which cache entries are safe to prune.
PSEUDO_ROOT = 'opencode:'


def list_transcripts() -> List[str]:
    return _scan.list_transcripts()


def scan(paths: List[str], cache: Optional[Dict[str, dict]] = None) -> Dict[str, Session]:
    return _scan.scan(paths, cache=cache)


def find_transcript(session_id: str) -> Optional[str]:
    return _scan.find_transcript(session_id)


def read_detail_for(path: Optional[str]) -> Detail:
    return _detail.read_detail_for(path)


def live_sessions(sessions: Optional[Dict[str, Session]] = None) -> Dict[str, _live.Live]:
    return _live.live_sessions(sessions)


def collect_usage(path: str) -> list:
    return _usage.collect_for(path)


def summarize_usage(turns: list, from_ts: Optional[float] = None,
                     to_ts: Optional[float] = None) -> dict:
    return _usage.summarize(turns, from_ts=from_ts, to_ts=to_ts)


def activity_turns(path: str) -> List[list]:
    from . import db as _db
    sid = _db.session_id_of(path)
    return _scan.activity_turns(sid) if sid else []

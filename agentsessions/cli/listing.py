"""The session list `agent-sessions sessions` and `show` share: every enabled agent's sessions merged
with their live status, and the lookups on top (which session is the caller's own, which one a name or
id prefix means)."""
import os
import time
from typing import Any, Dict, List, Optional

from ..sessions import model
from . import json_output

# The CLI's status words, from the raw `busy | shell | waiting | idle` a live entry carries. A session
# with no live entry has no running agent process.
STATUS_OF_LIVE = {'busy': 'running', 'shell': 'running', 'waiting': 'asking', 'idle': 'idle'}
ENDED = 'ended'
MIN_PREFIX = 4


class NotFound(Exception):
    pass


class Ambiguous(Exception):
    def __init__(self, query: str, rows: List[Dict[str, Any]]):
        super().__init__(query)
        self.query = query
        self.rows = rows


def own_session_id(environ: Optional[Dict[str, str]] = None) -> Optional[str]:
    """The id of the session the caller runs in, as `sessions.json` and the scan know it: the daemon id
    (`AGENT_SESSIONS_ID`) mapped through the store's links (a Codex or OpenCode session's daemon id is
    not its own), else what the agent itself exposes to its tools (`CLAUDE_CODE_SESSION_ID`,
    `CODEX_THREAD_ID`). `None` outside any session."""
    env = os.environ if environ is None else environ
    daemon_id = env.get('AGENT_SESSIONS_ID')
    if daemon_id:
        return json_output._daemon_links().get(daemon_id) or daemon_id
    return env.get('CLAUDE_CODE_SESSION_ID') or env.get('CODEX_THREAD_ID') or None


def collect(environ: Optional[Dict[str, str]] = None, include_children: bool = False,
            include_archived: bool = False) -> List[Dict[str, Any]]:
    """Every session with `status` (running | asking | idle | ended), newest activity first. `category` is
    the part of a given name before `: ` (the plugin's group), `None` without one."""
    scan = json_output.scan_output()
    live = json_output.live_output()
    archived = {a.get('id') for a in scan['store'].get('archived', []) if isinstance(a, dict)}
    running_in_daemon = {s.get('id') for s in live['daemon']['sessions']
                         if isinstance(s, dict) and s.get('exited') is None}
    own = own_session_id(environ)
    rows: List[Dict[str, Any]] = []
    for s in scan['sessions']:
        if s['child'] and not include_children:
            continue
        if s['id'] in archived and not include_archived:
            continue
        entry = live['live'].get(s['id'])
        category = model.split_name(s['name'])[0] if s['name'] else None
        row = {
            'id': s['id'],
            'agent': s['agent'],
            'name': s['name'] or s['label'],
            'named': bool(s['name']),
            'category': category,
            'folder': s['folder'],
            'cwd': s['cwd'],
            'status': STATUS_OF_LIVE.get(entry['status'], 'idle') if entry else ENDED,
            'last_activity': s['last_activity'],
            'in_daemon': s['id'] in running_in_daemon,
            'self': s['id'] == own,
            'archived': s['id'] in archived,
            'child': bool(s['child']),
        }
        if entry and entry.get('waiting_for'):
            row['waiting_for'] = entry['waiting_for']
        rows.append(row)
    rows.sort(key=lambda r: r['last_activity'] or 0, reverse=True)
    return rows


def find(rows: List[Dict[str, Any]], query: str) -> Dict[str, Any]:
    """One row for `query`: an exact id, else a unique id prefix (at least `MIN_PREFIX` characters), else
    an exact name (ignoring case), else a unique name substring. Raises `NotFound` / `Ambiguous`."""
    q = query.strip()
    for r in rows:
        if r['id'] == q:
            return r
    ql = q.lower()
    steps = (
        [r for r in rows if len(q) >= MIN_PREFIX and r['id'].startswith(q)],
        [r for r in rows if r['name'].lower() == ql],
        [r for r in rows if ql and ql in r['name'].lower()],
    )
    for hits in steps:
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            raise Ambiguous(q, hits)
    raise NotFound(q)


def in_category(row: Dict[str, Any], category: str) -> bool:
    """Whether the row's category is `category`, ignoring case and surrounding spaces. An empty
    `category` means sessions with none."""
    want = category.strip().lower()
    have = (row.get('category') or '').lower()
    return have == want


def categories(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Each category among `rows` with how many sessions it has and how many of them are ended,
    most sessions first (then by name). Sessions with no category are left out."""
    counts: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        c = r.get('category')
        if not c:
            continue
        e = counts.setdefault(c, {'category': c, 'sessions': 0, 'ended': 0})
        e['sessions'] += 1
        if r['status'] == ENDED:
            e['ended'] += 1
    return sorted(counts.values(), key=lambda e: (-e['sessions'], e['category'].lower()))


def matches(row: Dict[str, Any], query: str) -> bool:
    ql = query.lower()
    return any(ql in str(row[k]).lower() for k in ('id', 'name', 'cwd', 'agent', 'status'))


def ago(epoch: Optional[float], now: Optional[float] = None) -> str:
    if not epoch:
        return '-'
    secs = max(0, int((time.time() if now is None else now) - epoch))
    if secs < 60:
        return '%ds ago' % secs
    if secs < 3600:
        return '%dm ago' % (secs // 60)
    if secs < 86400:
        return '%dh ago' % (secs // 3600)
    return '%dd ago' % (secs // 86400)

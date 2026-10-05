"""Listing and scanning OpenCode sessions -- the opencode analogue of
`agentsessions.sessions.scan.scan`, but over rows of `opencode.db` (see `db.py`)
instead of transcript files, so nothing is cached in `scan-cache.json`.

A session is listed when it is a top-level one (`parent_id IS NULL`, i.e. not a
sub-agent's), not archived, and has at least one user message (OpenCode creates
an empty session row at every TUI launch). Its name is the session `title`
unless that is still OpenCode's placeholder (`New session - <timestamp>`,
replaced by a generated title after the first turn); the first user prompt is
the first non-synthetic text part of the first user message.

Only sessions a person started interactively should show up. Sub-agent sessions
are excluded outright (above). Of the rest, `opencode run` (a script, a tool, an
agent shelling out) is told apart by its session's `permission` column: `run`
creates the session with a rule denying the `question` permission, since nobody
is there to answer (verified on OpenCode 1.18.33; the TUI, `opencode acp` and
sessions created over the HTTP API/SDK write no such rule and their rows are
otherwise indistinguishable from TUI ones). Such sessions are reported with
`child=True`, like Codex `exec` and Claude `-p` sessions, so the list hides them.
"""
from typing import Dict, List, Optional

from ...sessions.detail import clean_text
from ...sessions.model import Session
from . import db as _db

FIRST_PROMPT_LEN = 300
_SESSION_COLUMNS = ('id', 'directory', 'title', 'time_created', 'time_updated', 'model',
                    'parent_id', 'time_archived', 'permission')


def eligible_sessions(d: '_db.Db') -> list:
    """Rows of the sessions that get listed, newest activity first."""
    cols = d.select_columns('session', _SESSION_COLUMNS, alias='s')
    where = ['EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND %s)' % d.role_is('user')]
    have = d.columns('session')
    if 'parent_id' in have:
        where.append('s.parent_id IS NULL')
    if 'time_archived' in have:
        where.append('s.time_archived IS NULL')
    return d.query('SELECT %s FROM session s WHERE %s ORDER BY s.time_updated DESC, s.id DESC'
                   % (cols, ' AND '.join(where)))


def list_transcripts(path: Optional[str] = None) -> List[str]:
    d = _db.open_db(path)
    if d is None:
        return []
    try:
        return [_db.pseudo_path(r['id']) for r in eligible_sessions(d)]
    finally:
        d.close()


def find_transcript(session_id: str, path: Optional[str] = None) -> Optional[str]:
    if not isinstance(session_id, str) or not session_id.startswith('ses_'):
        return None
    d = _db.open_db(path)
    if d is None:
        return None
    try:
        rows = d.query('SELECT id FROM session WHERE id = ?', (session_id,))
        return _db.pseudo_path(session_id) if rows else None
    finally:
        d.close()


def first_prompt(d: '_db.Db', session_id: str) -> str:
    rows = d.query('SELECT p.data FROM part p JOIN message m ON m.id = p.message_id '
                   'WHERE m.session_id = ? AND %s ORDER BY m.time_created, m.id, p.id LIMIT 200' % d.role_is('user'),
                   (session_id,))
    for r in rows:
        text = _db.text_of_parts([r])
        if text:
            return clean_text(text).strip()[:FIRST_PROMPT_LEN]
    return ''


def latest_model(d: '_db.Db', session_id: str) -> Optional[str]:
    rows = d.query('SELECT data FROM message m WHERE m.session_id = ? AND %s '
                   'ORDER BY m.time_created DESC, m.id DESC LIMIT 1' % d.role_is('assistant'),
                   (session_id,))
    return _db.model_of_message(_db.loads(rows[0]['data'])) if rows else None


def scan(paths: List[str], cache: Optional[Dict[str, dict]] = None,
         path: Optional[str] = None) -> Dict[str, Session]:
    """`{id: Session}` for the sessions `paths` (pseudo paths) name. `cache` is
    accepted for the adapter contract and never used."""
    wanted = {sid for sid in (_db.session_id_of(p) for p in paths) if sid}
    if not wanted:
        return {}
    d = _db.open_db(path)
    if d is None:
        return {}
    try:
        out: Dict[str, Session] = {}
        for r in eligible_sessions(d):
            sid = r['id']
            if sid not in wanted:
                continue
            title = r['title'] if isinstance(r['title'], str) else ''
            name = title if title and not title.startswith(_db.DEFAULT_TITLE_PREFIX) else None
            updated = r['time_updated'] or r['time_created'] or 0
            out[sid] = Session(
                id=sid, name=name, cwd=r['directory'] or '', mtime=updated / 1000.0,
                path=_db.pseudo_path(sid), first_prompt=first_prompt(d, sid), agent='opencode',
                child=_db.is_non_interactive(r['permission']), model=_db.model_of(r['model']) or latest_model(d, sid))
        return out
    finally:
        d.close()


def activity_turns(session_id: str, path: Optional[str] = None) -> List[list]:
    """Turns `[start, end, prompt, kind]` of a session (for the activity calendar): a user
    message starts one (its prompt is the message's first text part), and every message and
    part time counts as activity up to the next user message."""
    from ...sessions.activity import TurnBuilder
    d = _db.open_db(path)
    if d is None:
        return []
    try:
        messages = d.query('SELECT id, time_created, time_updated, data FROM message WHERE session_id = ?', (session_id,))
        parts = d.query('SELECT message_id, time_created, time_updated, data FROM part WHERE session_id = ? '
                        'ORDER BY time_created, id', (session_id,))
    finally:
        d.close()
    prompts = {}   # message id -> first text of its parts
    for r in parts:
        if r['message_id'] not in prompts:
            text = _db.text_of_parts([r])
            if text:
                prompts[r['message_id']] = clean_text(text).strip()
    events = []   # (time, is_prompt, text); at the same instant a prompt sorts first
    for r in messages:
        created, updated = r['time_created'], r['time_updated']
        if isinstance(created, (int, float)) and created > 0:
            is_user = _db.loads(r['data']).get('role') == 'user'
            events.append((created / 1000.0, 0 if is_user else 1, prompts.get(r['id'], '') if is_user else ''))
        if isinstance(updated, (int, float)) and updated > 0:
            events.append((updated / 1000.0, 1, ''))
    for r in parts:
        for v in (r['time_created'], r['time_updated']):
            if isinstance(v, (int, float)) and v > 0:
                events.append((v / 1000.0, 1, ''))
    b = TurnBuilder()
    for t, kind, text in sorted(events, key=lambda e: (e[0], e[1])):
        if kind == 0:
            b.prompt(t, text)
        else:
            b.activity(t)
    return b.finish()

"""The most recent exchange of an OpenCode session -- the opencode analogue of
`agentsessions.sessions.detail`, read from `message`/`part` rows (see `db.py`).

`last_user` is the text of the latest user message, `last_assistant` the latest
assistant message that has text, `tools` the tool names called since that user
message (in call order). `last_command` stays `None`: OpenCode's slash commands
(`/compact`, ...) are not recorded as user text. `model` is the latest
assistant message's `provider/model` (falling back to the session's own).
"""
from typing import Optional

from ...sessions.detail import MAX_CHARS, Detail, clean_text
from . import db as _db


def _message_text(d: '_db.Db', message_id: str) -> str:
    rows = d.query('SELECT data FROM part WHERE message_id = ? ORDER BY id', (message_id,))
    return _db.text_of_parts(rows)


def read_detail(session_id: str, path: Optional[str] = None) -> Detail:
    out = Detail()
    d = _db.open_db(path)
    if d is None:
        return out
    try:
        msgs = d.query('SELECT m.id, m.data FROM message m WHERE m.session_id = ? '
                       'ORDER BY m.time_created DESC, m.id DESC', (session_id,))
        tools = []
        for r in msgs:
            data = _db.loads(r['data'])
            role = data.get('role')
            if role == 'assistant':
                if out.model is None:
                    out.model = _db.model_of_message(data)
                if not out.last_assistant:
                    text = _message_text(d, r['id'])
                    if text.strip():
                        out.last_assistant = clean_text(text)[:MAX_CHARS]
                if not out.last_user:
                    for p in d.query('SELECT data FROM part WHERE message_id = ? ORDER BY id DESC',
                                     (r['id'],)):
                        pd = _db.loads(p['data'])
                        name = pd.get('tool')
                        if pd.get('type') == 'tool' and isinstance(name, str) and name:
                            tools.append(name)
            elif role == 'user' and not out.last_user:
                text = _message_text(d, r['id'])
                if text.strip():
                    out.last_user = clean_text(text)[:MAX_CHARS]
                    out.tools = list(reversed(tools))
            if out.last_user and out.last_assistant and out.model is not None:
                break
        if out.model is None:
            rows = d.query('SELECT model FROM session WHERE id = ?', (session_id,)) \
                if 'model' in d.columns('session') else []
            out.model = _db.model_of(rows[0]['model']) if rows else None
        return out
    finally:
        d.close()


def read_detail_for(path: Optional[str]) -> Detail:
    sid = _db.session_id_of(path) if path else None
    return read_detail(sid) if sid else Detail()

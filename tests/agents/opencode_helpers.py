"""Builds a synthetic OpenCode SQLite database for the opencode adapter tests.

The tables and columns are the subset of OpenCode 1.18's real schema the adapter
reads (`session`, `message`, `part`; `data` columns are JSON, times are epoch
milliseconds); every value is synthetic. `columns` lets a test drop optional
`session` columns to check the adapter tolerates schema drift.
"""
import json
import os
import sqlite3

SESSION_COLUMNS = ['id text PRIMARY KEY', 'directory text NOT NULL', 'title text NOT NULL',
                   'time_created integer NOT NULL', 'time_updated integer NOT NULL',
                   'parent_id text', 'time_archived integer', 'model text', 'permission text']


def make_db(directory: str, drop_columns=()) -> str:
    path = os.path.join(directory, 'opencode', 'opencode.db')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    cols = [c for c in SESSION_COLUMNS if c.split()[0] not in drop_columns]
    conn.execute('CREATE TABLE session (%s)' % ', '.join(cols))
    conn.execute('CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, '
                 'time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)')
    conn.execute('CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, '
                 'time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)')
    conn.commit()
    conn.close()
    return path


class Fixture:
    """`with Fixture(path) as f: f.session(...)`; commits and closes on exit."""

    def __init__(self, path: str):
        self.conn = sqlite3.connect(path)
        self.have = {r[1] for r in self.conn.execute('PRAGMA table_info(session)')}
        self._n = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.conn.commit()
        self.conn.close()

    def _next(self, prefix: str) -> str:
        self._n += 1
        return '%s_%06d' % (prefix, self._n)

    def session(self, sid: str, directory: str = '/work/proj', title: str = 'A title',
                created: int = 1_000_000, updated: int = None, parent_id=None, archived=None,
                model=None, permission=None) -> None:
        row = {'id': sid, 'directory': directory, 'title': title, 'time_created': created,
               'time_updated': updated if updated is not None else created,
               'parent_id': parent_id, 'time_archived': archived,
               'model': json.dumps(model) if model else None,
               'permission': json.dumps(permission) if permission else None}
        row = {k: v for k, v in row.items() if k in self.have}
        self.conn.execute('INSERT INTO session (%s) VALUES (%s)' % (','.join(row), ','.join('?' * len(row))),
                          list(row.values()))

    def message(self, sid: str, data: dict, created: int, parts=()) -> str:
        mid = self._next('msg')
        self.conn.execute('INSERT INTO message VALUES (?,?,?,?,?)',
                          (mid, sid, created, created, json.dumps(data)))
        for p in parts:
            self.conn.execute('INSERT INTO part VALUES (?,?,?,?,?,?)',
                              (self._next('prt'), mid, sid, created, created, json.dumps(p)))
        return mid

    def user(self, sid: str, text: str, created: int, extra_parts=()) -> str:
        return self.message(sid, {'role': 'user', 'time': {'created': created},
                                  'model': {'providerID': 'ollama', 'modelID': 'gemma'}},
                            created, [{'type': 'text', 'text': text}] + list(extra_parts))

    def assistant(self, sid: str, text: str, created: int, completed=True, tokens=None, cost=0.0,
                  model=('ollama', 'gemma'), tools=(), finish='stop') -> str:
        data = {'role': 'assistant', 'time': {'created': created}, 'providerID': model[0],
                'modelID': model[1], 'cost': cost,
                'tokens': tokens or {'total': 0, 'input': 0, 'output': 0, 'reasoning': 0,
                                     'cache': {'read': 0, 'write': 0}}}
        if completed:
            data['time']['completed'] = created + 5
            data['finish'] = finish
        parts = [{'type': 'tool', 'tool': t, 'state': {'status': 'completed'}} for t in tools]
        if text:
            parts.append({'type': 'text', 'text': text})
        return self.message(sid, data, created, parts)

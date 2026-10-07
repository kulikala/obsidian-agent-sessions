"""A synthetic `opencode.db` for the efficiency tests.

Tables and JSON shapes follow a real OpenCode 1.18 database: `session` (`directory`, `version`,
`parent_id`, `time_updated` in ms), `message.data` (`role`, `providerID`, `modelID`, `agent`,
`time`, `error`), and `part.data` of type `text`, `tool` (`state.input` / `.output` / `.status`
/ `.time`), `step-start`, `step-finish` (`tokens` with `reasoning` outside `output`, `cost`) and
`compaction`. Ids, paths and text are made up.
"""

import json
import sqlite3
from typing import List, Optional

SCHEMA = [
    'CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, '
    'title TEXT, version TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, agent TEXT, model TEXT)',
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, '
    'time_updated INTEGER, data TEXT)',
]


def create(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    for sql in SCHEMA:
        conn.execute(sql)
    return conn


class Session:
    _seq = 0

    def __init__(self, conn: sqlite3.Connection, sid: str, start: float, cwd: str = '/work/repo',
                 provider: str = 'anthropic', model: str = 'claude-sonnet-5', parent: Optional[str] = None,
                 version: str = '1.18.34'):
        self.conn = conn
        self.sid = sid
        self.t = start
        self.cwd = cwd
        self.provider = provider
        self.model = model
        self.parent = parent
        self.version = version
        self.agent = 'build'
        self.msg: Optional[str] = None

    @classmethod
    def _id(cls, prefix: str) -> str:
        cls._seq += 1
        return '%s_%012d' % (prefix, cls._seq)

    def _ms(self) -> int:
        return int(self.t * 1000)

    def _message(self, data: dict) -> str:
        mid = self._id('msg')
        self.conn.execute('INSERT INTO message VALUES (?, ?, ?, ?, ?)',
                          (mid, self.sid, self._ms(), self._ms(), json.dumps(data, ensure_ascii=False)))
        return mid

    def _part(self, data: dict) -> str:
        pid = self._id('prt')
        self.conn.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)',
                          (pid, self.msg, self.sid, self._ms(), self._ms(), json.dumps(data, ensure_ascii=False)))
        return pid

    def prompt(self, text: str, after: float = 5.0) -> str:
        self.t += after
        self.msg = self._message({'role': 'user', 'agent': self.agent, 'time': {'created': self._ms()},
                                  'model': {'providerID': self.provider, 'modelID': self.model}})
        self._part({'type': 'text', 'text': text})
        return self.msg

    def reply(self, provider: Optional[str] = None, model: Optional[str] = None, agent: Optional[str] = None,
              error: Optional[str] = None, after: float = 1.0) -> str:
        self.t += after
        self.msg = self._message({'role': 'assistant', 'providerID': provider or self.provider,
                                  'modelID': model or self.model, 'agent': agent or self.agent,
                                  'mode': agent or self.agent, 'time': {'created': self._ms()},
                                  **({'error': {'name': error, 'data': {}}} if error else {})})
        return self.msg

    def step(self, tools: Optional[List[dict]] = None, text: Optional[str] = 'ok', ctx: int = 30000,
             write: int = 500, output: int = 200, reasoning: int = 0, cost: float = 0.0, after: float = 3.0) -> str:
        """One model request inside the current assistant message: its parts, then `step-finish`."""
        self.t += after
        self._part({'type': 'step-start'})
        if text:
            self._part({'type': 'text', 'text': text})
        for tool in tools or []:
            self._part(tool)
        unc = 3
        read = max(ctx - write - unc, 0)
        return self._part({'type': 'step-finish', 'reason': 'tool-calls', 'cost': cost, 'tokens': {
            'input': unc, 'output': output, 'reasoning': reasoning, 'cache': {'read': read, 'write': write},
            'total': unc + output + reasoning + read + write}})

    @staticmethod
    def tool(name: str, inp: dict, output: str = 'done', status: str = 'completed', call: str = '') -> dict:
        Session._seq += 1
        return {'type': 'tool', 'callID': call or 'call_%d' % Session._seq, 'tool': name,
                'state': {'status': status, 'input': inp, 'output': output, 'time': {'start': 1, 'end': 2}}}

    def compaction(self, after: float = 5.0) -> None:
        self.t += after
        self.msg = self._message({'role': 'user', 'agent': self.agent, 'time': {'created': self._ms()}})
        self._part({'type': 'compaction', 'auto': True})

    def save(self, title: str = 'a session') -> None:
        self.conn.execute('INSERT OR REPLACE INTO session (id, parent_id, directory, title, version, time_created, '
                          'time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
                          (self.sid, self.parent, self.cwd, title, self.version, self._ms(), self._ms()))
        self.conn.commit()

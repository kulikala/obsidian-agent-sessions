"""Synthetic Claude Code transcripts for the efficiency tests.

The line shapes follow real transcripts (keys, nesting, which line carries what), but every
id, path and text is made up: prompts are filler sentences in one of three languages, paths
live under `/work/...`, and nothing here came from a real conversation.
"""

import json
import os
import uuid as uuid_mod
from datetime import datetime, timezone
from typing import List, Optional

CWD = '/work/vault'
VERSION = '2.1.280'
MODEL = 'claude-opus-5'

# Filler sentences: the same meaning-free content in three scripts, used to build prompts of a
# chosen estimated length in each language.
FILLER = {
    'en': 'Please look at the parser module and keep the output format as it is. ',
    'ja': 'パーサのモジュールを見て、出力の形式はそのままにしてください。',
    'es': 'Por favor revisa el módulo del analizador y conserva el formato de salida. ',
}
SHORT = {'en': 'redo', 'ja': 'やり直し', 'es': 'rehaz'}


def est(text: str) -> float:
    a = sum(1 for ch in text if ord(ch) < 128)
    return a / 4 + (len(text) - a) / 1.5


def text_of(lang: str, tokens: float) -> str:
    """A prompt in `lang` of roughly `tokens` estimated tokens (never fewer)."""
    if tokens <= est(SHORT[lang]):
        return SHORT[lang]
    out = ''
    while est(out) < tokens:
        out += FILLER[lang]
    return out.strip()


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')


class Transcript:
    """Appends lines in transcript order; `t` is the clock (epoch seconds)."""

    def __init__(self, session: str, start: float, cwd: str = CWD, version: str = VERSION,
                 agent_id: Optional[str] = None, model: str = MODEL):
        self.session = session
        self.t = start
        self.cwd = cwd
        self.version = version
        self.agent_id = agent_id
        self.model = model
        self.lines: List[dict] = []
        self._n = 0
        self.ttl_1h = agent_id is None

    def _base(self, kind: str) -> dict:
        rec = {'parentUuid': None, 'isSidechain': self.agent_id is not None, 'type': kind,
               'uuid': str(uuid_mod.uuid5(uuid_mod.NAMESPACE_URL, '%s/%d' % (self.session, len(self.lines)))),
               'timestamp': iso(self.t), 'cwd': self.cwd, 'sessionId': self.session,
               'version': self.version, 'userType': 'external'}
        if self.agent_id:
            rec['agentId'] = self.agent_id
        return rec

    def wait(self, seconds: float) -> 'Transcript':
        self.t += seconds
        return self

    def prompt(self, text: str, after: float = 5.0, **extra) -> str:
        self.wait(after)
        rec = self._base('user')
        rec['message'] = {'role': 'user', 'content': [{'type': 'text', 'text': text}]}
        rec['origin'] = {'kind': 'human'}
        rec.update(extra)
        self.lines.append(rec)
        return rec['uuid']

    def raw_user(self, content, after: float = 1.0, **extra) -> None:
        self.wait(after)
        rec = self._base('user')
        rec['message'] = {'role': 'user', 'content': content}
        rec.update(extra)
        self.lines.append(rec)

    def call(self, tools: Optional[List[dict]] = None, text: Optional[str] = 'ok',
             ctx: int = 30000, write: int = 500, output: int = 200, after: float = 3.0,
             msg_id: Optional[str] = None, model: Optional[str] = None, effort: str = 'high',
             fresh: bool = False) -> str:
        """One API call, written one line per content block like Claude Code does. `ctx` is the
        total input; `write` of it is a cache write (all of it when `fresh`)."""
        self.wait(after)
        self._n += 1
        msg_id = msg_id or 'msg_%s_%s_%d' % (self.session[:8], self.agent_id or 'm', self._n)
        write = ctx if fresh else write
        usage = {'input_tokens': 3, 'cache_creation_input_tokens': write,
                 'cache_read_input_tokens': max(ctx - write - 3, 0), 'output_tokens': output,
                 'cache_creation': {'ephemeral_1h_input_tokens': write if self.ttl_1h else 0,
                                    'ephemeral_5m_input_tokens': 0 if self.ttl_1h else write}}
        blocks = [{'type': 'thinking', 'thinking': '', 'signature': 'c2ln'}]
        if text:
            blocks.append({'type': 'text', 'text': text})
        for tool in tools or []:
            blocks.append(dict({'type': 'tool_use'}, **tool))
        for b in blocks:
            rec = self._base('assistant')
            rec['message'] = {'model': model or self.model, 'id': msg_id, 'type': 'message',
                              'role': 'assistant', 'content': [b], 'usage': usage}
            rec['effort'] = effort
            self.lines.append(rec)
        return msg_id

    def tool(self, name: str, **inp) -> dict:
        self._n += 1
        return {'id': 'toolu_%s_%d' % (self.session[:6], self._n), 'name': name, 'input': inp}

    def result(self, tool: dict, text: str = 'done', after: float = 1.0, is_error: bool = False,
               tool_use_result=None) -> None:
        self.wait(after)
        rec = self._base('user')
        block = {'type': 'tool_result', 'tool_use_id': tool['id'], 'content': text}
        if is_error:
            block['is_error'] = True
        rec['message'] = {'role': 'user', 'content': [block]}
        rec['toolUseResult'] = tool_use_result if tool_use_result is not None else {'stdout': text}
        self.lines.append(rec)

    def edit(self, path: str, old: str, new: str, **kw) -> str:
        tool = self.tool('Edit', file_path=path, old_string=old, new_string=new)
        msg = self.call(tools=[tool], **kw)
        self.result(tool, 'edited')
        return msg

    def read(self, path: str, size: int = 400, **kw) -> str:
        tool = self.tool('Read', file_path=path)
        msg = self.call(tools=[tool], **kw)
        self.result(tool, 'x' * size)
        return msg

    def interrupt(self, for_tool: bool = False, after: float = 2.0) -> None:
        text = '[Request interrupted by user for tool use]' if for_tool else '[Request interrupted by user]'
        self.raw_user([{'type': 'text', 'text': text}], after=after)

    def compaction(self, trigger: str = 'auto', pre: int = 990000, after: float = 5.0) -> None:
        self.wait(after)
        rec = self._base('system')
        rec.update({'subtype': 'compact_boundary', 'content': 'Conversation compacted',
                    'logicalParentUuid': 'prev', 'level': 'info',
                    'compactMetadata': {'trigger': trigger, 'preTokens': pre, 'postTokens': 20000}})
        self.lines.append(rec)

    def attachment(self, att: dict) -> None:
        rec = self._base('attachment')
        rec['attachment'] = att
        self.lines.append(rec)

    def preamble(self, skills: int = 60, instr_lines: int = 40) -> None:
        self.attachment({'type': 'skill_listing', 'content': '', 'skillCount': skills,
                         'isInitial': True, 'names': []})
        body = ''.join('line %d of the project notes\n' % i for i in range(instr_lines))
        self.attachment({'type': 'instructions', 'files': [
            {'path': os.path.join(self.cwd, 'CLAUDE.md'), 'type': 'Project', 'content': body}]})

    def spawn(self, agent_id: str, teammate: bool = False, **kw) -> dict:
        """An `Agent` call and its result linking `agent_id`'s transcript."""
        tool = self.tool('Agent', description='look around', prompt='filler', subagent_type='general-purpose')
        self.call(tools=[tool], **kw)
        result = ({'status': 'teammate_spawned', 'team_name': 'crew', 'teammate_id': agent_id,
                   'agent_id': agent_id, 'name': 'helper'} if teammate
                  else {'status': 'completed', 'agentId': agent_id, 'totalTokens': 1000})
        self.result(tool, 'spawned', tool_use_result=result)
        return tool

    def write(self, path: str) -> str:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            for rec in self.lines:
                f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        return path


def project_dir(root: str, cwd: str = CWD) -> str:
    return os.path.join(root, cwd.replace('/', '-'))


def session_uuid(n: int) -> str:
    return '00000000-0000-4000-8000-%012d' % n

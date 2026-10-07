"""Synthetic Codex rollouts for the efficiency tests.

Line shapes follow real rollouts of Codex 0.147 (usage only in `token_count.last_token_usage`)
and 0.160 (a `token_usage_record` per response): `session_meta`, `task_started`, `turn_context`,
`item_completed` / `user_message`, `response_item` (`message`, `reasoning`, `function_call`,
`custom_tool_call` and their outputs), `compacted`, `turn_aborted`. Ids, paths and text are made
up.
"""

import json
import os
from typing import List, Optional

from tests.efficiency.builder import iso

CWD = '/work/repo'


class Rollout:
    def __init__(self, thread: str, start: float, cwd: str = CWD, version: str = '0.160.1',
                 model: str = 'gpt-5.6-terra', provider: str = 'openai', records: bool = True,
                 source='cli'):
        self.thread = thread
        self.t = start
        self.cwd = cwd
        self.model = model
        self.records = records
        self.lines: List[dict] = []
        self.total = {'input_tokens': 0, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                      'output_tokens': 0, 'reasoning_output_tokens': 0, 'total_tokens': 0}
        self._n = 0
        self.add('session_meta', {'id': thread, 'session_id': thread, 'cwd': cwd, 'cli_version': version,
                                  'source': source, 'model_provider': provider, 'originator': 'codex-tui'})

    def add(self, kind: str, payload: dict, after: float = 0.0) -> dict:
        self.t += after
        rec = {'timestamp': iso(self.t), 'type': kind, 'payload': payload}
        self.lines.append(rec)
        return rec

    def turn(self, text: Optional[str], after: float = 5.0, new_style: bool = True,
             model: Optional[str] = None, effort: str = 'medium', instructions: Optional[str] = None) -> None:
        self._n += 1
        tid = 'turn-%s-%d' % (self.thread[:6], self._n)
        self.add('event_msg', {'type': 'task_started', 'turn_id': tid, 'model_context_window': 258400}, after)
        if instructions is not None:
            self.add('response_item', {'type': 'message', 'role': 'user', 'content': [
                {'type': 'input_text', 'text': '# AGENTS.md instructions for %s\n\n<INSTRUCTIONS>\n%s\n</INSTRUCTIONS>'
                 % (self.cwd, instructions)}]})
        self.add('turn_context', {'turn_id': tid, 'cwd': self.cwd, 'model': model or self.model, 'effort': effort})
        if text is None:
            return
        if new_style:
            self.add('event_msg', {'type': 'item_completed', 'turn_id': tid, 'item': {
                'type': 'UserMessage', 'id': 'item-%s-%d' % (self.thread[:6], self._n),
                'content': [{'type': 'text', 'text': text}]}})
        else:
            self.add('event_msg', {'type': 'user_message', 'message': text, 'images': [], 'kind': 'plain'})

    def call(self, ctx: int = 30000, cached: Optional[int] = None, output: int = 200, reasoning: int = 50,
             text: Optional[str] = 'ok', tools: Optional[List[dict]] = None, after: float = 3.0,
             repeat_total: bool = False) -> None:
        """One response: its items, then its usage line(s)."""
        self.t += after
        self._n += 1
        cached = ctx - 1000 if cached is None else cached
        if text:
            self.add('response_item', {'type': 'message', 'role': 'assistant',
                                       'content': [{'type': 'output_text', 'text': text}]})
        for tool in tools or []:
            self.lines.append({'timestamp': iso(self.t), 'type': 'response_item', 'payload': tool['call']})
        usage = {'input_tokens': ctx, 'cached_input_tokens': cached, 'cache_write_input_tokens': 0,
                 'output_tokens': output, 'reasoning_output_tokens': reasoning, 'total_tokens': ctx + output}
        for k in self.total:
            self.total[k] += usage[k]
        if self.records:
            self.add('token_usage_record', {'thread_id': self.thread, 'response_id': 'resp_%s_%d' % (self.thread[:6], self._n),
                                            'usage': usage})
        info = {'total_token_usage': dict(self.total), 'last_token_usage': usage, 'model_context_window': 258400}
        self.add('event_msg', {'type': 'token_count', 'info': info, 'rate_limits': None})
        if repeat_total:
            self.add('event_msg', {'type': 'token_count', 'info': info, 'rate_limits': None})
        for tool in tools or []:
            self.add('response_item', tool['output'], after=1.0)

    @staticmethod
    def shell(call_id: str, cmd: str, output: str = 'done', code: int = 0) -> dict:
        return {'call': {'type': 'function_call', 'name': 'exec_command', 'call_id': call_id,
                         'arguments': json.dumps({'cmd': cmd})},
                'output': {'type': 'function_call_output', 'call_id': call_id,
                           'output': 'Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code %d\nOutput:\n%s'
                           % (code, output)}}

    @staticmethod
    def patch(call_id: str, path: str, old: str, new: str) -> dict:
        body = '*** Begin Patch\n*** Update File: %s\n@@\n-%s\n+%s\n*** End Patch\n' % (path, old, new)
        return {'call': {'type': 'custom_tool_call', 'name': 'apply_patch', 'call_id': call_id, 'input': body,
                         'status': 'completed'},
                'output': {'type': 'custom_tool_call_output', 'call_id': call_id, 'output': 'Success.'}}

    @staticmethod
    def code(call_id: str, source: str, output: str) -> dict:
        return {'call': {'type': 'custom_tool_call', 'name': 'exec', 'call_id': call_id, 'input': source},
                'output': {'type': 'custom_tool_call_output', 'call_id': call_id,
                           'output': [{'type': 'input_text', 'text': 'Script completed\n'},
                                      {'type': 'input_text', 'text': output}]}}

    def compaction(self, after: float = 5.0) -> None:
        self.add('compacted', {'message': '', 'replacement_history': []}, after)

    def abort(self, after: float = 2.0) -> None:
        self.add('event_msg', {'type': 'turn_aborted', 'reason': 'interrupted'}, after)

    def write(self, home: str) -> str:
        day = self.lines[0]['timestamp'][:10].split('-')
        folder = os.path.join(home, 'sessions', *day)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, 'rollout-%s-%s.jsonl' % (self.lines[0]['timestamp'][:19].replace(':', '-'), self.thread))
        with open(path, 'w', encoding='utf-8') as f:
            for rec in self.lines:
                f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        return path


def thread_id(n: int) -> str:
    return '01a00000-0000-7000-8000-%012d' % n

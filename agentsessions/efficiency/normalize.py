"""Claude Code transcript -> calls, prompts and events, as numbers and flags only.

`read_file(path)` reads one transcript (a session's main file, or one of its sub-agent
or teammate files) and returns a *file record*: a JSON-serialisable dict that holds no
conversation text. Prompts become a length (estimated tokens), a gap and a few flags;
tool calls become a kind, a target path (relative to the session's `cwd`) and hashes;
replies become nothing but the byte offset of their line, so `excerpt.py` can read them
back later. This record is what `cache.py` stores.

Calls are API requests: `assistant` lines grouped by `message.id` (one request is written
as one line per content block); the usage is the last line's, `<synthetic>` lines are
not calls. Tool results are measured from the `tool_result` block in `message.content`
(what the model saw: a `<persisted-output>` preview for large outputs), never from the
line's `toolUseResult` (the raw output, often many times larger).

The only strings matched are record formats Claude Code itself writes
(`[Request interrupted by user`, `<teammate-message`, `<command-name>`, the
`<system-reminder>` family that `detail.clean_text` drops) -- never words a person typed.
"""

import functools
import hashlib
import json
import os
import re
from typing import Dict, List, Optional

from ..sessions import detail
from ..usage import stats as usage_stats
from ..usage.turns import _parse_ts

INTERRUPT_MARK = '[Request interrupted by user'
INTERRUPT_TOOL_MARK = '[Request interrupted by user for tool use]'
TEAMMATE_MARK = '<teammate-message'
COMMAND_MARK = '<command-name>'
TEAMMATE_SPAWNED = 'teammate_spawned'

# Removed before a prompt's length is measured: text Claude Code inserts into a user line.
_INSERTED_RE = re.compile(r'<(system-reminder|local-command-stdout|local-command-caveat)>.*?</\1>', re.S)

READ_TOOLS = ('Read', 'NotebookRead', 'View')
SEARCH_TOOLS = ('Grep', 'Glob', 'LS')
EDIT_TOOLS = ('Edit', 'MultiEdit', 'Write', 'NotebookEdit')
EXEC_TOOLS = ('Bash', 'BashOutput', 'KillShell', 'PowerShell', 'Monitor')
AGENT_TOOLS = ('Agent', 'Task', 'SendMessage')
WEB_TOOLS = ('WebFetch', 'WebSearch')

HASH_LEN = 12


def est_tokens(text: str) -> float:
    """Estimated tokens of a string with no recorded count: ASCII at 4 characters a token,
    everything else at 1.5 (so a CJK prompt isn't measured as 3x shorter than it is)."""
    if not text:
        return 0.0
    ascii_chars = len(text.encode('ascii', 'ignore'))
    return ascii_chars / 4 + (len(text) - ascii_chars) / 1.5


def short_hash(text: str) -> str:
    return hashlib.sha1(text.encode('utf-8', 'surrogatepass')).hexdigest()[:HASH_LEN]


def tool_kind(name: str) -> str:
    if name in READ_TOOLS:
        return 'read'
    if name in SEARCH_TOOLS:
        return 'search'
    if name in EDIT_TOOLS:
        return 'edit'
    if name in EXEC_TOOLS:
        return 'exec'
    if name in AGENT_TOOLS:
        return 'agent'
    if name in WEB_TOOLS:
        return 'web'
    if name.startswith('mcp__'):
        return 'mcp'
    return 'other'


def rel_path(path: Optional[str], cwd: Optional[str]) -> Optional[str]:
    """`path` relative to `cwd` (POSIX separators), or `None`."""
    if not isinstance(path, str) or not path:
        return None
    if not cwd or not os.path.isabs(path):
        return path.replace(os.sep, '/')
    try:
        return os.path.relpath(path, cwd).replace(os.sep, '/')
    except ValueError:       # another drive on Windows
        return path.replace(os.sep, '/')


@functools.lru_cache(maxsize=65536)
def abs_path(rel: Optional[str], cwd: Optional[str]) -> Optional[str]:
    if not rel:
        return None
    if os.path.isabs(rel) or not cwd:
        return os.path.normpath(rel)
    return os.path.normpath(os.path.join(cwd, rel))


def command_key(command: str) -> str:
    """A hash of a shell command's first two words (`npm test`, `git log`): what E01 groups
    repeated large outputs by. The words themselves aren't kept."""
    words = command.split()
    return short_hash(' '.join(words[:2])) if words else ''


def _tool_target(name: str, inp: dict) -> Optional[str]:
    for key in ('file_path', 'notebook_path', 'path'):
        value = inp.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _edit_pairs(name: str, inp: dict) -> List[tuple]:
    """`[(old, new)]` strings of an edit tool call (`old` is `None` for a whole-file write)."""
    if name == 'Edit':
        return [(inp.get('old_string'), inp.get('new_string'))]
    if name == 'MultiEdit':
        edits = inp.get('edits')
        return [(e.get('old_string'), e.get('new_string')) for e in edits
                if isinstance(e, dict)] if isinstance(edits, list) else []
    if name == 'Write':
        return [(None, inp.get('content'))]
    if name == 'NotebookEdit':
        return [(None, inp.get('new_source'))]
    return []


def _hash_or_none(value) -> Optional[str]:
    return short_hash(value) if isinstance(value, str) and value else None


def _result_text(block: dict) -> str:
    body = block.get('content')
    if isinstance(body, str):
        return body
    if isinstance(body, list):
        return '\n'.join(b.get('text') or '' for b in body
                         if isinstance(b, dict) and b.get('type') == 'text')
    return ''


def _int(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def prompt_text(raw: str) -> str:
    """A human prompt with the text Claude Code inserted into the same line removed."""
    return _INSERTED_RE.sub('', raw).strip()


def chain_of(path: str) -> Optional[str]:
    """`<agentId>` of a sub-agent file `…/agent-<agentId>.jsonl`, `None` for a main file."""
    base = os.path.basename(path)
    if base.startswith('agent-') and base.endswith('.jsonl'):
        return base[len('agent-'):-len('.jsonl')]
    return None


class _Call:
    __slots__ = ('id', 'ts', 'model', 'effort', 'version', 'usage', 'tools', 'edits',
                 'text_off', 'visible', 'first_off')

    def __init__(self, msg_id, ts, off):
        self.id = msg_id
        self.ts = ts
        self.model = None
        self.effort = None
        self.version = None
        self.usage = {}
        self.tools: List[dict] = []
        self.edits: List[dict] = []
        self.text_off: Optional[int] = None
        self.visible = 0.0
        self.first_off = off


def read_file(path: str, session: Optional[str] = None) -> dict:
    """The file record of one transcript (see the module docstring). Lines that aren't JSON
    are skipped; a file that can't be opened gives an empty record."""
    rec_out = {
        'path': path, 'session': session, 'chain': chain_of(path) or 'main',
        'kind': 'main' if chain_of(path) is None else 'subagent',
        'cwd': None, 'version': None, 'calls': [], 'results': [], 'prompts': [],
        'events': [], 'links': [], 'preamble': {'skills': None, 'instr': [], 'tool_search_absent': False},
        'first_user_off': None,
    }
    calls: Dict[str, _Call] = {}
    order: List[_Call] = []
    tool_names: Dict[str, str] = {}     # tool_use id -> tool name
    prompt_texts: List[str] = []
    last_assistant_ts: Optional[float] = None
    first_user_seen = False
    try:
        f = open(path, 'rb')
    except OSError:
        return rec_out
    with f:
        off = 0
        for raw_line in f:
            line_off = off
            off += len(raw_line)
            if not raw_line.strip():
                continue
            try:
                rec = json.loads(raw_line)
            except ValueError:
                continue
            if not isinstance(rec, dict):
                continue
            kind = rec.get('type')
            if rec_out['session'] is None and isinstance(rec.get('sessionId'), str):
                rec_out['session'] = rec['sessionId']
            if rec_out['cwd'] is None and isinstance(rec.get('cwd'), str) and rec['cwd']:
                rec_out['cwd'] = rec['cwd']
            ts = _parse_ts(rec.get('timestamp'))
            if rec_out['kind'] == 'main' and rec.get('isSidechain'):
                continue

            if kind == 'attachment':
                _preamble(rec_out, rec.get('attachment'), bool(order))
                continue

            if kind == 'system':
                if rec.get('subtype') == 'compact_boundary':
                    meta = rec.get('compactMetadata') if isinstance(rec.get('compactMetadata'), dict) else {}
                    rec_out['events'].append({'k': 'compaction', 'ts': ts,
                                              'trigger': meta.get('trigger'),
                                              'pre': _int(meta.get('preTokens'))})
                continue

            message = rec.get('message') if isinstance(rec.get('message'), dict) else {}
            content = message.get('content')

            if kind == 'user':
                if not first_user_seen:
                    first_user_seen = True
                    rec_out['first_user_off'] = line_off
                    if (rec_out['kind'] == 'subagent' and isinstance(content, str)
                            and content.lstrip().startswith(TEAMMATE_MARK)):
                        rec_out['kind'] = 'teammate'
                if isinstance(content, list):
                    for b in content:
                        if not isinstance(b, dict):
                            continue
                        if b.get('type') == 'tool_result':
                            text = _result_text(b)
                            tu = b.get('tool_use_id')
                            rec_out['results'].append({
                                'ts': ts, 'tu': tu, 'tool': tool_names.get(tu),
                                'chars': len(text), 'est': round(est_tokens(text)),
                                'err': bool(b.get('is_error')),
                            })
                        elif b.get('type') == 'text' and isinstance(b.get('text'), str) \
                                and b['text'].startswith(INTERRUPT_MARK):
                            rec_out['events'].append({'k': 'interrupt', 'ts': ts,
                                                      'tool': b['text'].startswith(INTERRUPT_TOOL_MARK)})
                elif isinstance(content, str) and content.startswith(INTERRUPT_MARK):
                    rec_out['events'].append({'k': 'interrupt', 'ts': ts,
                                              'tool': content.startswith(INTERRUPT_TOOL_MARK)})
                result = rec.get('toolUseResult')
                if isinstance(result, dict):
                    tu = _tool_use_id(content)
                    agent_id = result.get('agentId') or result.get('agent_id')
                    if result.get('status') == TEAMMATE_SPAWNED:
                        rec_out['events'].append({'k': 'team_start', 'ts': ts, 'tu': tu})
                    if isinstance(agent_id, str) and agent_id:
                        rec_out['links'].append({'tu': tu, 'agent': agent_id, 'ts': ts,
                                                 'status': result.get('status')})
                if rec.get('isMeta') or rec_out['kind'] != 'main':
                    continue
                text, _tools = detail._texts_and_tools(content)
                if not text.strip() or not detail.is_human_prompt(rec, text):
                    continue
                body = prompt_text(text)
                prompt_texts.append(body)
                rec_out['prompts'].append({
                    'uuid': rec.get('uuid'), 'ts': ts, 'off': line_off,
                    'gap': (ts - last_assistant_ts) if ts is not None and last_assistant_ts is not None else None,
                    'est': round(est_tokens(body), 1), 'chars': len(body),
                    'cmd': COMMAND_MARK in text, 'mf': False,
                })
                continue

            if kind != 'assistant':
                continue
            if usage_stats.limit_hit_keys(rec):
                rec_out['events'].append({'k': 'limit_hit', 'ts': ts})
            if message.get('model') == '<synthetic>':
                continue
            msg_id = message.get('id')
            if not isinstance(msg_id, str) or not msg_id:
                msg_id = '@%d' % line_off
            call = calls.get(msg_id)
            if call is None:
                call = _Call(msg_id, ts, line_off)
                calls[msg_id] = call
                order.append(call)
                if rec_out['version'] is None and isinstance(rec.get('version'), str):
                    rec_out['version'] = rec['version']
            if isinstance(message.get('usage'), dict):
                call.usage = message['usage']
            if isinstance(message.get('model'), str):
                call.model = message['model']
            if isinstance(rec.get('effort'), str):
                call.effort = rec['effort']
            if ts is not None:
                last_assistant_ts = ts if last_assistant_ts is None else max(last_assistant_ts, ts)
            if isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    btype = b.get('type')
                    if btype == 'text' and isinstance(b.get('text'), str) and b['text'].strip():
                        call.text_off = line_off
                        call.visible += est_tokens(b['text'])
                    elif btype == 'thinking' and isinstance(b.get('thinking'), str):
                        call.visible += est_tokens(b['thinking'])
                    elif btype == 'tool_use':
                        _add_tool(call, b, line_off, rec_out, tool_names)
    for call in order:
        rec_out['calls'].append(_call_dict(call))
    _mark_file_mentions(rec_out, prompt_texts)
    return rec_out


def _tool_use_id(content) -> Optional[str]:
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get('type') == 'tool_result':
                return b.get('tool_use_id')
    return None


def _preamble(rec_out: dict, att, after_first_call: bool) -> None:
    if not isinstance(att, dict):
        return
    pre = rec_out['preamble']
    atype = att.get('type')
    if atype == 'skill_listing' and att.get('isInitial') and pre['skills'] is None:
        pre['skills'] = _int(att.get('skillCount'))
    elif atype == 'instructions' and not after_first_call and not pre['instr']:
        files = att.get('files')
        for item in files if isinstance(files, list) else []:
            if not isinstance(item, dict):
                continue
            body = item.get('content') if isinstance(item.get('content'), str) else ''
            pre['instr'].append({
                'p': rel_path(item.get('path'), rec_out['cwd']),
                'type': item.get('type') if isinstance(item.get('type'), str) else None,
                'bytes': len(body.encode('utf-8', 'surrogatepass')),
                'lines': body.count('\n') + (1 if body and not body.endswith('\n') else 0),
            })
    elif atype == 'deferred_tools_delta' and att.get('toolSearchAbsent') is True:
        pre['tool_search_absent'] = True


def _add_tool(call: _Call, b: dict, line_off: int, rec_out: dict, tool_names: Dict[str, str]) -> None:
    name = b.get('name') if isinstance(b.get('name'), str) else ''
    inp = b.get('input') if isinstance(b.get('input'), dict) else {}
    tu = b.get('id')
    if isinstance(tu, str):
        tool_names[tu] = name
    k = tool_kind(name)
    target = _tool_target(name, inp)
    entry = {'n': name, 'k': k, 'id': tu, 'off': line_off,
             'p': rel_path(target, rec_out['cwd']),
             'chars': len(json.dumps(inp, ensure_ascii=False))}
    if k == 'exec' and isinstance(inp.get('command'), str):
        entry['c'] = command_key(inp['command'])
    if k == 'search' and isinstance(inp.get('pattern'), str):
        entry['c'] = short_hash(inp['pattern'])
    if k == 'agent' and name in ('Agent', 'Task'):
        entry['model'] = inp.get('model') if isinstance(inp.get('model'), str) else None
    call.tools.append(entry)
    if k == 'edit' and entry['p']:
        for old, new in _edit_pairs(name, inp):
            call.edits.append({'p': entry['p'], 'o': _hash_or_none(old), 'n': _hash_or_none(new)})


def _call_dict(call: _Call) -> dict:
    u = call.usage
    cw = _int(u.get('cache_creation_input_tokens'))
    cc = u.get('cache_creation')
    cw1h = min(_int(cc.get('ephemeral_1h_input_tokens')), cw) if isinstance(cc, dict) else 0
    unc = _int(u.get('input_tokens'))
    details = u.get('output_tokens_details')
    cr = _int(u.get('cache_read_input_tokens'))
    return {
        'id': call.id, 'ts': call.ts, 'model': call.model, 'effort': call.effort,
        'in': unc, 'cr': cr, 'cw': cw, 'cw1h': cw1h, 'out': _int(u.get('output_tokens')),
        'th': _int(details.get('thinking_tokens')) if isinstance(details, dict) else 0,
        'ctx': unc + cr + cw, 'vis': round(call.visible), 'tools': call.tools,
        'edits': call.edits, 'text_off': call.text_off, 'off': call.first_off,
    }


def _mark_file_mentions(rec_out: dict, texts: List[str]) -> None:
    """`mf` on each prompt: whether it names (by base name) a file the agent read or edited
    later in this transcript -- a match against tool targets, not against words."""
    later: List[tuple] = []
    for c in rec_out['calls']:
        for t in c['tools']:
            if t['p'] and t['k'] in ('read', 'edit'):
                base = t['p'].rsplit('/', 1)[-1]
                if len(base) >= 3:
                    later.append((c['ts'] if c['ts'] is not None else float('inf'), base))
    later.sort(key=lambda x: x[0])
    names: set = set()
    i = len(later)
    pairs = sorted(zip(rec_out['prompts'], texts),
                   key=lambda pt: pt[0]['ts'] if pt[0]['ts'] is not None else float('-inf'),
                   reverse=True)
    for prompt, text in pairs:
        ts = prompt['ts'] if prompt['ts'] is not None else float('-inf')
        while i > 0 and later[i - 1][0] >= ts:
            i -= 1
            names.add(later[i][1])
        prompt['mf'] = any(n in text for n in names)


def w_of(call: dict) -> float:
    """Weighted tokens of one call (D-4): cache writes at 1.25 (5 minutes) or 2.0 (1 hour),
    cache reads at 0.1, output at 5."""
    cw5 = call['cw'] - call['cw1h']
    return call['in'] + 1.25 * cw5 + 2.0 * call['cw1h'] + 0.1 * call['cr'] + 5 * call['out']

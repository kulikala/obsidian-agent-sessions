"""Codex rollout -> the same file record `normalize.read_file` makes of a Claude Code transcript.

A call is one API response. Rollouts from Codex 0.156 on write a `token_usage_record` per
response (`usage` is that response's); older ones only `event_msg.token_count`, whose
`info.last_token_usage` is the response's and whose running total repeats on lines that add
nothing (those are skipped). The response items (`reasoning`, `message`, `function_call`,
`custom_tool_call`) come before their usage line, so they are gathered and given to the call the
next usage line closes.

`usage.input_tokens` includes the cached input: the uncached part is `input - cached - write`,
`reasoning_output_tokens` is part of `output_tokens` (kept in `th`, not weighted again).

Tools: `apply_patch` is an edit (its `*** Update File:` / `*** Add File:` / `*** Delete File:`
lines name the files, its `-` and `+` lines are hashed); `exec_command` is read, search or exec
by the program its command starts with (a program name, not a word anyone typed); the `exec` of
Codex's code mode (JavaScript) is exec, or web when it calls `tools.web__…`. Results are sized
from `function_call_output` / `custom_tool_call_output`; an `exec_command` result that reports a
non-zero exit code is an error.

Prompts are the typed messages (`event_msg.user_message`, or `item_completed` with a
`UserMessage`; injected context and bare slash commands are not prompts), at most one per turn
(`task_started`). Compaction is a `compacted` line, an interruption a `turn_aborted` event.
Nothing here keeps text: prompts become lengths, commands a hash of their first two words.
"""

import json
import os
import re
import shlex
from typing import Dict, List, Optional

from ..agents.codex import rollout
from . import normalize

INSTRUCTIONS_PREFIX = '# AGENTS.md instructions for '
READ_PROGRAMS = ('cat', 'sed', 'head', 'tail', 'nl', 'less', 'more', 'bat', 'wc', 'type', 'Get-Content')
SEARCH_PROGRAMS = ('rg', 'grep', 'find', 'fd', 'ls', 'tree', 'git', 'dir', 'Select-String', 'Get-ChildItem')
_PATCH_FILE_RE = re.compile(r'^\*\*\* (?:Update|Add|Delete) File: (.+)$')
_EXIT_RE = re.compile(r'Process exited with code (-?\d+)')
LOCAL_PROVIDERS = ('ollama', 'lmstudio', 'oss')


def _int(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _text(content) -> str:
    """The joined text blocks of a message / output content (a string or a list of blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(b.get('text') or '' for b in content
                         if isinstance(b, dict) and isinstance(b.get('text'), str))
    return ''


def _program(cmd: str) -> List[str]:
    try:
        words = shlex.split(cmd)
    except ValueError:
        words = cmd.split()
    # `bash -lc "…"`: the command inside.
    if len(words) >= 3 and os.path.basename(words[0]) in ('bash', 'sh', 'zsh') and words[1].startswith('-'):
        return _program(words[2])
    return words


def command_kind(cmd: str) -> tuple:
    """`(kind, target)` of a shell command: read / search / exec by its program, and for read
    and search the last argument that looks like a path."""
    words = _program(cmd)
    if not words:
        return 'exec', None
    prog = os.path.basename(words[0])
    kind = 'read' if prog in READ_PROGRAMS else 'search' if prog in SEARCH_PROGRAMS else 'exec'
    if prog == 'git':
        kind = 'search' if len(words) > 1 and words[1] in ('ls-files', 'grep', 'log', 'show', 'diff', 'status') else 'exec'
    target = None
    if kind in ('read', 'search'):
        for w in reversed(words[1:]):
            if w in ('|', '&&', ';'):
                target = None
                continue
            if not w.startswith('-') and ('/' in w or '.' in w):
                target = w
                break
    return kind, target


def patch_edits(patch: str) -> List[tuple]:
    """`[(path, removed lines, added lines)]` of an `apply_patch` body."""
    out: List[list] = []
    for line in patch.splitlines():
        m = _PATCH_FILE_RE.match(line)
        if m:
            out.append([m.group(1).strip(), [], []])
        elif out and line.startswith('-') and not line.startswith('---'):
            out[-1][1].append(line[1:])
        elif out and line.startswith('+') and not line.startswith('+++'):
            out[-1][2].append(line[1:])
    return [(p, '\n'.join(o), '\n'.join(n)) for p, o, n in out]


def _subagent_parent(source) -> Optional[str]:
    """The parent thread of a sub-agent rollout (`source = {"subagent": {"thread_spawn":
    {"parent_thread_id": …}}}`), or `None`."""
    if not isinstance(source, dict):
        return None
    sub = source.get('subagent')
    if isinstance(sub, dict):
        spawn = sub.get('thread_spawn')
        if isinstance(spawn, dict) and isinstance(spawn.get('parent_thread_id'), str):
            return spawn['parent_thread_id']
        return ''
    return None


class _Pending:
    def __init__(self):
        self.tools: List[dict] = []
        self.edits: List[dict] = []
        self.text_off: Optional[int] = None
        self.visible = 0.0
        self.off: Optional[int] = None


def read_file(path: str) -> dict:
    """The file record of one rollout (see the module docstring)."""
    rec_out = {
        'path': path, 'session': rollout.session_id_of(path), 'chain': 'main', 'kind': 'main',
        'agent': 'codex', 'provider': None, 'parent': None, 'cwd': None, 'version': None,
        'calls': [], 'results': [], 'prompts': [], 'events': [], 'links': [],
        'preamble': {'skills': None, 'instr': [], 'tool_search_absent': False},
        'first_user_off': None, 'window': None,
    }
    try:
        with open(path, 'rb') as f:
            data = f.read()
    except OSError:
        return rec_out
    use_records = b'"token_usage_record"' in data
    model = effort = None
    pending = _Pending()
    tool_names: Dict[str, str] = {}
    prompt_texts: List[str] = []
    last_ts: Optional[float] = None
    turn_has_prompt = False
    prev_total = None
    calls: List[dict] = []
    off = 0
    for raw in data.splitlines(keepends=True):
        line_off = off
        off += len(raw)
        if not raw.strip():
            continue
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(d, dict):
            continue
        t = d.get('type')
        p = d.get('payload') if isinstance(d.get('payload'), dict) else {}
        ts = rollout.parse_ts(d.get('timestamp'))

        if t == 'session_meta':
            if rec_out['cwd'] is None and isinstance(p.get('cwd'), str):
                rec_out['cwd'] = p['cwd']
            if isinstance(p.get('id'), str):
                rec_out['session'] = p['id']
            rec_out['version'] = p.get('cli_version') if isinstance(p.get('cli_version'), str) else None
            rec_out['provider'] = p.get('model_provider') if isinstance(p.get('model_provider'), str) else None
            parent = _subagent_parent(p.get('source'))
            if parent is not None:
                rec_out.update(kind='subagent', chain=rec_out['session'], parent=parent or None)
            continue
        if t == 'turn_context':
            model = p.get('model') if isinstance(p.get('model'), str) else model
            eff = p.get('effort')
            if not isinstance(eff, str):
                eff = ((p.get('collaboration_mode') or {}).get('settings') or {}).get('reasoning_effort')
            effort = eff if isinstance(eff, str) else effort
            continue
        if t == 'compacted':
            rec_out['events'].append({'k': 'compaction', 'ts': ts, 'trigger': None, 'pre': 0})
            continue
        if t == 'token_usage_record':
            if use_records and isinstance(p.get('usage'), dict):
                calls.append(_call(p.get('response_id') or '@%d' % line_off, ts, p['usage'],
                                   model, effort, pending, line_off))
                pending = _Pending()
                last_ts = ts if ts is not None else last_ts
            continue
        if t == 'event_msg':
            et = p.get('type')
            if et == 'task_started':
                turn_has_prompt = False
                win = p.get('model_context_window')
                if isinstance(win, int) and win > 0:
                    rec_out['window'] = win
            elif et == 'token_count':
                info = p.get('info') if isinstance(p.get('info'), dict) else {}
                if isinstance(info.get('model_context_window'), int):
                    rec_out['window'] = info['model_context_window']
                if use_records:
                    continue
                total = info.get('total_token_usage')
                last = info.get('last_token_usage')
                if not isinstance(last, dict) or total == prev_total:
                    continue
                prev_total = total
                calls.append(_call('@%d' % line_off, ts, last, model, effort, pending, line_off))
                pending = _Pending()
                last_ts = ts if ts is not None else last_ts
            elif et == 'turn_aborted':
                rec_out['events'].append({'k': 'interrupt', 'ts': ts, 'tool': False})
            elif et in ('user_message', 'item_completed') and not turn_has_prompt:
                if et == 'user_message':
                    text = p.get('message') if isinstance(p.get('message'), str) else ''
                    uid = None
                else:
                    item = p.get('item') if isinstance(p.get('item'), dict) else {}
                    if item.get('type') != 'UserMessage':
                        continue
                    text = _text(item.get('content'))
                    uid = item.get('id')
                if not text.strip() or not rollout.is_real_user_text(text):
                    continue
                turn_has_prompt = True
                if rec_out['first_user_off'] is None:
                    rec_out['first_user_off'] = line_off
                body = text.strip()
                prompt_texts.append(body)
                rec_out['prompts'].append({
                    'uuid': uid or p.get('turn_id') or '@%d' % line_off, 'ts': ts, 'off': line_off,
                    'gap': (ts - last_ts) if ts is not None and last_ts is not None else None,
                    'est': round(normalize.est_tokens(body), 1), 'chars': len(body),
                    'cmd': False, 'mf': False,
                })
            elif et == 'patch_apply_end' and p.get('success') is False:
                for r in rec_out['results']:
                    if r['tu'] == p.get('call_id'):
                        r['err'] = True
            continue
        if t != 'response_item':
            continue
        it = p.get('type')
        if pending.off is None and it in ('message', 'reasoning', 'function_call', 'custom_tool_call'):
            pending.off = line_off
        if it == 'message':
            role = p.get('role')
            text = _text(p.get('content'))
            if role == 'assistant' and text.strip():
                pending.text_off = line_off
                pending.visible += normalize.est_tokens(text)
            elif role == 'user' and text.startswith(INSTRUCTIONS_PREFIX) and not calls:
                folder = text[len(INSTRUCTIONS_PREFIX):].split('\n', 1)[0].strip()
                if not any(i['p'] == normalize.rel_path(os.path.join(folder, 'AGENTS.md'), rec_out['cwd'])
                           for i in rec_out['preamble']['instr']):
                    rec_out['preamble']['instr'].append({
                        'p': normalize.rel_path(os.path.join(folder, 'AGENTS.md'), rec_out['cwd']),
                        'type': 'Project', 'bytes': len(text.encode('utf-8', 'surrogatepass')),
                        'lines': text.count('\n') + 1})
        elif it in ('function_call', 'custom_tool_call'):
            _add_tool(pending, p, line_off, rec_out, tool_names)
        elif it in ('function_call_output', 'custom_tool_call_output'):
            out = p.get('output')
            text = _text(out) if not isinstance(out, dict) else _text(out.get('content') or out.get('output'))
            tu = p.get('call_id')
            m = _EXIT_RE.search(text[:400])
            rec_out['results'].append({
                'ts': ts, 'tu': tu, 'tool': tool_names.get(tu), 'chars': len(text),
                'est': round(normalize.est_tokens(text)), 'err': bool(m and m.group(1) != '0'),
            })
    provider = rec_out['provider'] or 'openai'
    for c in calls:
        c['provider'] = provider
    rec_out['calls'] = calls
    normalize._mark_file_mentions(rec_out, prompt_texts)
    return rec_out


def _call(cid: str, ts, usage: dict, model, effort, pending: _Pending, line_off: int) -> dict:
    total_in = _int(usage.get('input_tokens'))
    cr = min(_int(usage.get('cached_input_tokens')), total_in)
    cw = min(_int(usage.get('cache_write_input_tokens')), total_in - cr)
    return {
        'id': cid, 'ts': ts, 'model': model, 'effort': effort,
        'in': total_in - cr - cw, 'cr': cr, 'cw': cw, 'cw1h': 0,
        'out': _int(usage.get('output_tokens')), 'th': _int(usage.get('reasoning_output_tokens')),
        'ctx': total_in, 'vis': round(pending.visible), 'tools': pending.tools, 'edits': pending.edits,
        'text_off': pending.text_off, 'off': pending.off if pending.off is not None else line_off,
    }


def _add_tool(pending: _Pending, p: dict, line_off: int, rec_out: dict, tool_names: Dict[str, str]) -> None:
    name = p.get('name') if isinstance(p.get('name'), str) else ''
    tu = p.get('call_id')
    if isinstance(tu, str):
        tool_names[tu] = name
    raw = p.get('input') if p.get('type') == 'custom_tool_call' else p.get('arguments')
    raw = raw if isinstance(raw, str) else ''
    args: dict = {}
    if p.get('type') == 'function_call':
        try:
            parsed = json.loads(raw) if raw else {}
            args = parsed if isinstance(parsed, dict) else {}
        except ValueError:
            args = {}
    entry = {'n': name, 'k': 'other', 'id': tu, 'off': line_off, 'p': None, 'chars': len(raw)}
    if name in ('exec_command', 'shell', 'local_shell'):
        cmd = args.get('cmd') if 'cmd' in args else args.get('command')
        if isinstance(cmd, list):
            cmd = ' '.join(str(c) for c in cmd)
        cmd = cmd if isinstance(cmd, str) else ''
        kind, target = command_kind(cmd)
        workdir = args.get('workdir') if isinstance(args.get('workdir'), str) else rec_out['cwd']
        entry['k'] = kind
        entry['c'] = normalize.command_key(cmd)
        if target:
            full = target if os.path.isabs(target) else os.path.join(workdir or '', target)
            entry['p'] = normalize.rel_path(os.path.normpath(full), rec_out['cwd'])
    elif name == 'apply_patch':
        body = raw if p.get('type') == 'custom_tool_call' else (args.get('input') or args.get('patch') or '')
        entry['k'] = 'edit'
        edits = patch_edits(body if isinstance(body, str) else '')
        if edits:
            entry['p'] = normalize.rel_path(_abs(edits[0][0], rec_out['cwd']), rec_out['cwd'])
        for path, old, new in edits:
            rel = normalize.rel_path(_abs(path, rec_out['cwd']), rec_out['cwd'])
            pending.edits.append({'p': rel, 'o': normalize._hash_or_none(old), 'n': normalize._hash_or_none(new)})
    elif name == 'exec':
        entry['k'] = 'web' if 'tools.web__' in raw else 'exec'
        entry['c'] = normalize.short_hash(raw[:200]) if raw else ''
    elif name in ('write_stdin',):
        entry['k'] = 'exec'
    elif name in ('web_search', 'web__run'):
        entry['k'] = 'web'
    elif name in ('spawn_agent', 'send_input', 'wait'):
        entry['k'] = 'agent'
    elif '__' in name or name.startswith('mcp'):
        entry['k'] = 'mcp'
    pending.tools.append(entry)


def _abs(path: str, cwd: Optional[str]) -> str:
    return path if os.path.isabs(path) or not cwd else os.path.normpath(os.path.join(cwd, path))


# ---- Reading text back for the digest --------------------------------------------------------

def read_line(path: str, off) -> Optional[dict]:
    if not isinstance(off, int):
        return None
    try:
        with open(path, 'rb') as f:
            f.seek(off)
            rec = json.loads(f.readline())
    except (OSError, ValueError):
        return None
    return rec if isinstance(rec, dict) else None


def prompt_text(path: str, off) -> str:
    rec = read_line(path, off) or {}
    p = rec.get('payload') if isinstance(rec.get('payload'), dict) else {}
    if p.get('type') == 'user_message':
        return (p.get('message') or '').strip() if isinstance(p.get('message'), str) else ''
    item = p.get('item') if isinstance(p.get('item'), dict) else {}
    return _text(item.get('content')).strip()


def reply_text(path: str, off) -> str:
    rec = read_line(path, off) or {}
    p = rec.get('payload') if isinstance(rec.get('payload'), dict) else {}
    return _text(p.get('content')).strip()


def command_text(path: str, tool: dict) -> Optional[str]:
    if tool.get('k') not in ('exec', 'read', 'search'):
        return None
    rec = read_line(path, tool.get('off')) or {}
    p = rec.get('payload') if isinstance(rec.get('payload'), dict) else {}
    if p.get('call_id') != tool.get('id'):
        return None
    if p.get('type') == 'custom_tool_call':
        return p.get('input') if isinstance(p.get('input'), str) else None
    try:
        args = json.loads(p.get('arguments') or '{}')
    except ValueError:
        return None
    cmd = args.get('cmd') if isinstance(args, dict) else None
    if isinstance(cmd, list):
        cmd = ' '.join(str(c) for c in cmd)
    return cmd if isinstance(cmd, str) else None


def is_local(provider: Optional[str]) -> bool:
    return (provider or '') in LOCAL_PROVIDERS

"""Masked excerpts of the tasks behind the hits (D-9).

For at most `MAX_TASKS` tasks (those with hits that need the model first, then by impact)
this reads back, by byte offset, the lines the file records point at: up to `MAX_PROMPTS`
human prompts per task (the first, the rework candidates and the last first), the start of
each turn's last reply, and the order of tool calls (name, kind, path, the start of a
command, the size of the result -- never the result itself).

Everything that leaves this module goes through `Masker`: secrets, e-mail addresses, the
path part of URLs, and the home folder are replaced; paths inside the vault become
relative to it, other paths keep only their last two parts. These are patterns of formats
(keys, tokens, addresses, paths), not of words. The total is held under `LIMIT` characters
by dropping the tasks with the smallest impact first, then shortening the prompts.
"""

import json
import os
import re
from typing import Dict, List, Optional

from ..sessions import detail
from . import normalize

LIMIT = 60_000
MAX_TASKS = 8
MAX_PROMPTS = 8
PROMPT_CHARS = 600
PROMPT_CHARS_SHORT = 300
REPLY_CHARS = 200
COMMAND_CHARS = 120
MAX_TOOLS = 40

_SECRET_RES = [
    re.compile(r'sk-ant-[A-Za-z0-9_\-]+'),
    re.compile(r'sk-[A-Za-z0-9_\-]{8,}'),
    re.compile(r'gh[po]_[A-Za-z0-9]{8,}'),
    re.compile(r'github_pat_[A-Za-z0-9_]{8,}'),
    re.compile(r'xox[bp]-[A-Za-z0-9\-]+'),
    re.compile(r'AKIA[0-9A-Z]{16}'),
    re.compile(r'eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+'),
    re.compile(r'Bearer\s+\S+'),
    re.compile(r'(?i)\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+'),
    re.compile(r'\b[0-9A-Fa-f]{32,}\b'),
    re.compile(r'(?<![A-Za-z0-9+/_\-])(?=[A-Za-z0-9+/_\-]*[0-9])(?=[A-Za-z0-9+/_\-]*[A-Za-z])'
               r'[A-Za-z0-9+/_\-]{32,}={0,2}'),
]
_URL_RE = re.compile(r'\b([a-zA-Z][a-zA-Z0-9+.\-]*://)([^\s/\'"<>()]+)(/[^\s\'"<>()]*)?')
_EMAIL_RE = re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+')
_PATH_RE = re.compile(r'(?<![\w.~\-/:])~?/(?:[^\s/\'"`<>()\[\]{},;|]+/)*[^\s/\'"`<>()\[\]{},;|]+'
                      r'|\b[A-Za-z]:\\(?:[^\s\\\'"`<>()|]+\\)*[^\s\\\'"`<>()|]*')


class Masker:
    """Masks strings before they are shown to a model (see the module docstring)."""

    def __init__(self, home: Optional[str] = None, vault: Optional[str] = None):
        self.home = (home or os.path.expanduser('~')).rstrip('/\\')
        self.vault = vault.rstrip('/\\') if vault else None

    def path(self, p: Optional[str]) -> Optional[str]:
        if not p:
            return p
        full = p
        if full == '~' or full.startswith('~/'):
            full = self.home + full[1:]
        win = '\\' in full and not full.startswith('/')
        sep = '\\' if win else '/'
        if self.vault and (full == self.vault or full.startswith(self.vault + sep)):
            rel = full[len(self.vault):].lstrip(sep)
            return rel.replace('\\', '/') or '.'
        if full == self.home:
            return '~'
        parts = [x for x in full.split(sep) if x]
        if len(parts) <= 2 and not full.startswith(self.home):
            return full
        return '…/' + '/'.join(parts[-2:])

    def folder(self, cwd: Optional[str]) -> Optional[str]:
        """A session's folder as it is shown to a model: relative inside the vault, its name
        alone outside."""
        if not cwd:
            return cwd
        if self.vault and (cwd == self.vault or cwd.startswith(self.vault + os.sep)):
            return os.path.relpath(cwd, self.vault).replace(os.sep, '/')
        return os.path.basename(cwd.rstrip('/\\'))

    def __call__(self, text: Optional[str]) -> str:
        if not text:
            return ''
        for r in _SECRET_RES:
            text = r.sub('[secret]', text)
        text = _URL_RE.sub(lambda m: m.group(1) + m.group(2) + ('/…' if m.group(3) else ''), text)
        text = _EMAIL_RE.sub('[email]', text)
        text = _PATH_RE.sub(lambda m: self.path(m.group(0)), text)
        if self.home:
            text = text.replace(self.home, '~')
        return text


def read_line(path: str, off: Optional[int]) -> Optional[dict]:
    if off is None:
        return None
    try:
        with open(path, 'rb') as f:
            f.seek(off)
            line = f.readline()
        rec = json.loads(line)
    except (OSError, ValueError):
        return None
    return rec if isinstance(rec, dict) else None


def _prompt_text(rec: Optional[dict]) -> str:
    if not rec:
        return ''
    text, _tools = detail._texts_and_tools((rec.get('message') or {}).get('content'))
    return normalize.prompt_text(text)


def _reply_text(rec: Optional[dict]) -> str:
    if not rec:
        return ''
    text, _tools = detail._texts_and_tools((rec.get('message') or {}).get('content'))
    return text.strip()


class ClaudeTexts:
    """Reads a Claude Code session's prompt, reply and command text back by byte offset. The
    other agents have their own (`sources.py`), with the same three methods."""

    def prompt(self, session: dict, off) -> str:
        return _prompt_text(read_line(session['main']['path'], off))

    def reply(self, session: dict, off) -> str:
        return _reply_text(read_line(session['main']['path'], off))

    def command(self, session: dict, tool: dict) -> Optional[str]:
        return _command(session['main']['path'], tool)


def _command(path: str, tool: dict) -> Optional[str]:
    if tool['k'] != 'exec' or tool.get('off') is None:
        return None
    rec = read_line(path, tool['off'])
    for b in ((rec or {}).get('message') or {}).get('content') or []:
        if isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('id') == tool.get('id'):
            cmd = (b.get('input') or {}).get('command')
            return cmd if isinstance(cmd, str) else None
    return None


def pick_prompts(prompts: List[dict]) -> List[dict]:
    """At most `MAX_PROMPTS`, keeping the first, the rework candidates and the last first."""
    if len(prompts) <= MAX_PROMPTS:
        return prompts
    chosen = [0, len(prompts) - 1] + [i for i, p in enumerate(prompts) if p['rework']]
    keep: List[int] = []
    for i in chosen + list(range(len(prompts))):
        if i not in keep and len(keep) < MAX_PROMPTS:
            keep.append(i)
    return [prompts[i] for i in sorted(keep)]


def task_excerpt(session: dict, task: dict, mask: Masker, impact_w: float, texts=None) -> dict:
    texts = texts or ClaudeTexts()
    prompts = []
    for p in pick_prompts(task['prompts']):
        text = mask(texts.prompt(session, p['off']))[:PROMPT_CHARS]
        prompts.append({'ref': p['ref'], 'text': text, 'rework': p['rework']})
    replies = []
    for t in task['_turns']:
        last = next((c for c in reversed(t['main']) if c.get('text_off') is not None), None)
        ref = next((p['ref'] for p in task['prompts'] if p['turn'] == t['idx']), None)
        if last is None or ref is None:
            continue
        text = mask(texts.reply(session, last['text_off']))[:REPLY_CHARS]
        if text:
            replies.append({'ref': ref.replace('.p', '.r'), 'text': text})
    results = {r['tu']: r for r in session['results']}
    tools = []
    for c in task['_calls']:
        for t in c['tools']:
            if len(tools) >= MAX_TOOLS:
                break
            r = results.get(t.get('id'), {})
            cmd = texts.command(session, t) if c['chain'] == 'main' else None
            entry = {'tool': t['n'], 'kind': t['k'], 'chain': 'main' if c['chain'] == 'main' else 'sub',
                     'path': mask.path(normalize.abs_path(t.get('p'), c.get('cwd'))) if t.get('p') else None,
                     'result_tokens': r.get('est'), 'error': bool(r.get('err'))}
            if cmd:
                entry['cmd'] = mask(cmd)[:COMMAND_CHARS]
            tools.append(entry)
    return {'task': task['id'], 'session': session['id'], 'provider': session.get('provider', 'anthropic'),
            'w': task['w'], 'calls': task['calls'], 'impact_w': round(impact_w),
            'prompts': prompts, 'replies': replies, 'tools': tools}


def size(items: List[dict]) -> int:
    return len(json.dumps(items, ensure_ascii=False))


def build(analysed: List[dict], hits: List[dict], mask: Masker, limit: int = LIMIT, texts=None) -> List[dict]:
    """The excerpts of the range: tasks behind hits, `needs_llm` ones first, largest impact
    next, within `limit` characters."""
    by_task: Dict[str, dict] = {}
    for h in hits:
        if not h.get('task'):
            continue
        entry = by_task.setdefault(h['task'], {'w': 0.0, 'llm': False})
        entry['w'] += h['impact_w']
        entry['llm'] = entry['llm'] or h['needs_llm']
    found = {}
    for a in analysed:
        for t in a['tasks']:
            if t['id'] in by_task and t['in_range']:
                found[t['id']] = (a['session'], t)
    order = sorted(found, key=lambda tid: (not by_task[tid]['llm'], -by_task[tid]['w'], tid))[:MAX_TASKS]
    items = [task_excerpt(found[tid][0], found[tid][1], mask, by_task[tid]['w'], texts) for tid in order]
    while size(items) > limit and len(items) > 1:
        smallest = min(range(len(items)), key=lambda i: (items[i]['impact_w'], i))
        items.pop(smallest)
    if size(items) > limit:
        for it in items:
            for p in it['prompts']:
                p['text'] = p['text'][:PROMPT_CHARS_SHORT]
    while size(items) > limit and items and items[0]['tools']:
        items[0]['tools'].pop()
    return items

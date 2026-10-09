"""Where each agent's sessions come from, for `report.build_for`.

A source lists the sessions written since a time and turns each into a session
(`tasks.assemble` of its main record and its sub-agent records, through the cache), gives the
agent's usage windows, reads prompt / reply / command text back for the digest, and says which
model the analysis of one provider's conversations would use and whether that provider runs on
this machine.

- Claude Code: `~/.claude/projects` transcripts (`normalize.read_file`).
- Codex: `$CODEX_HOME/sessions` rollouts (`codex_read`); a sub-agent rollout joins its parent.
- OpenCode: `opencode.db`, read-only (`opencode_read`); a child session joins its parent.
"""

import os
import re
from typing import Dict, List, Optional, Tuple

from . import cache, codex_read, opencode_read, tasks
from .excerpt import ClaudeTexts

MAX_PARSE_BYTES = 2 << 30


def _limits() -> dict:
    return {'truncated': False, 'reason': None}


def most_used_model(calls: List[dict]) -> Optional[str]:
    counts: Dict[str, int] = {}
    for c in calls:
        if c.get('model'):
            counts[c['model']] = counts.get(c['model'], 0) + 1
    return max(sorted(counts), key=lambda m: counts[m]) if counts else None


class ClaudeSource:
    agent = 'claude'

    def __init__(self, projects_dir: str, status_dir: str, stats_cache_path: str):
        self.projects_dir = projects_dir
        self.status_dir = status_dir
        self.stats_cache_path = stats_cache_path
        self.texts = ClaudeTexts()

    def read(self, now: float, oldest: float, max_sessions: int, reader: cache.Reader) -> Tuple[List[dict], dict]:
        from ..sessions import activity
        limits = _limits()
        out = []
        for path, sid, _mtime in cache.list_sessions(self.projects_dir, oldest):
            if len(out) >= max_sessions:
                limits.update(truncated=True, reason='max_sessions')
                break
            if reader.parsed_bytes > MAX_PARSE_BYTES:
                limits.update(truncated=True, reason='max_bytes')
                break
            main = reader.record(path, session=sid)
            if main is None:
                continue
            # A sub-agent transcript last written before the window can't hold a call in it.
            subs = [r for r in (reader.record(p, session=sid) for p in activity.subagent_files(path)
                                if _file_mtime(p) >= oldest) if r]
            out.append(tasks.assemble(main, subs))
        return out, limits

    def prune(self, folder: Optional[str]) -> None:
        cache.prune(cache.all_transcripts(self.projects_dir), folder=folder)

    def windows(self, now: float) -> Dict[str, dict]:
        from ..usage import stats as usage_stats
        return usage_stats.compute(now=now, projects_dir=self.projects_dir, status_dir=self.status_dir,
                                   cache_path=self.stats_cache_path)['windows']

    def analysis_model(self, provider: str, calls: List[dict]) -> Optional[str]:
        return None             # the "Model for token efficiency" setting, chosen by the plugin

    def is_local(self, provider: str) -> bool:
        return False

    def close(self) -> None:
        pass


def _file_mtime(path: str) -> float:
    try:
        return os.stat(path).st_mtime
    except OSError:
        return 0.0


class _CodexTexts:
    def prompt(self, session: dict, off) -> str:
        return codex_read.prompt_text(session['main']['path'], off)

    def reply(self, session: dict, off) -> str:
        return codex_read.reply_text(session['main']['path'], off)

    def command(self, session: dict, tool: dict) -> Optional[str]:
        return codex_read.command_text(session['main']['path'], tool)


_TOML_KEY_RE = re.compile(r'^\s*(model|model_provider)\s*=\s*"([^"]*)"\s*(#.*)?$')


def codex_config_model(home: str) -> Tuple[Optional[str], Optional[str]]:
    """`(model, model_provider)` set at the top level of `$CODEX_HOME/config.toml` (before its
    first table), `None` for a key it doesn't set."""
    found: Dict[str, str] = {}
    try:
        with open(os.path.join(home, 'config.toml'), 'r', encoding='utf-8') as f:
            for line in f:
                if line.lstrip().startswith('['):
                    break
                m = _TOML_KEY_RE.match(line.rstrip('\n'))
                if m:
                    found[m.group(1)] = m.group(2)
    except OSError:
        pass
    return found.get('model') or None, found.get('model_provider') or None


CODEX_TIERS = ('sol', 'terra', 'luna')
_TIER_RE = re.compile(r'^(.+)-(%s)$' % '|'.join(CODEX_TIERS))


def codex_listed_models(home: str) -> Optional[List[dict]]:
    """The models Codex offers this account, from `$CODEX_HOME/models_cache.json` (what Codex itself
    fetched for the signed-in plan): `[{slug, priority}]` of those shown in its model list, or
    `None` when there is no readable cache."""
    import json
    try:
        with open(os.path.join(home, 'models_cache.json'), 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    models = data.get('models') if isinstance(data, dict) else None
    if not isinstance(models, list):
        return None
    return [{'slug': m['slug'], 'priority': m.get('priority') if isinstance(m.get('priority'), (int, float)) else 1e9}
            for m in models if isinstance(m, dict) and isinstance(m.get('slug'), str)
            and m.get('visibility') == 'list']


def _generation_key(generation: str) -> tuple:
    """Sort key of a generation prefix (`gpt-6`, `gpt-5.6`): its version numbers, newest largest."""
    return tuple(int(n) for n in re.findall(r'\d+', generation))


def codex_tier_models(listed: List[dict]) -> List[str]:
    """The listed Sol, Terra and Luna models: the newest generation first (`gpt-6` before
    `gpt-5.6`), and within a generation Sol, then Terra, then Luna."""
    by_generation: Dict[str, Dict[str, str]] = {}
    for m in listed:
        match = _TIER_RE.match(m['slug'])
        if match:
            by_generation.setdefault(match.group(1), {})[match.group(2)] = m['slug']
    out: List[str] = []
    for generation in sorted(by_generation, key=lambda g: (_generation_key(g), g), reverse=True):
        out += [by_generation[generation][t] for t in CODEX_TIERS if t in by_generation[generation]]
    return out


class CodexSource:
    agent = 'codex'

    def __init__(self, home: Optional[str] = None):
        from ..agents.codex import rollout
        self.home = home or rollout.codex_home()
        self.texts = _CodexTexts()

    def read(self, now: float, oldest: float, max_sessions: int, reader: cache.Reader) -> Tuple[List[dict], dict]:
        from ..agents.codex import rollout
        limits = _limits()
        records = []
        paths = [p for p in rollout.list_transcripts(self.home) if _file_mtime(p) >= oldest]
        paths.sort(key=lambda p: -_file_mtime(p))
        for path in paths:
            if reader.parsed_bytes > MAX_PARSE_BYTES:
                limits.update(truncated=True, reason='max_bytes')
                break
            rec = reader.record(path, load=codex_read.read_file)
            if rec is not None:
                records.append(rec)
        subs: Dict[str, List[dict]] = {}
        mains = []
        for rec in records:
            if rec['kind'] == 'subagent' and rec.get('parent'):
                subs.setdefault(rec['parent'], []).append(dict(rec, session=rec['parent']))
            else:
                mains.append(rec)
        out = []
        for rec in mains:
            if len(out) >= max_sessions:
                limits.update(truncated=True, reason='max_sessions')
                break
            out.append(tasks.assemble(rec, subs.get(rec['session'], [])))
        return out, limits

    def prune(self, folder: Optional[str]) -> None:
        from ..agents.codex import rollout
        cache.prune(rollout.list_transcripts(self.home), folder=folder)

    def windows(self, now: float) -> Dict[str, dict]:
        from ..agents.codex import stats
        try:
            return stats.compute(now=now, home=self.home)['windows']
        except Exception:       # a rollout Codex is writing; the budget rule still applies
            return {}

    def analysis_models(self, provider: str, calls: List[dict]) -> List[str]:
        """The models to try, in order. OpenAI: the Sol, Terra and Luna models Codex lists for this
        account (`models_cache.json`), newest generation first and Sol, Terra, Luna within it, then
        `config.toml`'s model; the plugin
        moves to the next one when Codex says a model isn't available. Without a model cache,
        `config.toml`'s model alone. Another provider (a local one): its most used model in the
        range."""
        model, configured = codex_config_model(self.home)
        if provider != 'openai':
            used = most_used_model(calls)
            return [used] if used else []
        listed = codex_listed_models(self.home)
        out = codex_tier_models(listed) if listed else []
        if model and (configured or 'openai') == provider and model not in out:
            out.append(model)
        return out

    def analysis_model(self, provider: str, calls: List[dict]) -> Optional[str]:
        models = self.analysis_models(provider, calls)
        return models[0] if models else None

    def is_local(self, provider: str) -> bool:
        return codex_read.is_local(provider)

    def close(self) -> None:
        pass


class _OpencodeTexts:
    def __init__(self, source: 'OpencodeSource'):
        self.source = source

    def prompt(self, session: dict, off) -> str:
        d = self.source.db()
        return opencode_read.prompt_text(d, off) if d else ''

    def reply(self, session: dict, off) -> str:
        d = self.source.db()
        return opencode_read.reply_text(d, off) if d else ''

    def command(self, session: dict, tool: dict) -> Optional[str]:
        d = self.source.db()
        return opencode_read.command_text(d, tool) if d else None


class OpencodeSource:
    agent = 'opencode'

    def __init__(self, db_path: Optional[str] = None, home: Optional[str] = None,
                 config_path: Optional[str] = None):
        self.db_path = db_path
        self.home = home
        self.config_path = config_path
        self._db = None
        self._opened = False
        self._ids: List[str] = []
        self.texts = _OpencodeTexts(self)

    def db(self):
        if not self._opened:
            from ..agents.opencode import db as _db
            self._db = _db.open_db(self.db_path)
            self._opened = True
        return self._db

    def read(self, now: float, oldest: float, max_sessions: int, reader: cache.Reader) -> Tuple[List[dict], dict]:
        limits = _limits()
        d = self.db()
        if d is None:
            return [], limits
        rows = opencode_read.list_sessions(d, oldest)
        self._ids = [r['id'] for r in opencode_read.list_sessions(d, 0)]
        records = {}
        for row in rows:
            key = 'opencode:' + row['id']
            records[row['id']] = (row, reader.keyed(key, 0, row['updated'],
                                                   lambda row=row: opencode_read.read_session(d, row, self.home)))
        subs: Dict[str, List[dict]] = {}
        out = []
        for sid, (row, rec) in records.items():
            if row['parent']:
                subs.setdefault(row['parent'], []).append(rec)
        for sid, (row, rec) in records.items():
            if row['parent']:
                continue
            if len(out) >= max_sessions:
                limits.update(truncated=True, reason='max_sessions')
                break
            out.append(tasks.assemble(rec, subs.get(sid, [])))
        return out, limits

    def prune(self, folder: Optional[str]) -> None:
        if self.db() is not None:
            cache.prune(['opencode:' + i for i in self._ids], folder=folder)

    def windows(self, now: float) -> Dict[str, dict]:
        return {}

    def analysis_model(self, provider: str, calls: List[dict]) -> Optional[str]:
        return most_used_model(calls)

    def is_local(self, provider: str) -> bool:
        return provider in opencode_read.local_providers(self.config_path)

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None


def provider_of(session: dict) -> str:
    return session.get('provider') or tasks.DEFAULT_PROVIDER.get(session.get('agent') or 'claude', 'anthropic')


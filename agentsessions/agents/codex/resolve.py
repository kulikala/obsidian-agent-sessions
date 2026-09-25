"""Resolving a freshly-started daemon session (an opaque uuid the plugin picked)
to its real Codex thread id.

Codex has no flag letting the caller choose its own session id, so the plugin
starts it under a daemon-assigned uuid (like every other agent) and asks here,
possibly more than once (a rollout file doesn't exist until Codex's first
write), to learn what thread id it turned out to be. See
plan/段9-Codex対応.md's "Codex には新規セッションの id を呼び出し側が決めるフラグが
無い" note.

Two strategies, tried in order:
1. **Open-fd inspection**: `pid` (the daemon's child -- Codex's own pid) or one
   of its descendants (in case Codex re-execs or forks a wrapper before opening
   its rollout, which team-lead flagged as sometimes happening) has the rollout
   file open right now. macOS: `lsof -a -p <pid> -Fn`. Linux: `/proc/<pid>/fd/*`.
   Exact when it works -- no ambiguity, no clock dependency.
2. **`session_meta` fallback**: the newest rollout whose `session_meta.timestamp
   >= since`, `cwd` matches, `source == 'cli'`, and whose thread id isn't
   already linked to a *different* daemon session (`already_linked`, read from
   `sessions.json`'s existing thread links by the caller). Used when step 1
   can't find an open fd (lsof/proc unavailable, or Codex hadn't opened the file
   at the moment this was called).

Neither is exact -- `session_meta.timestamp` is Codex's own clock, and nothing
prevents a race between two `codex` sessions started in the same cwd within
`since`'s window. `resolve()` returns `(None, None)`, never an exception, when
it can't confidently identify one; the caller (the plugin) is expected to retry
once the rollout has had time to appear.
"""
import os
import re
import shutil
import subprocess
from typing import Dict, List, Optional, Set, Tuple

from . import rollout

# A rollout's path always ends .../sessions/YYYY/MM/DD/rollout-....jsonl (see
# rollout.py's docstring) -- matched loosely (not against rollout.SESSION_ID_RE)
# since this only needs to recognize the *shape*, not extract the id (that's
# `rollout.session_id_of`, applied by the caller once a path is found).
_ROLLOUT_PATH_RE = re.compile(r'/sessions/\d{4}/\d\d/\d\d/rollout-.*\.jsonl$')


# ---- Strategy 1: open-fd inspection ----------------------------------------

def child_pids(root_pid: int, all_procs: List[Tuple[int, int]]) -> List[int]:
    """`all_procs` is `[(pid, ppid), ...]` (as `ps -eo pid=,ppid=` gives). Every
    descendant of `root_pid`, root included. Pure -- the caller supplies the
    process table, so this is testable without `ps`."""
    children: Dict[int, List[int]] = {}
    for pid, ppid in all_procs:
        children.setdefault(ppid, []).append(pid)
    out = [root_pid]
    frontier = [root_pid]
    while frontier:
        pid = frontier.pop()
        for c in children.get(pid, []):
            if c not in out:
                out.append(c)
                frontier.append(c)
    return out


def _ps_tree() -> List[Tuple[int, int]]:
    ps = shutil.which('ps') or 'ps'
    try:
        out = subprocess.run([ps, '-eo', 'pid=,ppid='], stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=5).stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.SubprocessError):
        return []
    procs = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            procs.append((int(parts[0]), int(parts[1])))
    return procs


def parse_lsof_fn(text: str) -> List[str]:
    """Parses `lsof -Fn`'s output (`p<pid>`/`f<fd>`/`n<name>` lines, one field per
    line) into every `n`-prefixed absolute path. Pure -- testable against a
    captured sample without running `lsof`."""
    return [line[1:] for line in text.splitlines() if line.startswith('n/')]


def _open_paths_macos(pid: int) -> List[str]:
    lsof = shutil.which('lsof')
    if not lsof:
        return []
    try:
        out = subprocess.run([lsof, '-a', '-p', str(pid), '-Fn'], stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=5).stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.SubprocessError):
        return []
    return parse_lsof_fn(out)


def _open_paths_linux(pid: int) -> List[str]:
    fd_dir = '/proc/%d/fd' % pid
    try:
        names = os.listdir(fd_dir)
    except OSError:
        return []
    out = []
    for name in names:
        try:
            target = os.readlink(os.path.join(fd_dir, name))
        except OSError:
            continue
        if target.startswith('/'):
            out.append(target)
    return out


def _open_paths(pid: int) -> List[str]:
    """Tries `/proc` first (Linux), then `lsof` (macOS) -- each is a no-op
    (empty list) on the platform/tool it doesn't apply to, so this needs no
    explicit platform check."""
    return _open_paths_linux(pid) or _open_paths_macos(pid)


def rollout_open_by(pid: int) -> Optional[str]:
    """The rollout path open by `pid` or one of its descendants, if any."""
    for p in child_pids(pid, _ps_tree()):
        for path in _open_paths(p):
            if _ROLLOUT_PATH_RE.search(path):
                return path
    return None


# ---- Strategy 2: session_meta fallback -------------------------------------

def pick_fallback(candidates: List[Tuple[str, str, Optional[float], str, str]],
                   since: float, cwd: str, already_linked: Set[str]) -> Optional[Tuple[str, str]]:
    """`candidates` is `[(thread_id, path, session_meta_ts, cwd, source), ...]`.
    Returns `(thread_id, path)` for the newest one matching `since`/`cwd`/
    `source == 'cli'` and not in `already_linked`, or `None`. Pure -- the caller
    reads the rollouts and sessions.json's existing links; this just picks."""
    best = None
    best_ts = -1.0
    for thread_id, path, ts, candidate_cwd, source in candidates:
        if thread_id in already_linked or source != 'cli' or candidate_cwd != cwd:
            continue
        if ts is None or ts < since:
            continue
        if ts > best_ts:
            best_ts = ts
            best = (thread_id, path)
    return best


def _session_meta(path: str) -> Tuple[Optional[float], str, str]:
    """`(timestamp, cwd, source)` from `path`'s first line (`session_meta` is
    always first -- see rollout.py's docstring); `(None, '', '')` if it isn't.
    `timestamp` is the outer record's (not `payload.timestamp`, which real data
    has too but which every other reader in this package -- `rollout.py`,
    `live.py` -- also takes from the outer record, for consistency)."""
    for rec in rollout.iter_records(path):
        if rec.get('type') != 'session_meta':
            return None, '', ''
        ts = rollout.parse_ts(rec.get('timestamp'))
        payload = rec.get('payload') or {}
        cwd = payload.get('cwd') if isinstance(payload.get('cwd'), str) else ''
        source = payload.get('source') if isinstance(payload.get('source'), str) else ''
        return ts, cwd, source
    return None, '', ''


# ---- Entry point -------------------------------------------------------------

def resolve(pid: int, since: float, cwd: str, home: Optional[str] = None,
            already_linked: Optional[Set[str]] = None) -> Tuple[Optional[str], Optional[str]]:
    """`(thread_id, transcript_path)`, or `(None, None)` if neither strategy
    finds a confident match (the rollout may simply not exist yet -- the caller
    should retry)."""
    home = home if home is not None else rollout.codex_home()

    path = rollout_open_by(pid)
    if path:
        sid = rollout.session_id_of(path)
        if sid:
            return sid, path

    candidates = []
    for p in rollout.list_transcripts(home):
        sid = rollout.session_id_of(p)
        if not sid:
            continue
        ts, meta_cwd, source = _session_meta(p)
        candidates.append((sid, p, ts, meta_cwd, source))
    picked = pick_fallback(candidates, since, cwd, already_linked or set())
    return picked if picked else (None, None)

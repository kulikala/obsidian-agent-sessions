import glob
import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from .model import Session

# If mtime is newer than this, don't trust a cached mtime/size match (see scan() below).
RACY_WINDOW = 2.0

# Bumped whenever this module's extraction logic changes in a way that would
# make an old cache entry's `head` wrong (a new field read out of the
# transcript, a changed filtering rule, ...). A cache entry whose
# `schema_version` doesn't match is never trusted, regardless of mtime/size,
# so upgrading agent-sessions itself can't leave stale extracted data sitting
# in scan-cache.json forever (see agents/codex/scan.py's SCAN_SCHEMA_VERSION
# for the same mechanism on the codex side, versioned independently).
SCAN_SCHEMA_VERSION = 4

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
TITLE_PATTERN = '^{"type": *"custom-title"'      # grep (BRE)
TITLE_PATTERN_RG = r'^\{"type": ?"custom-title"'  # ripgrep / Python re (also valid BRE)
_TITLE_RE = re.compile(TITLE_PATTERN_RG)
# Claude Code's `/goal` records (always an attachment line, never at the start of the line).
GOAL_PATTERN = '"attachment":{"type":"goal_status"'       # grep (BRE)
GOAL_PATTERN_RG = r'"attachment":\{"type":"goal_status"'  # ripgrep / Python re
_GOAL_MARK = '"attachment":{"type":"goal_status"'
GOAL_REASON_CHARS = 1000   # the evaluator's reason is cut to this many characters
HEAD_LIMIT = 2000   # max number of lines to scan for the first user message
TAIL_CHUNK = 1 << 16   # unit size for reading from the end of the file
TAIL_LIMIT = 1 << 24   # max bytes to scan backward from the end (fall back to mtime beyond this)
_TS_RE = re.compile(rb'"timestamp":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z"')
# Openings of a user line that records a local command or a `!` shell command rather than
# something sent to the model: the command itself (`<command-name>`, also on a slash command
# that does run a model turn -- that one is told apart by the assistant lines after it) and
# its caveat and output.
_LOCAL_INPUT_PREFIXES = ('<command-name>', '<command-message>', '<local-command-', '<bash-input>',
                         '<bash-stdout>', '<bash-stderr>')


def session_id_of(path: str) -> str:
    return os.path.splitext(os.path.basename(path))[0]


def list_transcripts(projects_dir: str) -> List[str]:
    paths = glob.glob(os.path.join(projects_dir, '*', '*.jsonl'))
    return sorted(p for p in paths if UUID_RE.match(session_id_of(p)))


def _title_grep_cmd() -> Optional[List[str]]:
    """`rg`/`grep` invocation for `scan_names_and_goals` (custom-title and goal_status lines), found via PATH — never a hard-coded
    path, since not every environment has `grep` at `/usr/bin/grep` (or has `grep` at
    all). `None` if neither is available; the caller falls back to reading the files
    directly in that case."""
    rg = shutil.which('rg')
    if rg:
        return [rg, '-N', '-H', '--no-heading', '--no-config',
                '-e', TITLE_PATTERN_RG, '-e', GOAL_PATTERN_RG, '--']
    grep = shutil.which('grep')
    if grep:
        return [grep, '-H', '-e', TITLE_PATTERN, '-e', GOAL_PATTERN, '--']
    return None


def _iso_ts(value) -> Optional[float]:
    if not isinstance(value, str) or not value.endswith('Z'):
        return None
    ts = value[:-1]
    fmt = '%Y-%m-%dT%H:%M:%S.%f' if '.' in ts else '%Y-%m-%dT%H:%M:%S'
    try:
        return datetime.strptime(ts, fmt).replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def apply_goal_status(goal: Optional[dict], rec: dict) -> Optional[dict]:
    """Folds one `goal_status` attachment line into the session's goal so far, the way Claude
    Code itself reads them (the latest one decides):

    - `sentinel` + `met: false`: `/goal <condition>` set it (re-sent unchanged on resume and
      after compaction, which keeps `since`);
    - `sentinel` + `met: true`: `/goal clear` (also `stop`/`off`/`reset`/`none`/`cancel`) → None;
    - `met: false` with a `reason`: the evaluator ran after a turn and found it not met yet;
    - `met: true`: the evaluator found it met (Claude Code removes the goal itself);
    - `failed: true`: the evaluator judged it impossible (also removes the goal).

    A new `/goal` while one is active simply comes next, so the newest condition wins.
    Returns `{condition, met, reason, since, updated}` (+ `failed: True`), times in epoch seconds."""
    a = rec.get('attachment')
    if not isinstance(a, dict) or a.get('type') != 'goal_status':
        return goal
    condition = a.get('condition')
    if not isinstance(condition, str) or not condition:
        return goal
    ts = _iso_ts(rec.get('timestamp'))
    same = goal is not None and goal['condition'] == condition
    if a.get('sentinel'):
        if a.get('met'):
            return None
        if same and not goal['met'] and not goal.get('failed'):
            return dict(goal, updated=ts or goal['updated'])
        return {'condition': condition, 'met': False, 'reason': None, 'since': ts, 'updated': ts}
    reason = a.get('reason')
    reason = reason[:GOAL_REASON_CHARS] if isinstance(reason, str) and reason else None
    out = {'condition': condition, 'met': bool(a.get('met')) and not a.get('failed'), 'reason': reason,
           'since': goal['since'] if same else ts, 'updated': ts}
    if a.get('failed'):
        out['failed'] = True
    return out


def _fold_line(names: Dict[str, str], goals: Dict[str, Optional[dict]], sid: str, d) -> None:
    if not isinstance(d, dict):
        return
    if d.get('type') == 'custom-title':
        title = d.get('customTitle')
        if title:
            names[sid] = title
    elif d.get('type') == 'attachment':
        goals[sid] = apply_goal_status(goals.get(sid), d)


def _scan_names_python(paths: List[str]) -> Tuple[Dict[str, str], Dict[str, Optional[dict]]]:
    """Pure-Python fallback for `scan_names_and_goals` when neither `rg` nor `grep` is on PATH."""
    names: Dict[str, str] = {}
    goals: Dict[str, Optional[dict]] = {}
    for p in paths:
        try:
            with open(p, encoding='utf-8', errors='replace') as f:
                for line in f:
                    if not _TITLE_RE.match(line) and _GOAL_MARK not in line:
                        continue
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    _fold_line(names, goals, session_id_of(p), d)
        except OSError:
            continue
    return names, goals


def scan_names_and_goals(paths: List[str]) -> Tuple[Dict[str, str], Dict[str, Optional[dict]]]:
    """(id -> current name, id -> current `/goal` or None), from one `rg`/`grep` pass over the
    transcripts' custom-title and goal_status lines. If the same ID has multiple lines, the later
    one wins (goals: see `apply_goal_status`)."""
    if not paths:
        return {}, {}
    cmd = _title_grep_cmd()
    if cmd is None:
        return _scan_names_python(paths)
    r = subprocess.run(cmd + list(paths), capture_output=True, text=True)
    names: Dict[str, str] = {}
    goals: Dict[str, Optional[dict]] = {}
    for line in r.stdout.splitlines():
        path, sep, body = line.partition(':{')
        if not sep:
            continue
        try:
            d = json.loads('{' + body)
        except ValueError:
            continue
        _fold_line(names, goals, session_id_of(path), d)
    return names, goals


def scan_names(paths: List[str]) -> Dict[str, str]:
    """id -> current name. If the same ID has multiple lines, the later one wins."""
    return scan_names_and_goals(paths)[0]


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get('type') == 'text' and block.get('text'):
                return block['text']
    return ''


@dataclass
class Head:
    cwd: str = ''
    prompt: str = ''
    child: bool = False      # whether this transcript was started by a sub-agent (headless)


def read_head_info(path: str) -> Head:
    """Read the head of the file and return the cwd, first user message, and child status together.

    `child` is True when there's an `agent-setting` line (a skill agent), when the first
    `entrypoint` seen is anything other than 'cli' (a headless SDK launch), or when
    `sessionKind` is 'bg' (a background launch, where entrypoint stays 'cli').
    """
    h = Head()
    entrypoint_seen = False
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for n, line in enumerate(f):
            if n >= HEAD_LIMIT or (h.cwd and h.prompt):
                break
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if not isinstance(d, dict):
                continue
            if d.get('type') == 'agent-setting' or d.get('sessionKind') == 'bg':
                h.child = True
            if not entrypoint_seen and d.get('entrypoint') is not None:
                entrypoint_seen = True
                h.child = h.child or (d.get('entrypoint') != 'cli')
            if not h.cwd and d.get('cwd'):
                h.cwd = d['cwd']
            if not h.prompt and d.get('type') == 'user' and not d.get('isMeta'):
                text = _text_of((d.get('message') or {}).get('content'))
                text = text.strip().splitlines()[0].strip() if text.strip() else ''
                if text and not text.startswith('<'):
                    h.prompt = text
    return h


def read_head(path: str) -> Tuple[str, str]:
    """(cwd, first line of the first user message). Empty string if not found."""
    h = read_head_info(path)
    return h.cwd, h.prompt


def _activity_ts(line: bytes) -> Optional[float]:
    """If the line is a user message or an assistant response, return its timestamp as epoch seconds.

    Excludes "mere status update" lines like hooks, cost-state, or last-prompt.
    Also excludes user lines that are just tool results, isMeta lines, and sidechains.
    """
    if b'"timestamp"' not in line:
        return None
    if b'"type":"user"' not in line and b'"type":"assistant"' not in line:
        return None
    m = _TS_RE.search(line)
    if not m:
        return None
    try:
        d = json.loads(line)
    except ValueError:
        return None
    if not isinstance(d, dict) or d.get('isSidechain'):
        return None
    if d.get('type') == 'user':
        if d.get('isMeta'):
            return None
        if not _text_of((d.get('message') or {}).get('content')):
            return None
    elif d.get('type') != 'assistant':
        return None
    ts = m.group(1).decode()
    fmt = '%Y-%m-%dT%H:%M:%S.%f' if '.' in ts else '%Y-%m-%dT%H:%M:%S'
    try:
        return datetime.strptime(ts, fmt).replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def iter_tail_lines(path: str, chunk: int = TAIL_CHUNK, limit: int = TAIL_LIMIT):
    """Yield lines one at a time (bytes, no newline) walking backward from the end, up to `limit` bytes."""
    with open(path, 'rb') as f:
        f.seek(0, os.SEEK_END)
        pos = f.tell()
        buf = b''
        read = 0
        while pos > 0 and read < limit:
            step = min(chunk, pos)
            pos -= step
            f.seek(pos)
            buf = f.read(step) + buf
            read += step
            lines = buf.split(b'\n')
            complete = lines if pos == 0 else lines[1:]
            for line in reversed(complete):
                yield line
            buf = lines[0] if pos > 0 else b''


def read_last_activity(path: str, chunk: int = TAIL_CHUNK, limit: int = TAIL_LIMIT) -> Optional[float]:
    """Walk backward from the end and return the time of the last user message /
    assistant response (epoch seconds).

    Returns None if not found (the caller then falls back to mtime).
    """
    for line in iter_tail_lines(path, chunk, limit):
        t = _activity_ts(line)
        if t is not None:
            return t
    return None


def read_after_compact(path: str, chunk: int = TAIL_CHUNK, limit: int = TAIL_LIMIT) -> Optional[str]:
    """What has happened since the transcript's last compaction, walking backward from the end.

    `'clean'`: nothing but local commands since (`/rename`, `/model`, `/reload-plugins`, `!`
    shell commands, ... -- recorded as `system`/`local_command` lines, or user lines opening
    with `<command-name>`, `<local-command-...>` or `<bash-...>`) and machine lines (`isMeta`,
    the compaction summary, attachments, titles). `'input'`: a user line that reads as a
    prompt, but no reply from the model yet. `None`: the model has replied since (an
    assistant line or a tool result), or there's no compaction within `limit` bytes.
    """
    seen_input = False
    for line in iter_tail_lines(path, chunk, limit):
        if b'"type":"assistant"' not in line and b'"type":"user"' not in line \
                and b'compact_boundary' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if not isinstance(d, dict) or d.get('isSidechain'):
            continue
        kind = d.get('type')
        if kind == 'system' and d.get('subtype') == 'compact_boundary':
            return 'input' if seen_input else 'clean'
        if kind == 'assistant':
            return None
        if kind != 'user' or d.get('isMeta') or d.get('isCompactSummary'):
            continue
        content = (d.get('message') or {}).get('content')
        if isinstance(content, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result'
                                             for b in content):
            return None
        text = _text_of(content).lstrip()
        if text and not text.startswith(_LOCAL_INPUT_PREFIXES):
            seen_input = True
    return None


def scan(paths: List[str], cache: Optional[Dict[str, dict]] = None) -> Dict[str, Session]:
    """If `cache` is passed, look up `path -> previous result` (mtime, size, head,
    last_activity); if it matches, reuse it instead of calling `read_head_info` /
    `read_last_activity` / `read_after_compact`. `cache` is updated in place (not written to disk until the
    caller calls `cache.save`).

    Files whose mtime is within `RACY_WINDOW` seconds of now aren't trusted from the
    cache: two rewrites within the same clock tick (same size if the content length is
    unchanged) can be indistinguishable by mtime alone, depending on clock granularity
    (this shows up notably on tmpfs and in some container environments)."""
    names, goals = scan_names_and_goals(paths)
    now = time.time()
    out: Dict[str, Session] = {}
    for p in paths:
        sid = session_id_of(p)
        try:
            st = os.stat(p)
            cached = cache.get(p) if cache is not None else None
            racy = (now - st.st_mtime) < RACY_WINDOW
            if cached and not racy and cached.get('mtime') == st.st_mtime and cached.get('size') == st.st_size \
                    and cached.get('schema_version') == SCAN_SCHEMA_VERSION:
                head = cached.get('head') or {}
                h = Head(cwd=head.get('cwd', ''), prompt=head.get('prompt', ''),
                         child=bool(head.get('child')))
                last_activity = cached.get('last_activity')
                last_human = cached.get('last_human_prompt')
                after_compact = cached.get('after_compact')
                sched_state = cached.get('schedule_state')
            else:
                from .detail import read_last_human_prompt_ts   # detail imports this module
                from . import schedule as schedule_mod
                last_activity = read_last_activity(p)
                last_human = read_last_human_prompt_ts(p)
                after_compact = read_after_compact(p)
                prior = cached.get('schedule_state') if cached and cached.get('schema_version') == SCAN_SCHEMA_VERSION else None
                sched_state = schedule_mod.fold(p, prior)
                h = read_head_info(p)
                if cache is not None:
                    cache[p] = {
                        'mtime': st.st_mtime,
                        'size': st.st_size,
                        'schema_version': SCAN_SCHEMA_VERSION,
                        'head': {'cwd': h.cwd, 'prompt': h.prompt, 'child': h.child},
                        'last_activity': last_activity,
                        'last_human_prompt': last_human,
                        'after_compact': after_compact,
                        'schedule_state': sched_state,
                    }
            mtime = last_activity or st.st_mtime
        except OSError:
            continue
        name = names.get(sid)
        if not name and not h.prompt:
            continue
        goal = goals.get(sid)
        if goal and (goal['met'] or goal.get('failed')) and last_human and last_human > (goal['updated'] or 0):
            goal = None   # the next task has begun: a verdict mark lasts until the next human prompt
        from .schedule import summarize
        out[sid] = Session(id=sid, name=name, cwd=h.cwd, mtime=mtime, path=p,
                            first_prompt=h.prompt, child=h.child, goal=goal,
                            after_compact=after_compact, schedule=summarize(sched_state),
                            scheduled_turn=bool((sched_state or {}).get('scheduled_turn')))
    return out

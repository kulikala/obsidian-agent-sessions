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

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
TITLE_PATTERN = '^{"type": *"custom-title"'      # grep (BRE)
TITLE_PATTERN_RG = r'^\{"type": ?"custom-title"'  # ripgrep
HEAD_LIMIT = 2000   # max number of lines to scan for the first user message
TAIL_CHUNK = 1 << 16   # unit size for reading from the end of the file
TAIL_LIMIT = 1 << 24   # max bytes to scan backward from the end (fall back to mtime beyond this)
_TS_RE = re.compile(rb'"timestamp":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z"')


def session_id_of(path: str) -> str:
    return os.path.splitext(os.path.basename(path))[0]


def list_transcripts(projects_dir: str) -> List[str]:
    paths = glob.glob(os.path.join(projects_dir, '*', '*.jsonl'))
    return sorted(p for p in paths if UUID_RE.match(session_id_of(p)))


def _title_grep_cmd() -> List[str]:
    rg = shutil.which('rg')
    if rg:
        return [rg, '-N', '-H', '--no-heading', '--no-config', TITLE_PATTERN_RG, '--']
    return ['/usr/bin/grep', '-H', TITLE_PATTERN, '--']


def scan_names(paths: List[str]) -> Dict[str, str]:
    """id -> current name. If the same ID has multiple lines, the later one wins."""
    if not paths:
        return {}
    r = subprocess.run(_title_grep_cmd() + list(paths),
                       capture_output=True, text=True)
    names: Dict[str, str] = {}
    for line in r.stdout.splitlines():
        path, sep, body = line.partition(':{')
        if not sep:
            continue
        try:
            d = json.loads('{' + body)
        except ValueError:
            continue
        title = d.get('customTitle')
        if title:
            names[session_id_of(path)] = title
    return names


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


def scan(paths: List[str], cache: Optional[Dict[str, dict]] = None) -> Dict[str, Session]:
    """If `cache` is passed, look up `path -> previous result` (mtime, size, head,
    last_activity); if it matches, reuse it instead of calling `read_head_info` /
    `read_last_activity`. `cache` is updated in place (not written to disk until the
    caller calls `cache.save`).

    Files whose mtime is within `RACY_WINDOW` seconds of now aren't trusted from the
    cache: two rewrites within the same clock tick (same size if the content length is
    unchanged) can be indistinguishable by mtime alone, depending on clock granularity
    (this shows up notably on tmpfs and in some container environments)."""
    names = scan_names(paths)
    now = time.time()
    out: Dict[str, Session] = {}
    for p in paths:
        sid = session_id_of(p)
        try:
            st = os.stat(p)
            cached = cache.get(p) if cache is not None else None
            racy = (now - st.st_mtime) < RACY_WINDOW
            if cached and not racy and cached.get('mtime') == st.st_mtime and cached.get('size') == st.st_size:
                head = cached.get('head') or {}
                h = Head(cwd=head.get('cwd', ''), prompt=head.get('prompt', ''),
                         child=bool(head.get('child')))
                last_activity = cached.get('last_activity')
            else:
                last_activity = read_last_activity(p)
                h = read_head_info(p)
                if cache is not None:
                    cache[p] = {
                        'mtime': st.st_mtime,
                        'size': st.st_size,
                        'head': {'cwd': h.cwd, 'prompt': h.prompt, 'child': h.child},
                        'last_activity': last_activity,
                    }
            mtime = last_activity or st.st_mtime
        except OSError:
            continue
        name = names.get(sid)
        if not name and not h.prompt:
            continue
        out[sid] = Session(id=sid, name=name, cwd=h.cwd, mtime=mtime, path=p,
                            first_prompt=h.prompt, child=h.child)
    return out

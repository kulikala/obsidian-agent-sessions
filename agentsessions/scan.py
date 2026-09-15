import glob
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from .model import Session

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
TITLE_PATTERN = '^{"type": *"custom-title"'      # grep (BRE)
TITLE_PATTERN_RG = r'^\{"type": ?"custom-title"'  # ripgrep
HEAD_LIMIT = 2000   # 最初の発言を探す行数の上限
TAIL_CHUNK = 1 << 16   # 末尾から読む単位
TAIL_LIMIT = 1 << 24   # 末尾から遡る上限（これを超えたら mtime に戻す）
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
    """id -> 現在の名前。同じ ID に複数行あれば後の行が勝つ。"""
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
    child: bool = False      # sub-agent（headless）が開始した transcript か


def read_head_info(path: str) -> Head:
    """先頭を読み、cwd・最初のユーザー発言・child 判定をまとめて返す。

    child は `agent-setting` 行（skill agent）か、最初に現れる `entrypoint` が
    'cli' 以外（headless SDK 起動）か、`sessionKind` が 'bg'（バックグラウンド起動。
    entrypoint は cli のまま）のとき True。
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
    """(cwd, 最初のユーザー発言の1行目)。見つからなければ ''。"""
    h = read_head_info(path)
    return h.cwd, h.prompt


def _activity_ts(line: bytes) -> Optional[float]:
    """ユーザー発言か assistant 応答の行なら、その timestamp を epoch 秒で返す。

    フック・cost-state・last-prompt などの「ただの更新通知」は対象外。
    ツール結果だけの user 行、isMeta、サイドチェーンも数えない。
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
    """末尾から 1 行ずつ（bytes、改行なし）遡って返す。limit バイトまで。"""
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
    """末尾から遡り、最後のユーザー発言／assistant 応答の時刻（epoch 秒）を返す。

    見つからなければ None（呼び出し側が mtime に戻す）。
    """
    for line in iter_tail_lines(path, chunk, limit):
        t = _activity_ts(line)
        if t is not None:
            return t
    return None


def scan(paths: List[str]) -> Dict[str, Session]:
    names = scan_names(paths)
    out: Dict[str, Session] = {}
    for p in paths:
        sid = session_id_of(p)
        try:
            mtime = read_last_activity(p) or os.stat(p).st_mtime
            h = read_head_info(p)
        except OSError:
            continue
        name = names.get(sid)
        if not name and not h.prompt:
            continue
        out[sid] = Session(id=sid, name=name, cwd=h.cwd, mtime=mtime, path=p,
                            first_prompt=h.prompt, child=h.child)
    return out

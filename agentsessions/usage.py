"""transcript のターン別トークン集計（D-30）。

`assistant` 行の `message.usage` を `message.id` で重複排除して数える。
`isSidechain`・`isMeta` の行は読み飛ばす（`detail.read_detail` と同じ）。
`user` 行のうち `detail.is_human_prompt` が真のものでターンを切る。
最初の指示より前に出た usage は「（開始前）」の 1 ターンにまとめる。
`message.model` が `<synthetic>` の行は数えない。
"""

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

from . import detail

BEFORE_LABEL = '（開始前）'
PROMPT_HEAD_LEN = 60


@dataclass
class Turn:
    index: int
    ts: Optional[float]
    prompt: str
    calls: int = 0
    input: int = 0
    cache_create: int = 0
    cache_read: int = 0
    output: int = 0
    thinking: int = 0
    models: Dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            'index': self.index,
            'ts': self.ts,
            'prompt': self.prompt,
            'calls': self.calls,
            'input': self.input,
            'cache_create': self.cache_create,
            'cache_read': self.cache_read,
            'output': self.output,
            'thinking': self.thinking,
            'models': dict(self.models),
        }


def _int(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _parse_ts(value) -> Optional[float]:
    """transcript の `timestamp`（`…Z` の ISO8601・UTC）を epoch 秒にする。"""
    if not isinstance(value, str) or not value.endswith('Z'):
        return None
    raw = value[:-1]
    fmt = '%Y-%m-%dT%H:%M:%S.%f' if '.' in raw else '%Y-%m-%dT%H:%M:%S'
    try:
        return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def collect(path: str) -> List[dict]:
    """`path` の transcript を先頭から読み、ターンごとの usage を集める。"""
    turns: List[Turn] = []
    before: Optional[Turn] = None
    current: Optional[Turn] = None
    seen_ids: set = set()

    try:
        f = open(path, 'r', encoding='utf-8')
    except OSError:
        return []
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if not isinstance(rec, dict) or rec.get('isSidechain') or rec.get('isMeta'):
                continue
            kind = rec.get('type')
            message = rec.get('message')
            message = message if isinstance(message, dict) else {}

            if kind == 'user':
                text, _tools = detail._texts_and_tools(message.get('content'))
                if text.strip() and detail.is_human_prompt(rec, text):
                    current = Turn(index=len(turns), ts=_parse_ts(rec.get('timestamp')),
                                   prompt=detail.clean_text(text).strip()[:PROMPT_HEAD_LEN])
                    turns.append(current)
                continue

            if kind != 'assistant':
                continue
            if message.get('model') == '<synthetic>':
                continue
            usage = message.get('usage')
            if not isinstance(usage, dict):
                continue
            msg_id = message.get('id')
            if msg_id is not None:
                if msg_id in seen_ids:
                    continue
                seen_ids.add(msg_id)

            target = current
            if target is None:
                if before is None:
                    before = Turn(index=-1, ts=None, prompt=BEFORE_LABEL)
                target = before

            target.calls += 1
            target.input += _int(usage.get('input_tokens'))
            target.cache_create += _int(usage.get('cache_creation_input_tokens'))
            target.cache_read += _int(usage.get('cache_read_input_tokens'))
            target.output += _int(usage.get('output_tokens'))
            details = usage.get('output_tokens_details')
            if isinstance(details, dict):
                target.thinking += _int(details.get('thinking_tokens'))
            model = message.get('model')
            if isinstance(model, str) and model:
                target.models[model] = target.models.get(model, 0) + 1

    ordered = ([before] if before is not None else []) + turns
    for i, t in enumerate(ordered):
        t.index = i
    return [t.to_dict() for t in ordered]


def summarize(turns: List[dict], from_ts: Optional[float] = None,
              to_ts: Optional[float] = None) -> dict:
    """`turns`（`collect` の出力）の合計。`from_ts`／`to_ts` はターン開始時刻に
    当てる（両端含む）。指定が無ければ全ターンを合計する。`ts` が無いターン
    （「（開始前）」）は範囲指定があるときは合計に入らない。"""
    total = {'calls': 0, 'input': 0, 'cache_create': 0, 'cache_read': 0, 'output': 0, 'thinking': 0}
    for t in turns:
        ts = t.get('ts')
        if from_ts is not None and (ts is None or ts < from_ts):
            continue
        if to_ts is not None and (ts is None or ts > to_ts):
            continue
        for key in total:
            total[key] += t.get(key, 0)
    return {'turns': turns, 'total': total, 'from': from_ts, 'to': to_ts}

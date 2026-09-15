import os
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass
class Session:
    id: str
    name: Optional[str]      # None = /rename されていない
    cwd: str
    mtime: float             # 最終活動時刻（最後のユーザー発言／assistant 応答。無ければ transcript の mtime）
    path: str
    first_prompt: str = ''
    child: bool = False      # サブエージェント（headless）が開始したセッション


@dataclass
class Row:
    id: str
    name: str
    updated: str             # 'YYYY-MM-DD HH:MM'
    folder: str


@dataclass
class Doc:
    folded: List[str] = field(default_factory=list)
    hidden: Dict[str, str] = field(default_factory=dict)   # id -> 非表示時の名前
    rows: List[Row] = field(default_factory=list)
    extra_front: List[str] = field(default_factory=list)   # folded/hidden 以外の frontmatter 行


SEP = ': '


def split_name(name: str) -> Tuple[Optional[str], str]:
    if SEP in name:
        group, rest = name.split(SEP, 1)
        if group and rest:
            return group, rest
    return None, name


def fmt_time(mtime: float) -> str:
    return time.strftime('%Y-%m-%d %H:%M', time.localtime(mtime))


def folder_of(cwd: str) -> str:
    if not cwd:
        return ''
    base = os.path.basename(cwd.rstrip('/'))
    return base or cwd


def row_from(s: Session) -> Row:
    return Row(id=s.id, name=s.name or '', updated=fmt_time(s.mtime), folder=folder_of(s.cwd))


def sort_rows(rows: List[Row]) -> List[Row]:
    """最終更新の新しい順。同着は名前昇順。"""
    out = sorted(rows, key=lambda r: r.name)
    out.sort(key=lambda r: r.updated, reverse=True)
    return out

import os
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass
class Session:
    id: str
    name: Optional[str]      # None = has not been /rename'd
    cwd: str
    mtime: float             # last activity time (last user message / assistant response; falls back to the transcript's mtime)
    path: str
    first_prompt: str = ''
    child: bool = False      # session started by a sub-agent (headless)
    agent: str = 'claude'    # which agent adapter produced this (see agentsessions.agents)


@dataclass
class Row:
    id: str
    name: str
    updated: str             # 'YYYY-MM-DD HH:MM'
    folder: str


@dataclass
class Doc:
    folded: List[str] = field(default_factory=list)
    hidden: Dict[str, str] = field(default_factory=dict)   # id -> name at the time it was hidden
    rows: List[Row] = field(default_factory=list)
    extra_front: List[str] = field(default_factory=list)   # frontmatter lines other than folded/hidden


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
    """Sort by most recently updated first; ties break by name ascending."""
    out = sorted(rows, key=lambda r: r.name)
    out.sort(key=lambda r: r.updated, reverse=True)
    return out

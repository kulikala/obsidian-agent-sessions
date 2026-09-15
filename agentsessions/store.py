"""sessions.json の読み書き（D-3）。T-2 で実装する。ここでは旧 API と
同名のスタブを置き、tui.py の import を通す。"""

from typing import Dict, Tuple

from .model import Doc, Session


def persist(doc: Doc) -> None:
    raise NotImplementedError


def sessions_for_tui() -> Tuple[Doc, Dict[str, Session]]:
    raise NotImplementedError

"""A small message table for strings a human actually reads: the TUI screen, CLI
output/errors, the statusLine, and display labels in `json` output. English
(`locales/en.py`) is the base language — every key `t()` is called with must exist
there — and is also the fallback for any key a translation doesn't define. Adding a
language is one file (`locales/<code>.py`, a `MESSAGES` dict with some or all of
`en.py`'s keys) plus one line registering it in `_TABLES` below.

Language selection, in order:
1. A session launched by the plugin's daemon (`AGENT_SESSIONS_ID` is set) prefers the
   `language` field in `~/.agents/sessions/ui.json`, if the plugin has written one and
   it names a registered language (matching the language the user picked in the
   plugin's settings). Absent that, falls through to step 2.
2. The first of `LANG`, `LC_ALL`, `LC_MESSAGES` that is set is matched against the
   registered languages by prefix, case-insensitively (e.g. `ja_JP.UTF-8` -> `ja`).
   No match (e.g. `fr_FR` when only `en`/`ja` are registered) falls back to English.

This does not use the `gettext`/`locale` standard-library modules — the message tables
are small enough that plain dicts keep things simple and dependency-free.
"""
import json
import os
from typing import Any, Dict, Optional

from .. import config
from .locales import en, ja

DEFAULT_LANGUAGE = 'en'
# Registering a new language: add `locales/<code>.py` (a `MESSAGES` dict — any key it
# leaves out falls back to English) and add it here.
_TABLES: Dict[str, Dict[str, str]] = {
    'en': en.MESSAGES,
    'ja': ja.MESSAGES,
}


def _match_registered(value: str) -> Optional[str]:
    """Matches a locale-ish string (e.g. `ja_JP.UTF-8`) against a registered language
    by prefix, case-insensitively. `None` if nothing registered matches."""
    value = value.lower()
    for lang in _TABLES:
        if value.startswith(lang):
            return lang
    return None


def _env_language() -> str:
    for var in ('LANG', 'LC_ALL', 'LC_MESSAGES'):
        value = os.environ.get(var)
        if value:
            return _match_registered(value) or DEFAULT_LANGUAGE
    return DEFAULT_LANGUAGE


def _ui_state_language() -> Optional[str]:
    """Reads `language` from `ui.json`, if the plugin has written one and it names a
    registered language. `None` if there is none, the file is missing, or it doesn't
    parse."""
    try:
        with open(config.UI_STATE_PATH, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    lang = data.get('language')
    return lang if isinstance(lang, str) and lang in _TABLES else None


def language() -> str:
    if os.environ.get('AGENT_SESSIONS_ID'):
        lang = _ui_state_language()
        if lang:
            return lang
    return _env_language()


def t(key: str, **values: Any) -> str:
    table = _TABLES.get(language(), _TABLES[DEFAULT_LANGUAGE])
    msg = table.get(key, _TABLES[DEFAULT_LANGUAGE].get(key, key))
    return msg.format(**values) if values else msg

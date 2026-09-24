"""The `hook` and `status` entry points."""

import json
import os
import tempfile
import time

from .. import config, i18n
from ..sessions import live


def record_hook(raw: bytes) -> None:
    """Appends one line to `EVENTS_LOG` from the raw bytes read on stdin, and also
    updates the just-compacted marker (see `_update_compacted`).

    Never raises, no matter what goes wrong reading or writing (so this never blocks the
    hook). If one of the two fails, the other is still attempted.
    """
    try:
        data = json.loads(raw.decode('utf-8'))
    except Exception:
        return
    if not isinstance(data, dict):
        return
    try:
        entry = {
            'event': data.get('hook_event_name'),
            'session_id': data.get('session_id'),
            'transcript_path': data.get('transcript_path'),
            'ts': time.time(),
        }
        os.makedirs(os.path.dirname(config.EVENTS_LOG), exist_ok=True)
        with open(config.EVENTS_LOG, 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    except Exception:
        pass
    _update_compacted(data)


def _update_compacted(data: dict) -> None:
    """Marks a session as just-compacted, before the next prompt has been sent.

    Set: `SessionStart` with `source == 'compact'` (both `/compact` and automatic
    context compaction use this same value; settings.json's matcher already restricts
    this hook to `compact`, but this checks again just in case). Cleared:
    `UserPromptSubmit` (the next prompt was sent) or `SessionEnd` (the session ended,
    which also doubles as cleanup for the marker). The plugin's `compacted` state reads
    this so it isn't confused with `waiting` (an unread prompt for input).
    """
    if not isinstance(data, dict):
        return
    session_id = data.get('session_id')
    if not isinstance(session_id, str) or not session_id:
        return
    event = data.get('hook_event_name')
    try:
        if event == 'SessionStart' and data.get('source') == 'compact':
            os.makedirs(config.COMPACTED_DIR, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=config.COMPACTED_DIR, prefix='.compacted.', suffix='.tmp')
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    json.dump({'compactedAt': time.time()}, f)
                os.replace(tmp, os.path.join(config.COMPACTED_DIR, '%s.json' % session_id))
            except Exception:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        elif event in ('UserPromptSubmit', 'SessionEnd'):
            try:
                os.unlink(os.path.join(config.COMPACTED_DIR, '%s.json' % session_id))
            except OSError:
                pass
    except Exception:
        pass


def format_status_line(data: dict) -> str:
    """One line: `[<submit-key symbol> · ]<model.display_name> · <effort> · ctx NN% · rc ●/○`.

    `effort` is `effort.level` (when it's a dict), or `effort` itself (when it's a
    string), falling back to the "Default" label when neither is present. `rc` is
    whether the `~/.claude/sessions/*.json` entry matching `session_id` has a
    `bridgeSessionId` (via `live.live_sessions`; `○` if there's no matching entry). The
    submit-key symbol is prefixed only for a session launched by the plugin's daemon
    (`AGENT_SESSIONS_ID` is set) and only if it can be read from `config.UI_STATE_PATH`.
    """
    model = data.get('model') or {}
    display_name = model.get('display_name') or i18n.t('default')
    context_window = data.get('context_window') or {}
    used = context_window.get('used_percentage')
    pct = '—' if used is None else '%d' % round(used)

    effort = data.get('effort')
    if isinstance(effort, dict):
        effort_label = effort.get('level') or i18n.t('default')
    elif isinstance(effort, str) and effort:
        effort_label = effort
    else:
        effort_label = i18n.t('default')

    rc = False
    session_id = data.get('session_id')
    if session_id:
        entry = live.live_sessions().get(session_id)
        if entry is not None:
            rc = entry.rc
    rc_mark = '●' if rc else '○'

    line = i18n.t('statusline.line', model=display_name, effort=effort_label, pct=pct, rc=rc_mark)
    symbol = _submit_symbol()
    if symbol:
        line = i18n.t('statusline.with_symbol', symbol=symbol, line=line)
    return line


def _submit_symbol() -> str:
    """The submit-key symbol. Read from `config.UI_STATE_PATH`, but only for a session
    launched by the plugin's daemon (`AGENT_SESSIONS_ID` is set). Empty string ('' — no
    prefix) when that file is missing, malformed, or the environment variable isn't set.
    """
    if not os.environ.get('AGENT_SESSIONS_ID'):
        return ''
    try:
        with open(config.UI_STATE_PATH, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return ''
    if not isinstance(data, dict):
        return ''
    symbol = data.get('submitSymbol')
    return symbol if isinstance(symbol, str) else ''


def record_status(raw: bytes) -> str:
    """Writes the raw bytes from stdin as-is to `STATUS_DIR/<session_id>.json`
    (tmp -> rename) and returns the one-line display string. Doesn't write anything if
    there's no `session_id`. Returns the default display string if it doesn't parse as
    JSON.
    """
    try:
        data = json.loads(raw.decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        data = None
    if not isinstance(data, dict):
        return format_status_line({})

    session_id = data.get('session_id')
    if session_id:
        try:
            os.makedirs(config.STATUS_DIR, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=config.STATUS_DIR, prefix='.status.', suffix='.tmp')
            try:
                with os.fdopen(fd, 'wb') as f:
                    f.write(raw)
                os.replace(tmp, os.path.join(config.STATUS_DIR, '%s.json' % session_id))
            except Exception:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        except OSError:
            pass
    return format_status_line(data)

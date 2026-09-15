"""`hook`・`status` の受け口（D-2, D-6 §5）。"""

import json
import os
import tempfile
import time

from . import config


def record_hook(raw: bytes) -> None:
    """stdin から読んだ生バイト列を `EVENTS_LOG` に 1 行追記する。

    読めない・書けないなど何が起きても例外を投げない（フックを止めないため）。
    """
    try:
        data = json.loads(raw.decode('utf-8'))
        if not isinstance(data, dict):
            return
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


def format_status_line(data: dict) -> str:
    model = data.get('model') or {}
    display_name = model.get('display_name') or 'デフォルト'
    context_window = data.get('context_window') or {}
    used = context_window.get('used_percentage')
    pct = '—' if used is None else '%d' % round(used)
    return '%s · ctx %s%%' % (display_name, pct)


def record_status(raw: bytes) -> str:
    """stdin の生バイト列を `STATUS_DIR/<session_id>.json` にそのまま書き
    （tmp→rename）、1 行の表示文字列を返す。`session_id` が無ければ書かない。
    JSON として読めなければ既定の表示文字列を返す。
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

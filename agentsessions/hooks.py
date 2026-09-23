"""`hook`・`status` の受け口（D-2, D-6 §5, D-40）。"""

import json
import os
import tempfile
import time

from . import config, live


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
    """`<model.display_name> · <effort> · ctx NN% · rc ●/○[ · <送信キー記号>]` の 1 行。

    `effort` は `effort.level`（辞書のとき）、または `effort` 自身（文字列の
    とき）、無ければ「デフォルト」。`rc` は `~/.claude/sessions/*.json` の
    うち `session_id` の一致する行の `bridgeSessionId` の有無
    （`live.live_sessions` を使う。一致が無ければ `○`）。送信キー記号
    （T-71）は `AGENT_SESSIONS_ID`（プラグインのデーモンから起動したセッション）
    のときだけ、`config.UI_STATE_PATH` から読めれば末尾に付ける。
    """
    model = data.get('model') or {}
    display_name = model.get('display_name') or 'デフォルト'
    context_window = data.get('context_window') or {}
    used = context_window.get('used_percentage')
    pct = '—' if used is None else '%d' % round(used)

    effort = data.get('effort')
    if isinstance(effort, dict):
        effort_label = effort.get('level') or 'デフォルト'
    elif isinstance(effort, str) and effort:
        effort_label = effort
    else:
        effort_label = 'デフォルト'

    rc = False
    session_id = data.get('session_id')
    if session_id:
        entry = live.live_sessions().get(session_id)
        if entry is not None:
            rc = entry.rc
    rc_mark = '●' if rc else '○'

    line = '%s · %s · ctx %s%% · rc %s' % (display_name, effort_label, pct, rc_mark)
    symbol = _submit_symbol()
    if symbol:
        line += ' · %s' % symbol
    return line


def _submit_symbol() -> str:
    """送信キーの記号（T-71）。プラグインのデーモンから起動したセッション
    （`AGENT_SESSIONS_ID` が立っている）でだけ、`config.UI_STATE_PATH` から読む。
    無い・壊れている・その環境変数が無いプロセスでは空文字（付けない）。
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

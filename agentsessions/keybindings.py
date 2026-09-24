"""`keybindings.json` から、自分が入れた送信キーの 2 鍵を取り除く（T-83）。

書く側（`enter: chat:newline`・`meta+enter: chat:submit` を足す側）はプラグインの
`plugin/src/keybindings.ts`（`applySubmitKey`）にしかない——アンインストールだけ
Python 側から行うので、その取り除きの規則だけをここに移す：値が自分の書いた
ものと一致する鍵だけを消し、一致しない値の鍵は残して警告を返す。空になった
`Chat` ブロックは消す。ファイルが無ければ何もしない。
"""
import json
import os
from typing import List, Optional, Tuple

ENTER_KEYS = {
    'enter': 'chat:newline',
    'meta+enter': 'chat:submit',
}

SCHEMA_URL = 'https://www.schemastore.org/claude-code-keybindings.json'
DOCS_URL = 'https://code.claude.com/docs/en/keybindings'

DEFAULT_KEYBINDINGS_PATH = os.path.join(
    os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude'),
    'keybindings.json',
)


def _parse(text: str) -> Optional[dict]:
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get('bindings'), list):
        return None
    for b in data['bindings']:
        if not isinstance(b, dict) or not isinstance(b.get('context'), str):
            return None
    return data


def _find_chat(data: dict) -> Optional[dict]:
    for b in data['bindings']:
        if b.get('context') == 'Chat':
            return b
    return None


def remove_enter_keys(path: str = DEFAULT_KEYBINDINGS_PATH,
                       dry_run: bool = False) -> Tuple[bool, Optional[str]]:
    """`ENTER_KEYS` のうち、値が一致するものだけを `Chat` から取り除く。

    戻り値は `(changed, warning)`。`changed` は 1 つでも実際に消したら `True`。
    `warning` は一致しない値の鍵を残したときの案内（手で直してもらう）。

    ファイルが無ければ何もしない（`False, None`）。JSON が壊れている・形が
    想定と違うときも書かずに `warning` を返す。それ以外は（消す鍵が無くても）
    `$schema`・`$docs` を補いつつ書き戻す——足す側（`applySubmitKey`）と同じ規則。
    """
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
    except FileNotFoundError:
        return False, None
    except OSError as e:
        return False, 'keybindings.json を読めない: %s' % e

    data = _parse(text)
    if data is None:
        return False, 'keybindings.json が壊れている（手で直す）: %s' % path

    if data.get('$schema') is None:
        data['$schema'] = SCHEMA_URL
    if data.get('$docs') is None:
        data['$docs'] = DOCS_URL

    chat = _find_chat(data)
    mismatched: List[str] = []
    changed = False
    if chat is not None and isinstance(chat.get('bindings'), dict):
        for key, value in ENTER_KEYS.items():
            if chat['bindings'].get(key) == value:
                del chat['bindings'][key]
                changed = True
            elif key in chat['bindings']:
                mismatched.append(key)
        if not chat['bindings']:
            data['bindings'] = [b for b in data['bindings'] if b is not chat]

    if not dry_run:
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    warning = None
    if mismatched:
        warning = ('keybindings.json の Chat に別の値の %s があるので残した（手で直す）'
                   % '・'.join(mismatched))
    return changed, warning

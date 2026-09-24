"""A small message table for strings a human actually reads: the TUI screen, CLI
output/errors, the statusLine, and display labels in `json` output. English is the
default; Japanese is used only when the environment says so.

Language selection, in order:
1. A session launched by the plugin's daemon (`AGENT_SESSIONS_ID` is set) prefers the
   `language` field in `~/.agents/sessions/ui.json`, if the plugin has written one
   (matching the language the user picked in the plugin's settings). Absent that field,
   falls through to step 2.
2. The first of `LANG`, `LC_ALL`, `LC_MESSAGES` that is set selects Japanese if its value
   starts with `ja` (case-insensitive), otherwise English.

This does not use the `gettext`/`locale` standard-library modules — the message table is
small enough that a plain dict keeps things simple and dependency-free.
"""
import json
import os
from typing import Any, Optional

from . import config

_EN = {
    'default': 'Default',

    # live.py: STATUS_LABEL — a live session's status, shown in the TUI panel and in the
    # `status_label` field of `json live`'s output.
    'status.busy': 'Running',
    'status.shell': 'Running a command',
    'status.idle': 'Idle',
    'status.waiting': 'Waiting for a reply',
    'status.unknown': 'Starting',

    # tui.py
    'tui.help': '↑↓/jk move  ⏎ open  ← up/collapse  → expand  '
                'h toggle archive  / filter  p panel  r rescan  q quit',
    'tui.counts': 'tracked {managed} / archived {archived} / other {other} / running {running}',
    # Display text for the group whose identifier is `config.OTHER_GROUP` (a persisted
    # Japanese string, kept as-is on disk — see config.py).
    'tui.other_group': 'Other',
    'tui.group_count': 'group / {count} item(s)',
    'tui.last_updated': 'last updated  {when}',
    'tui.running_count': 'running   {count}',
    'tui.stopped': '  stopped',
    'tui.folder': 'folder    {folder}',
    'tui.id': 'ID        {id}',
    'tui.archived_note': '(archived)',
    'tui.archived_suffix': ' (archived)',
    'tui.no_sessions': 'No sessions',
    'tui.empty': '(none)',
    'tui.last_prompt': 'Last prompt',
    'tui.last_tools': 'Recent tools',
    'tui.last_response': 'Last response',
    'tui.filter_prompt': 'filter: {filt}  (Esc to clear)',
    'list_separator': ', ',

    # hooks.py: format_status_line
    'statusline.line': '{model} · {effort} · ctx {pct}% · rc {rc}',
    'statusline.with_symbol': '{symbol} · {line}',

    # setup.py: `agent-sessions setup` change descriptions
    'setup.hook_migrated': 'hooks.{event}: {old!r} -> {new!r}',
    'setup.hook_added': 'hooks.{event}: added matcher={matcher} {command}',
    'setup.hook_removed': 'hooks.{event}: removed {command}',
    'setup.status_line_set': 'statusLine: {old!r} -> {new!r}',
    'setup.status_line_removed': 'statusLine: removed {old!r}',
    'setup.keybindings_removed': 'keybindings.json: removed enter/meta+enter',
    'setup.keybindings_mismatch': 'keybindings.json: left {keys} in place under Chat '
                                   '(value differs from ours; fix it by hand)',
    'setup.keybindings_unreadable': 'keybindings.json: could not read it: {error}',
    'setup.keybindings_broken': 'keybindings.json: malformed (fix it by hand): {path}',

    # cmd_setup.py
    'cmd.needs_value': '{flag} needs a value',
    'cmd.no_changes': 'no changes',
    'cmd.dry_run_note': '(dry run: nothing was written)',
    'cmd.settings_unreadable': '{path}: not valid JSON, or not a JSON object ({error}). '
                                'Nothing was written — fix the file by hand and try again.',

    # cmd_daemon.py
    'cmd.already_running': 'already running: {path}',
    'cmd.cannot_start_daemon': 'cannot start daemon: {error} ({path})',

    # cmd_json.py
    'cmd.json_usage': 'usage: agent-sessions json scan|live|detail|usage|stats ...',
    'cmd.json_id_needs_value': '--only needs at least one ID',
    'cmd.json_detail_usage': 'usage: agent-sessions json detail ID',
    'cmd.json_usage_usage': 'usage: agent-sessions json usage ID [--from ISO] [--to ISO]',
    'cmd.json_bad_iso': 'bad ISO8601: {value}',
    'cmd.json_unknown_option': 'unknown option: {option}',
    'cmd.json_unknown_subcommand': 'unknown json subcommand: {sub}',

    # cmd_edit.py
    'cmd.edit_usage': 'usage: agent-sessions edit FILE',

    # cli.py
    'cli.usage': 'usage: agent-sessions [{subcommands}]',
    'cli.not_implemented': 'not implemented: {cmd}',
    'cli.unknown_command': 'unknown command: {cmd}',

    # attach.py
    'attach.hello_failed': 'agent-sessions attach: hello failed',
    'attach.failed': 'agent-sessions attach: {error}',
    'attach.connection_lost': 'lost the connection to the daemon',
    'attach.session_ended': 'session ended (code {code})',
}

_JA = {
    'default': 'デフォルト',

    'status.busy': '実行中',
    'status.shell': 'コマンド実行中',
    'status.idle': '待機中',
    'status.waiting': '回答待ち',
    'status.unknown': '起動中',

    'tui.help': '↑↓/jk 移動  ⏎ 起動  ← 親へ/畳む  → 開く  h アーカイブ表示  '
                '/ 絞込  p パネル  r 再走査  q 終了',
    'tui.counts': '管理中 {managed} ／ アーカイブ {archived} ／ その他 {other} ／ 起動中 {running}',
    'tui.other_group': 'その他',
    'tui.group_count': 'グループ ／ {count} 件',
    'tui.last_updated': '最終更新  {when}',
    'tui.running_count': '起動中    {count} 件',
    'tui.stopped': '  停止中',
    'tui.folder': 'フォルダ  {folder}',
    'tui.id': 'ID        {id}',
    'tui.archived_note': '（アーカイブ）',
    'tui.archived_suffix': ' (アーカイブ)',
    'tui.no_sessions': 'セッションがありません',
    'tui.empty': '（なし）',
    'tui.last_prompt': '直近の指示',
    'tui.last_tools': '直近のツール',
    'tui.last_response': '直近の応答',
    'tui.filter_prompt': '絞込: {filt}  (Esc で解除)',
    'list_separator': '、',

    'statusline.line': '{model} · {effort} · ctx {pct}% · rc {rc}',
    'statusline.with_symbol': '{symbol} · {line}',

    'setup.hook_migrated': 'hooks.{event}: {old!r} → {new!r}',
    'setup.hook_added': 'hooks.{event}: 追加 matcher={matcher} {command}',
    'setup.hook_removed': 'hooks.{event}: {command} を取り除いた',
    'setup.status_line_set': 'statusLine: {old!r} → {new!r}',
    'setup.status_line_removed': 'statusLine: {old!r} を取り除いた',
    'setup.keybindings_removed': 'keybindings.json: enter・meta+enter を取り除いた',
    'setup.keybindings_mismatch': 'keybindings.json の Chat に別の値の {keys} があるので残した'
                                   '（手で直す）',
    'setup.keybindings_unreadable': 'keybindings.json を読めない: {error}',
    'setup.keybindings_broken': 'keybindings.json が壊れている（手で直す）: {path}',

    'cmd.needs_value': '{flag} には値が要ります',
    'cmd.no_changes': '変更なし',
    'cmd.dry_run_note': '(--dry-run のため書き込んでいない)',
    'cmd.settings_unreadable': '{path}: JSON として読めないか、オブジェクトの形ではありません'
                                '（{error}）。何も書いていません——手で直してからもう一度実行してください。',

    'cmd.already_running': 'already running: {path}',
    'cmd.cannot_start_daemon': 'cannot start daemon: {error} ({path})',

    'cmd.json_usage': 'usage: agent-sessions json scan|live|detail|usage|stats ...',
    'cmd.json_id_needs_value': '--only には ID が要ります',
    'cmd.json_detail_usage': 'usage: agent-sessions json detail ID',
    'cmd.json_usage_usage': 'usage: agent-sessions json usage ID [--from ISO] [--to ISO]',
    'cmd.json_bad_iso': 'bad ISO8601: {value}',
    'cmd.json_unknown_option': 'unknown option: {option}',
    'cmd.json_unknown_subcommand': 'unknown json subcommand: {sub}',

    'cmd.edit_usage': 'usage: agent-sessions edit FILE',

    'cli.usage': 'usage: agent-sessions [{subcommands}]',
    'cli.not_implemented': '未実装: {cmd}',
    'cli.unknown_command': 'unknown command: {cmd}',

    'attach.hello_failed': 'agent-sessions attach: hello に失敗しました',
    'attach.failed': 'agent-sessions attach: {error}',
    'attach.connection_lost': 'デーモンとの接続が切れました',
    'attach.session_ended': 'セッションは終了しました（code {code}）',
}


def _env_language() -> str:
    for var in ('LANG', 'LC_ALL', 'LC_MESSAGES'):
        value = os.environ.get(var)
        if value:
            return 'ja' if value.lower().startswith('ja') else 'en'
    return 'en'


def _ui_state_language() -> Optional[str]:
    """Reads `language` from `ui.json`, if the plugin has written one. `None` if there is
    none, the file is missing, or it doesn't parse."""
    try:
        with open(config.UI_STATE_PATH, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    lang = data.get('language')
    return lang if lang in ('ja', 'en') else None


def language() -> str:
    if os.environ.get('AGENT_SESSIONS_ID'):
        lang = _ui_state_language()
        if lang:
            return lang
    return _env_language()


def t(key: str, **values: Any) -> str:
    table = _JA if language() == 'ja' else _EN
    msg = table.get(key, _EN.get(key, key))
    return msg.format(**values) if values else msg

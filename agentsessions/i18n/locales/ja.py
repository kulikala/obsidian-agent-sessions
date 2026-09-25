"""Japanese messages.

Any key not defined here falls back to English (see `locales/en.py` and
`i18n/__init__.py`'s `t()`).
"""

MESSAGES = {
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

    'cmd.json_usage': 'usage: agent-sessions json scan|live|detail|usage|stats|resolve ...',
    'cmd.json_id_needs_value': '--only には ID が要ります',
    'cmd.json_detail_usage': 'usage: agent-sessions json detail ID',
    'cmd.json_usage_usage': 'usage: agent-sessions json usage ID [--from ISO] [--to ISO]',
    'cmd.json_bad_iso': 'bad ISO8601: {value}',
    'cmd.json_unknown_option': 'unknown option: {option}',
    'cmd.json_unknown_subcommand': 'unknown json subcommand: {sub}',
    'cmd.json_resolve_usage': 'usage: agent-sessions json resolve AGENT --pid PID --since ISO_OR_EPOCH --cwd PATH',
    'cmd.json_resolve_bad_pid': 'bad pid: {value}',

    'cmd.edit_usage': 'usage: agent-sessions edit FILE',

    'cli.usage': 'usage: agent-sessions [{subcommands}]',
    'cli.not_implemented': '未実装: {cmd}',
    'cli.unknown_command': 'unknown command: {cmd}',

    'attach.hello_failed': 'agent-sessions attach: hello に失敗しました',
    'attach.failed': 'agent-sessions attach: {error}',
    'attach.connection_lost': 'デーモンとの接続が切れました',
    'attach.session_ended': 'セッションは終了しました（code {code}）',
}

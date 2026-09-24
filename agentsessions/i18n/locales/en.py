"""English messages — the base language.

Every other locale's `MESSAGES` falls back to this dict for any key it doesn't
define (see `i18n/__init__.py`'s `t()`), so this file must have every key `t()` is
ever called with somewhere in the codebase.
"""

MESSAGES = {
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

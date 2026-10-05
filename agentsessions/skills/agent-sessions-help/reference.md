{{MARKER}}

# Agent Sessions reference

Facts about the Agent Sessions plugin for Obsidian, by task. Each name is written as "English / 日本語": the label in an English UI and in a Japanese UI. Where nothing is given in Japanese, the label is the same (an agent or program name). Source: the plugin's README, its design and testing docs, and its English and Japanese UI strings.

Contents: What it is - Where things are - Install, update, remove - Welcome guide - Start and resume a session - Close, end and restart - Name and categorize - Organize names and categories - Row menu, change model, compact, archive - Session list and states - Session Manager - Activity calendar - Usage and limits - Built-in editor - Keys and terminal tab - Settings - Agents - Language - Supported platforms - Troubleshooting - What the agent can do - Privacy

## What it is

Agent Sessions runs Claude Code, Codex and OpenCode sessions as terminal tabs inside Obsidian (desktop only), with a session list, a usage dashboard and a small background program (the daemon) that keeps sessions alive. Closing a tab, reloading the plugin or quitting Obsidian does not end a session; reopening the tab reattaches and replays the last screen. The plugin drives a Python program called `agent-sessions` (Python 3.9+, standard library only) that ships inside the plugin and is written out when the user installs it.

## Where things are

- Ribbon icon "Agent Sessions" (list icon) opens the side panel. The same is the command "Open session list / 一覧を開く".
- Side panel (right sidebar): a list of sessions, a details pane, and the 5-hour/7-day usage bars. Its top row has three buttons: `+` (New session / 新規セッション), the grid icon (Session manager / セッションマネージャー) and `⋯` (menu: Rescan / 再走査, Organize names and categories / セッション名とカテゴリを整理, Open settings / 設定を開く).
- Session Manager: a tab in the main area with the full session tree and the usage analytics. Open it from the side panel's grid button or the command "Session manager / セッションマネージャー". Opening it never starts a session.
- Terminal tab: one session per Obsidian tab. Move, split or pin it like any tab.
- Commands (command palette, shown as "Agent Sessions: ..."):
  - Open session list / 一覧を開く
  - Session manager / セッションマネージャー
  - New session / 新規セッション
  - Start the welcome guide from the beginning / ようこそガイドを最初から始める
  - Continue the welcome guide / ようこそガイドの続きから (only while an unfinished run exists)
  - Insert current note with @ / 現在のノートを @ で挿入
- Settings: Settings -> Community plugins -> Agent Sessions (the plugin's settings tab).

## Install, update, remove

Install the plugin:
1. Obsidian: Settings -> Community plugins -> Browse, search "Agent Sessions", install, enable.
2. Open the side panel (ribbon icon) and press "Install agent-sessions / agent-sessions をインストール". The dialog shows, before anything is written, where the program goes, which Python runs it and what changes in Claude Code's settings (a hooks and status line entry in `~/.claude/settings.json`, backed up first), and, when OpenCode is enabled, the OpenCode files. It also lists the agent skills it adds to the vault ("Agent skills / エージェント用スキル"). Press "Install / インストール".

Needs: Obsidian 1.8.7 or later on the desktop (macOS, Linux, Windows), Python 3.9 or later, and at least one of Claude Code, Codex or OpenCode (on the PATH or set in the plugin's Agents settings).

- No Python found: macOS - run `xcode-select --install` in Terminal, or install Python from python.org or Homebrew, then press "Check again / もう一度確認". Linux - install `python3` with the package manager. Windows - the dialog offers "Install Python with WinGet / WinGet で Python をインストール" (per user, no administrator rights), or install from python.org. If WinGet itself is missing, update "App Installer" from the Microsoft Store.
- Claude Code missing on Windows: the dialog offers "Install Claude Code with WinGet / WinGet で Claude Code をインストール". On macOS and Linux the welcome guide shows each missing agent's official install command to copy and run in a terminal (the plugin never runs it for the user).
- Update: updating the plugin updates the program too (on the next load). Settings -> "agent-sessions program / agent-sessions プログラム" shows its state and offers "Reinstall / 入れ直す" and "Remove / 削除".
- Remove: first Settings -> agent-sessions program -> Remove (stops the daemon, so running sessions end; takes out the hooks, status line and key settings it added, and the agent skills in the vault; deletes its folder). Then disable and remove the plugin under Community plugins.
- The program lives in the first usable folder of `$XDG_DATA_HOME/agent-sessions`, `~/.local/share/agent-sessions`, `~/.agents/sessions/app` (Windows: `%LOCALAPPDATA%\agent-sessions`). A custom location can be set in Settings -> "agent-sessions location / agent-sessions の場所" (empty = `~/bin/agent-sessions` if it exists, otherwise the copy installed from the plugin).
- A copy of the repository can be installed for the `agent-sessions` command in a terminal (macOS and Linux): `./scripts/install.sh` (see the README, "From a clone").

## Welcome guide

A walkthrough with pictures: it opens by itself on first install and, after an update, only when the new version has something to show. Steps: Language (Auto / English / 日本語) -> About and Setup (the program, agents found, the agent for the first session, the submit key) -> Hands-on (start a real session, switch tabs, rename it, optionally file it in a category, send a prompt from the built-in editor; a small window at the bottom right ticks each step; "Skip / 飛ばす" passes one over) -> More (restart, organize, Session Manager and usage).

- Closing it keeps the place; the next start shows a notice, and "Continue the welcome guide / ようこそガイドの続きから" (command palette or settings) resumes. "Start the welcome guide from the beginning / ようこそガイドを最初から始める" runs it again.
- With Codex or OpenCode only the tab-switch step is offered in the hands-on part.
- Settings: "Show the welcome guide after updates / アップデート後にようこそガイドを表示" stops it reopening; "Load the guide's pictures from GitHub / ガイドの図を GitHub から読み込む" turns the pictures off (descriptions are shown instead). The pictures are the only thing the plugin fetches from the network.

## Start and resume a session

- New: `+` in the side panel or the Session Manager toolbar, the command "New session / 新規セッション", or the "New session" button shown in an empty side panel. The dialog has "Name / 名前" (optional; a category can be written as `Category: Name`) and "Agent / エージェント" (asked only when more than one agent is enabled). It opens a terminal tab.
- Resume: click a row in "Recent / 最近" (opens a tab that resumes that conversation), or in "Running / 起動中" (attaches a tab to a session the daemon is still holding). A row under "Open tabs / 開いているタブ" already has a tab; clicking it brings it to the front. One session has one tab; the plugin jumps to the existing tab instead of opening a second.
- The first time an agent runs, its terminal may ask about the theme, login or trusting the folder; answer in the terminal.
- A new Codex session cannot be named at creation; rename it once it is running. Codex and OpenCode record a session only after its first message.
- OpenCode can run through Ollama for a local model: Settings -> Agents -> OpenCode -> "Launch with / 起動方法" = `ollama launch opencode`, then choose the "Ollama model / Ollama のモデル" (from `ollama list`, or type a name). Ollama must be installed.

## Close, end and restart

- Closing a tab does not end the session. It keeps running in the daemon and shows under "Running / 起動中"; open it again to reattach. Quitting Obsidian keeps sessions running too.
- End a session: row menu (`⋯` or right-click) -> "End session / セッションを終了" (running sessions only; it asks first). Removing the program (Settings -> agent-sessions program -> Remove) stops the daemon and ends every running session.
- Restart: row menu -> "Restart session / セッションを再起動". It ends the agent and resumes the same conversation in the same tab, to pick up changed settings, hooks, skills or environment. Running sessions with a real conversation id only (a Codex or OpenCode session that is not recorded yet cannot be restarted); if the session is busy it asks first because the current work is interrupted. The earlier conversation stays.
- The tab of an exited session offers "Resume / 再開" (continue the conversation) or "Start as new / 新規として開始"; when the connection to the daemon is lost the tab offers "Reconnect / 再接続" or "Retry / 再試行".

## Name and categorize

- A category is the part of a name before `: `. `Backend: Fix login` is category "Backend", name "Fix login". A name without `: ` has no category.
- Rename: row menu -> "Rename / 名前を変更". The dialog has one field for category and name together: type the category and then `:` (a full-width `：` counts once a space follows); the category turns into a chip. Existing categories are suggested in a dropdown (arrow keys move, Enter or Tab picks). The new name shows in the panel, the manager and the tab title. The plugin sends `/rename` to the running session, so for a Claude Code session started with Remote Control the name also changes in its Remote Control session (claude.ai and the Claude app).
- Move to category: row menu -> "Move to category… / カテゴリに移動…". A single category field with a dropdown of existing categories; a new name creates a category. It is disabled until the session has a name or a first prompt.
- Each category gets a stable color. The Session Manager groups sessions by category; sessions without one are under "Other / その他".

## Organize names and categories

For many sessions at once: `⋯` menu of the side panel or the Session Manager -> "Organize names and categories / セッション名とカテゴリを整理". For one session: its row menu -> "Suggest name and category… / 名前とカテゴリを提案…" opens the same dialog for just that session (press "Suggest / 提案する"; the result has a comment field and "Suggest again / もう一度提案" for another try, then "Apply selected / 選択を適用").
1. The dialog says which agent will make the suggestions ("Suggestions by ... / 提案するエージェント: ..."): Claude Code if enabled, otherwise Codex, otherwise OpenCode (on Windows, Claude Code only).
2. "Only unnamed or uncategorized sessions / 名前またはカテゴリが未設定のセッションだけ" (on by default) limits it to incomplete sessions. At most 30 recent, non-archived sessions are considered.
3. "Suggest / 提案する" runs the agent once, headless, and shows progress (spinner, seconds, "Show log / ログを表示"). With Claude Code the model is Sonnet; Settings -> "Model for suggestions / 提案に使うモデル" switches to Haiku (faster, less accurate). Names come out short (about 20 Japanese characters or 5 words), categories are your existing ones where they fit, and each row has a one-line reason.
4. The result lists each session: current category and name, suggested category and name, and a round apply toggle. Untick the ones to skip; unticked rows get a comment field (and one comment for all). "Suggest again for unchecked / チェックを外した行だけ再提案" re-asks for only those; "Suggest all again / すべてやり直す" redoes all.
5. "Apply selected / 選択を適用" renames the ticked sessions. Nothing changes before that; closing the dialog changes nothing.
It sends excerpts of the sessions (folder, first prompt, the last three prompts, a short excerpt of the last reply, existing category names with a few example session names) to that agent under the user's own account, and counts against its usage limits. See Privacy.

## Row menu, change model, compact, archive

The row menu (`⋯` or right-click on a row, side panel and Session Manager) is in four groups with separators:
1. "Rename / 名前を変更", "Move to category… / カテゴリに移動…", "Suggest name and category… / 名前とカテゴリを提案…"
2. "Change model… / モデルを変更…", "Compact session / セッションを圧縮", "Restart session / セッションを再起動"
3. "Session analytics / セッション解析結果", "Copy ID / ID をコピー"
4. "End session / セッションを終了", "Archive / アーカイブ" (or "Remove from archive / アーカイブ解除") (end first, then archive)
Change model, Restart session and End session appear for running sessions (held by the daemon) only. Change model is disabled, with a tooltip, for Codex and OpenCode sessions.

- "Change model… / モデルを変更…" (Claude Code, running): the dialog "Change model / モデルを変更" shows "Now: <model> · <effort> / 現在: ..." and has "Model / モデル" (Default, Best available, Opus Plan, the Opus/Sonnet/Haiku aliases, or "Other… / その他…" for a full model ID such as `claude-opus-5-5`) and "Effort / エフォート" (including "Auto (clear the saved level)"). "Apply / 適用" sends only what changed: `/model <x>` and/or `/effort <y>` to the session. `/model` also becomes Claude Code's default for new sessions; `/effort max` applies to this session only; not every model supports every effort level. If Claude Code opens its "Switch model?" confirmation (a conversation with history), the plugin answers it for the user, so nothing has to be typed in the terminal. A draft being typed in the prompt is kept.
- "Compact session": sends `/compact` to the session. Disabled right after a compaction, until the next instruction.
- "Archive": the row leaves the lists. In the Session Manager, `⋯` -> "Show archive / アーカイブを表示" lists archived sessions; "Remove from archive" brings one back. The status filter "Archived / アーカイブ済み" also shows them.
- "Session analytics": cost, tokens, turns and duration cards, input/output/tool-use bars and a turn-by-turn table. Click rows to select a range; "Copy" gives the result as Markdown.
- "Copy ID": copies the session id.

## Session list and states

- Side panel sections: "Open tabs / 開いているタブ", "Running / 起動中" (held by the daemon, no tab), "Recent / 最近" (the number shown is Settings -> "Recent count (side panel) / 最近の件数（サイドパネル）", default 10). Each row: state icon, agent icon, category chip, name, last update, a mark if a tab exists, `⋯`.
- A badge on the list heading counts "Needs input / 入力待ち" and "Needs review / レビュー待ち"; clicking it flashes those rows.
- Hovering a row for a moment shows its details (model, effort, context use, tokens, cost, last prompt and reply) in the details pane.
- States, shared by the tab, the side panel and the manager: Connecting / 接続中; Working / 処理中; Running a command / コマンド実行中; Waiting for your answer / 回答待ち (a question or permission prompt in the agent); Waiting for input / 指示待ち (finished, tab not yet looked at); Compacted / compact 済み; Editing / 編集中 (built-in editor open); Idle / 待機; Not connected / 未接続 (tab restored but not yet brought to the front); Exited / 終了; Error / エラー.
- Status groups (filter in the Session Manager): All / すべて, Needs input / 入力待ち, Needs review / レビュー待ち, Running / 実行中, Done / 完了, Archived / アーカイブ済み.
- Notification: when a session that is not in front goes from working to waiting, a notice "<name>: waiting for input" appears for 8 seconds; clicking it opens the session. Turn off with Settings -> "Notify when waiting for input / 指示待ちの通知".
- A row's agent is shown by a small icon (Claude Code, Codex or OpenCode). OpenCode sub-agent sessions and sessions started by `opencode run` are not listed.

## Session Manager

- A tree of sessions grouped by category (foldable), then "Other / その他", then the archive when shown. Columns: state, name, "Last updated / 最終更新", "Model / モデル", "Effort / エフォート", 5h and 7d cost, "Folder / フォルダ".
- Toolbar: `+` new session, Rescan / 再走査, the calendar button (Activity calendar, below), a name filter ("Filter / 絞込"), a status filter ("Filter by status / 状態で絞り込む"), `⋯` (Show archive, Organize). Clicking a row opens it; Up/Down moves the selection, Enter opens, `/` focuses the filter. Clicking the 5h or 7d column header sorts and flattens the tree.
- Below the table: the usage analytics panel (see Usage and limits), foldable and resizable by dragging the handle. With more than one agent enabled each agent gets its own panel.

## Activity calendar

- Open it from the command palette ("Open activity calendar / 稼働カレンダーを開く"), the Session Manager toolbar's calendar button, or the side panel's `⋯` menu. One tab.
- It shows when each agent was working: per day, one lane per agent, a colored block for each stretch of work (see below). A block is colored by the session's category (the chip's color), or by the agent when it has none; overlapping sessions sit side by side; a tall enough block shows its name. Hover a block for "HH:MM-HH:MM name".
- A toggle picks the period: "Session / セッション" (default; 7 days aligned to the reset of the usage limit's 7-day window: Claude Code's if enabled and known, else Codex's, else a Sunday-start week), "Week / 週" (Sunday to Saturday, local time), "Day / 日" (one day, one wide column per agent). The arrows (previous/next, "Latest / 最新") move by one period and never go past the one holding now. Clicking a date in a day header opens that day. The mode is remembered.
- The calendar refreshes itself while it is visible (coming back to its tab, a few seconds after a session finishes a turn, every minute for the current period), keeping the scroll position and the open block; the reload button forces it.
- Cards per agent: hours (overlaps counted once), number of sessions, and the most sessions working at once. The filter box narrows by title.
- A block is close to the real working time: a turn starts at your own input (a prompt or slash command you typed, or your answer to a question the agent asked) and lasts until the agent's last output before your next input; notifications, reminders and other sessions' messages in between belong to the running turn and don't start one, and a pause of 30 minutes or more inside a turn is not counted. The time its sub-agents (background agents, teammates) were working counts too, so work handed to sub-agents is counted while they run. Turns less than 30 minutes apart are joined into one block, so related work shows as one flow instead of chopped pieces; a turn under a minute is shown as one minute; a turn still running ends now.
- Each agent has a toggle (icon and name) that shows or hides its lanes, blocks and card; at least one stays on; the choice is remembered. Every block is drawn at least a few pixels tall, so a one-minute turn is still visible (the tooltip shows the true times). In "Day / 日" each session gets its own column (grouped by agent, scrolling sideways when many) instead of one lane per agent.
- Clicking a block splits the view: the calendar stays on the left and a panel opens on the right (drag the divider to resize; "Close / 閉じる" returns to full width). The panel's top shows the block: the session, its start-end and duration, and one row per turn of yours in it: its times, duration, what you asked (an answer to a question shows as "Answer / 回答") and the response it ended with, folded behind a "Response / 応答" disclosure (notifications are not listed). The panel's bottom shows the session's details (the same as the side panel's details pane), with "Open session / セッションを開く".

## Usage and limits

- Side panel, bottom: for each enabled agent, a usage bar for its 5-hour and 7-day windows with a countdown to reset.
- Session Manager, bottom: for each window, a card with the usage bar, "resets in ..." ("リセットまで ..."), Cost, Tokens, Calls and Sessions, a pace line, and a bar chart of cost by category (top 8; "Other" for uncategorized). The pace line projects the current rate: "On track - about N% used by reset at this pace" or "At this pace you'll hit the limit <when> (<time> before reset)" with a daily or hourly allowance to stay within. Click the area to refresh.
- Windows: Claude Code shows 5-hour and 7-day. Codex shows the windows its account reports (some plans track only another length, for example 30 days). OpenCode has no usage windows; per-session tokens and cost are still available. Costs are estimates computed from each agent's own transcripts.
- Per session: the details pane (total tokens, total cost) and "Session analytics".
- The agent itself can read these numbers; see What the agent can do.

## Built-in editor

- Press Ctrl+G inside a session (the "Editor key", see Settings) to edit the current prompt, or what `/memory` and `/keybindings` open, in a pane under the terminal. The terminal output stays visible. The pane's height is Settings -> "Editor pane height (%) / 編集領域の高さ（%）" (default 40).
- For a Claude Code prompt the bar also has "Model / モデル" and "Effort / エフォート" dropdowns (narrow; a long model name is shortened in the closed dropdown, for example "Opus Plan", and shown in full as a tooltip), set to the current values ("Keep current / 現在のまま"). If one is changed, "Send" first applies it with `/model` / `/effort` and then submits the prompt text intact. Other edits (`/memory` and so on) and other agents show no dropdowns.
- Type `@` to complete a file name from the vault; autosave; paste, IME and undo work natively; Tab indents.
- "Send (<submit key>) / 送る（<キー>）" submits a prompt at once; Esc ("Back to prompt (Esc) / 入力欄に戻る（Esc）") returns to the agent's input without sending. Files other than a prompt (for example `/keybindings`) are saved but not submitted.
- While the pane is open Ctrl+W (Cmd+W on macOS) does not close the tab.
- If the editor cannot reach the tab it falls back to a terminal editor (`$AGENT_SESSIONS_FALLBACK_EDITOR`, else `vi`).

## Keys and terminal tab

- Submit key: Settings -> Input -> "Submit key / 送信キー". Default Enter. Other choices make Enter insert a newline and send with that key instead: Shift+Enter, Ctrl+Enter, Alt (Option)+Enter, and on macOS Cmd+Enter. Choosing another key writes the agents' own key settings (`~/.claude/keybindings.json`, `~/.codex/config.toml`, OpenCode's `tui.json`) after a confirmation; this also applies to those agents outside Obsidian. Going back to Enter takes the entries out.
- Editor key: Settings -> Input -> "Editor key / エディタキー". Default Ctrl+G; Ctrl+Q and Alt (Option)+G are the others. Another key is written into the agents' settings the same way (Ctrl+G then no longer opens the editor in Claude Code).
- Header actions of a terminal tab: insert the current note as `@path` (also the command "Insert current note with @ / 現在のノートを @ で挿入"; a selection of several lines adds a line range), "Previous instruction / 前の指示", "Next instruction / 次の指示", "Last response / 最後の応答" (jump through the terminal's scrollback).
- File paths printed in the output that resolve to a file in the vault are clickable and open the note.
- Font size: Cmd +/-/0 on macOS; Ctrl+Shift+=/-/0 elsewhere. Elsewhere than macOS also Ctrl+Shift+C / Ctrl+Shift+V copy and paste, Ctrl+Shift+W closes the tab, Ctrl+Shift+P opens the command palette. Plain Ctrl combinations (Ctrl+C, Ctrl+G, Ctrl+W, Ctrl+P ...) always go to the agent, not Obsidian.
- Scroll back with the mouse wheel or the keyboard; the output stays intact.

## Settings

Settings -> Community plugins -> Agent Sessions. Sections and items (English / 日本語):
- Display / 表示: Font / フォント; Font size / フォントサイズ; Padding / 余白 (Comfortable ゆったり, Compact コンパクト, None なし); Language / 言語.
- Input / 入力: Submit key / 送信キー; Editor key / エディタキー.
- Other / その他: Recent count (side panel) / 最近の件数（サイドパネル）; Notify when waiting for input / 指示待ちの通知; agent-sessions location / agent-sessions の場所; Editor pane height (%) / 編集領域の高さ（%）; Scrollback lines / スクロールバック行数.
- Also in the settings tab: "agent-sessions program / agent-sessions プログラム" (state, Reinstall, Remove) and "Welcome guide / ようこそガイド" (continue or restart the guide, "Show the welcome guide after updates", "Load the guide's pictures from GitHub").
- Agents / エージェント: for Claude Code, Codex and OpenCode, a toggle to enable it, "Executable / 実行ファイル" (empty = find automatically), "Environment variables / 環境変数" (one `KEY=VALUE` per line, passed at launch) and "Find again / もう一度探す". OpenCode also has "Launch with / 起動方法" and "Ollama model / Ollama のモデル". At least one agent must stay enabled.

## Agents

- Which to use: enable the agents in Settings -> Agents (they are auto-detected on first run). With several enabled, "New session" asks which one to start, and the lists, filters and usage panels mix or split them by agent.
- Enabling or disabling an agent changes the files the plugin keeps for it: Codex gets its submit-key and editor-key lines and a default status line in `~/.codex/config.toml`; OpenCode gets a status plugin and a status line in `~/.config/opencode/` and key entries in its `tui.json`; turning the agent off (or Remove) takes them out again. The vault's agent skills are rewritten for the enabled agents.
- Claude Code relies on its hooks and status line (added at install). Which usage windows each agent has is under Usage and limits.

## Language

Settings -> Display -> "Language / 言語": Auto / 自動 (follows Obsidian), English, 日本語. The welcome guide's first step has the same choice. The agent skills' text is English whatever the UI language.

## Supported platforms

- macOS: supported. Linux (Ubuntu verified): supported.
- Windows with Windows Obsidian and Windows Claude Code (setup 1): supported for Claude Code only. Codex and OpenCode show "Not available on Windows yet / Windows ではまだ使えません" in the settings and stay off. The terminal UI (`agent-sessions` with no arguments) and `agent-sessions attach` are not available on Windows; the other commands and the built-in editor work. Windows 10 1809 and later has the needed ConPTY but is untested.
- Windows Obsidian with Claude Code in WSL1 (setup 2) or WSL2 (setup 3): not supported. The agent's hooks, transcripts and processes live on the Linux side where the plugin cannot start or observe them; under WSL2's default networking the built-in editor round trip also fails. For WSL users: run Obsidian itself inside WSL through WSLg (setup 4: Linux Obsidian with the agent in the same WSL2 distribution), which is Linux on both sides; supported but not yet verified.
- The plugin, the program and the agent must run in the same operating system.
- Mobile and web builds of Obsidian: not supported (desktop only; the plugin starts processes and opens local sockets).
- Obsidian older than 1.8.7: not supported.

## Troubleshooting

- "agent-sessions was not found" / "agent-sessions が見つからない": the plugin is installed but the program is not. Press "Install agent-sessions" in the side panel, or set the program's path in Settings -> agent-sessions location.
- The side panel says to install the program ("Sessions run through agent-sessions ..."): same fix.
- "Can't connect to the daemon": Python may be missing, or the socket could not be created. Check Python 3.9+ and reinstall the program from Settings.
- "<agent> was not found" / the side panel's "Couldn't find the executable for <agent>": the agent CLI is not on the PATH; set its path in Settings -> Agents -> Executable, or press "Find again".
- Nothing happens, or "Agent Sessions runs on macOS, Linux and Windows desktops only": the device is unsupported (mobile).
- A Claude Code hook fails with `node: not found` (often another plugin's hook): node is installed through a version manager (mise, nvm, asdf, volta) that loads only in an interactive shell. The plugin merges an interactive shell's PATH in, so it normally corrects itself on the next session; if not, check that `$SHELL -i -c 'echo $PATH'` in a normal terminal includes node's folder.
- A key setting seems wrong: Settings -> Input shows a warning ("Doesn't match Claude Code's settings") when `keybindings.json` differs from the submit key; re-choose the key to rewrite it.
- "Couldn't lock sessions.json": wait a moment and try again.
- The welcome guide's pictures do not load: offline, or this version's pictures are not published; turn them off in Settings -> "Load the guide's pictures from GitHub".
- Agent skills: if a skill folder in the vault has the same name as one of the plugin's skills but not its marker, it is left alone and the plugin says so.
- A session exits with a code: the tab shows "The session has ended (<code>)" with Resume / Start as new.

## What the agent can do

Through the `agent-sessions` skill (installed in the vault along with this one), an agent running in the vault can show the 5-hour/7-day usage windows and a session's tokens and cost, list the other sessions with status and last messages, and, only when the user explicitly asks, start a new session (in a folder, with a name, on any enabled agent, Claude Code optionally with Remote Control). It cannot rename, categorize, organize, archive, restart or end sessions, or change settings; those are done in the plugin's UI as described above. Agents started in a folder other than the vault do not see either skill.

## Privacy

No network use by the plugin or the program, except the welcome guide's pictures from GitHub (can be turned off). It reads the agents' own files to list sessions and compute usage, writes `~/.agents/sessions/` (daemon socket, logs, caches) and the vault's `.agents/sessions/sessions.json` (names, archive, category colors), and changes only the entries it marked in the agents' settings. "Organize names and categories" is the one feature that sends session excerpts, to an agent CLI under the user's own account, only after the user presses Suggest. Full list: README, "Disclosures".

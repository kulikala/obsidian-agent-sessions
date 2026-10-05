# Usage

The features in detail: tabs, panels, the Session Manager, naming and Organize, the built-in editor, the activity calendar, usage and limits, session states, the welcome guide, settings, the CLI, and less common troubleshooting. The [README](../README.md) has the overview.

## Sessions and tabs

- One session per Obsidian tab, backed by a real PTY (a ConPTY on Windows; xterm.js). Close the tab or quit Obsidian and the session keeps running; reopen it and the last screen is replayed.
- Claude Code, Codex, and OpenCode sessions mix freely in the same list, sorted and filtered together. Agents are auto-detected on first run; enable any of them, with per-agent path and environment-variable settings. "New session" asks which agent to start when more than one is enabled. OpenCode can also be started through `ollama launch opencode` to use a local model.
- Icons, colors, and motion show each session's state (see [Session states](#session-states)), identical in the tab, the side panel, and the manager. A notice reports when a session in another tab finishes or needs an answer.
- Paths printed in the output become clickable links when they resolve inside the vault. The tab header inserts the current note as `@path` and jumps to the previous prompt, the next prompt, or the last response.
- `Cmd +`/`Cmd -`/`Cmd 0` (macOS) or `Ctrl+Shift+=`/`Ctrl+Shift+-`/`Ctrl+Shift+0` (other platforms) change the tab's font size. On non-macOS, `Ctrl+Shift+C`/`Ctrl+Shift+V` copy and paste, `Ctrl+Shift+W` closes the tab, and `Ctrl+Shift+P` opens the command palette; plain `Ctrl+<key>` combinations always reach the agent, not Obsidian.

## Side panel and Session Manager

- The **side panel** (right sidebar) lists *open tabs*, *running* sessions (attached to the daemon but without a tab), and *recent* sessions; each row has a state icon, a category chip, and the name. A details pane shows model, effort, connection status, context usage, total tokens and cost, and the last prompt and response. A rate-limit view shows 5-hour and 7-day bars with a countdown to reset for each enabled agent.
- The **Session Manager** is the default view for a new tab. A session tree grouped by category (plus an "Other" group and an archive) sits above a collapsible, resizable usage-analytics panel: 5-hour and 7-day cards, a weekly-pace projection ("on track" or "will run out at --"), and a per-category cost bar, with one section per enabled agent when more than one is enabled. A sortable table shows last activity, model, effort, 5h/7d cost, and folder. Opening it never starts a session. The toolbar has a status filter (all, needs input, needs review, running, done, archived).
- The row menu (⋯ or right-click) renames a session and moves it to a category, changes the model, compresses (`/compact`), restarts, opens the session analysis, copies the ID, ends the session, and archives it (end first, then archive).

## Naming, categories, and Organize

Name a session as `Category: Name`: categories get a stable color and their own group in the manager. The rename dialog has one field with a dropdown of existing categories and free entry for a new one.

**Organize names and categories** (⋯ menu of the side panel and the manager) proposes a `Category: Name` for recent, non-archived sessions (30 at most; by default only those without a name or a category) from their latest prompt and reply, reusing your existing categories where they fit. It uses the agent you already have: Claude Code, else Codex, else OpenCode (the dialog says which). Untick rows you don't like, comment on them, and press **Suggest again for unchecked**. **Apply selected** renames through the same path as the row menu; nothing changes before that. It sends session excerpts to that agent, see [Disclosures](../README.md#disclosures).

## Restart, model, and effort

- **Restart session** (row menu; running sessions only; asks first if the session is busy) ends the agent and resumes the same conversation in the same tab, to pick up changed settings, hooks, skills, or environment.
- **Change model…** (row menu, running Claude Code sessions) picks a model (an alias such as Opus, Sonnet or Haiku, or a full model ID) and an effort level, and sends `/model` and `/effort` for what changed. `/model` also becomes Claude Code's default for new sessions.

## Built-in editor

Press Ctrl+G inside a session to edit the current prompt (or `/memory`, `/keybindings`, and so on) in a split pane under the terminal, with `@` file completion, autosave, and native paste, IME, and undo. The terminal output stays visible while you edit. For a Claude Code prompt the bar has model and effort dropdowns (set to the current values); if you change one, **Send** applies it with `/model` and `/effort` first and then submits the prompt. Esc returns to the input without sending. The key is the **editor key** setting (Ctrl+G, Ctrl+Q, or Option/Alt+G); each agent is configured to open its editor on it.

## Activity calendar

A calendar of when each agent was working, with a toggle for the period:

- **Session** (the default): 7 days aligned to the reset of your usage limit: Claude Code's 7-day window if Claude Code is enabled and its reset is known, else Codex's weekly window, else a Sunday-start week. Earlier periods step back by 7 days.
- **Week**: Sunday to Saturday, local time.
- **Day**: one day, 0:00 to 24:00, one wide column per agent.

The arrows move by one period and never go past the one that holds now; "Latest" returns to it. The chosen mode is remembered. Click a date in a day header to open that day.

Per day and per agent, a colored block marks the time a session was working, read from the transcripts: from the moment you submit a prompt until the agent finished its turn, plus the time its sub-agents (background agents, teammates) were working: an agent that hands the work to sub-agents is counted while they run, not only for the seconds it spends dispatching and collecting. A notification that wakes the agent counts as work too. Turns and sub-agent runs less than 30 minutes apart are joined into one block, so related work reads as one flow; a block under a minute shows as one minute. Overlapping sessions sit side by side. A title filter and per-agent cards show hours, session count, and peak concurrency. Each agent has a toggle (icon and name) that shows or hides it; at least one stays on. Every block is drawn at least a few pixels tall, so a one-minute turn stays visible. In Day mode each session gets its own column instead of one lane per agent. Hover a block for its time range and name; click it to split the view: the calendar stays on the left and a panel opens on the right (drag the divider to resize, Close to go back). Its top shows the block: its final response first, then your prompts in it with their times (each prompt's own answer folds under it), its bottom the session's details, with "Open session" to jump to its tab. Open the calendar from the Session Manager toolbar, the side panel's ⋯ menu, or the command palette.

## Usage and limits

- Account-wide 5-hour and 7-day usage windows per agent, with the countdown to reset and a weekly-pace projection.
- **Session analysis** (row menu): cost, tokens, turn count, and duration cards; input, output, and tool-use bars; and a turn-by-turn table. Click rows to select a range and copy the result as Markdown.
- Both are computed from each agent's own transcripts.

## Agent skills

Two skills are installed together with the program, into the vault only:

- `agent-sessions` lets a Claude Code, Codex, or OpenCode session started in the vault read the 5-hour and 7-day usage windows and a session's tokens and cost, list other sessions with their status and last messages, and, only when you ask for it, start a new session (in a folder, with a name, on any enabled agent, Claude Code optionally with Remote Control).
- `agent-sessions-help` answers questions about using the plugin (where something is, how to rename, organize, or restart a session, how to use the built-in editor, what is supported) in the language you ask in, from a reference written against the plugin's own menus and settings.

## Remote Control

For a Claude Code session started with Remote Control, renaming it in Agent Sessions sends `/rename` to the running session, so the name also changes in its Remote Control session (claude.ai and the Claude app).

## Session states

The terminal tab, the side panel rows, and the manager rows all share the same icon, color, and motion for a session's state: connecting, working (model is responding), running a shell command, waiting for your answer (a question or permission prompt), unread (finished responding, tab not yet brought to front), editing (built-in editor open), idle, detached (tab exists but not yet connected), compacted (just ran `/compact`, context was reset), exited, and error. Animated states respect `prefers-reduced-motion`.

These are further grouped into the same buckets Claude's own app filters sessions by — needs input, needs review, running, done — with matching icons and colors for each, plus an archived bucket. The Session Manager's toolbar has a status-filter menu for the same six buckets (all / needs input / needs review / running / done / archived).

A small icon next to the state mark shows which agent a session belongs to (Claude Code, Codex, or OpenCode) — each agent's own mark (single-color, matching the rest of the UI), not a colored brand logo.

## Welcome guide

The guide opens by itself on first install, and after an update only when the new version has something to show. It starts with the language, then sets up the program and the agents (a missing agent shows its official install command to copy, plus a link to its documentation, and **Detect again**), and has you start a real session, switch tabs, rename it, and send a prompt from the built-in editor, ticking each step as you do it (**Skip** passes a step over). It ends with restart, organize, and the Session Manager. Closing the guide keeps your place: **Continue the welcome guide** (command palette or settings) resumes, and **Start the welcome guide from the beginning** runs it again. Pictures come from GitHub while the guide is open (see [Disclosures](../README.md#disclosures)); **Load the guide's pictures from GitHub** in settings turns that off, and **Show the welcome guide after updates** stops it reopening after updates.

## More

- **OpenCode status line**: a bottom row in OpenCode's session screen with what OpenCode's own screen doesn't already show, the submit-key symbol and whether the session is busy, idle, or waiting. Turned on with OpenCode; nothing to configure.
- **Bilingual UI**: English and Japanese, with an "automatic" mode that follows Obsidian's own language setting.

## Settings

Font family and size, padding (comfortable/compact/none), submit key, editor key, recent-sessions count, idle notifications, agents (Claude Code/Codex/OpenCode — enabled, path, environment variables; for OpenCode also whether to start it directly or through `ollama launch opencode`, and the Ollama model to use, chosen from `ollama list` or typed in), path to `agent-sessions`, terminal scrollback, built-in editor height, display language (auto/Japanese/English), whether the welcome guide reopens after updates, and the saved heights of the side panel's details pane and the manager's analytics panel.

## CLI

```sh
agent-sessions                 # terminal UI: pick a session, attach or resume it
agent-sessions attach ID       # attach from a terminal (Ctrl+\ to detach)
agent-sessions daemon [--detach]
agent-sessions json scan|live|detail ID|usage ID [--from ISO --to ISO]|stats
agent-sessions setup [--dry-run]
agent-sessions setup --opencode   # install OpenCode's status plugin and status line only (--remove-opencode: remove just those files and restore the tui.json keybinds)
agent-sessions setup --skills     # install the agent skills into the vault (--remove-skills: remove just those)
agent-sessions new [--agent A] [--cwd DIR] [--name N] [--remote-control] [--prompt TEXT]   # start a session in the daemon (exit 0 confirmed, 1 unconfirmed, 2 failed)
agent-sessions sessions [--query TEXT] [--agent A] [--limit N] [--json]   # list sessions with their status
agent-sessions show [ID|NAME] [--json]   # one session's usage and last messages (default: this session)
agent-sessions stats [--json]     # 5-hour/7-day usage windows per agent
```

`agent-sessions json` is the machine-readable interface the plugin itself uses (`scan`, `live`, `detail`, `usage`, `stats`); `hook` and `status` back the Claude Code hooks and `statusLine` described above; `edit` is the receiving end of the built-in editor.

On Windows the terminal UI (`agent-sessions` with no arguments) and `agent-sessions attach` are not available (they need `curses` and `termios`); the other commands, the built-in editor included, work.

## More troubleshooting

- **A Claude Code hook fails with something like `node: not found`** (often another plugin's own hook script) — node is likely installed through a version manager (mise, nvm, asdf, volta) whose shell integration only loads in an interactive shell (`.zshrc`/`.bashrc`), not the login-but-non-interactive shell a session's environment is normally built from. The plugin also probes an interactive shell's `PATH` and merges it in (`docs/design.md`'s §4.2), so this should self-correct on the next session; if it doesn't, check that `$SHELL -i -c 'echo $PATH'` actually includes node's directory from a regular terminal.
- **The program cannot be installed on Windows (Python or Claude Code not found)** — the install dialog offers **Install Python with WinGet** / **Install Claude Code with WinGet**; each runs `winget install` per user, with no administrator prompt, once you click. If the dialog says WinGet is missing, update "App Installer" from the Microsoft Store. A `python.exe` that is only the Microsoft Store's empty alias is not used; install Python with WinGet or from python.org.
- **Claude Code in WSL, Obsidian on Windows** — not supported (setups ② and ③ in [Supported environments](../README.md#supported-environments)). Run Obsidian in WSL through WSLg (④) instead.

# Usage

How to do things with Agent Sessions, what each screen shows, and what to do when something goes wrong. The [README](../README.md) has the overview, install and disclosures.

- [Start a session](#start-a-session)
- [Work in a session tab](#work-in-a-session-tab)
- [Side panel](#side-panel)
- [Session states](#session-states)
- [Session manager](#session-manager)
- [Session menu](#session-menu)
- [Name and group sessions](#name-and-group-sessions)
- [Organize names and categories](#organize-names-and-categories)
- [Restart, model and effort](#restart-model-and-effort)
- [Built-in editor](#built-in-editor)
- [Activity calendar](#activity-calendar)
- [Usage and limits](#usage-and-limits)
- [Agent skills](#agent-skills)
- [Remote Control](#remote-control)
- [Welcome guide](#welcome-guide)
- [Settings](#settings)
- [CLI](#cli)
- [More troubleshooting](#more-troubleshooting)

## Start a session

1. Click **New session** (＋) in the side panel or the Session manager.
2. If more than one agent is enabled, choose the agent.
3. Type a name, optionally as `Category: Name` (see [Name and group sessions](#name-and-group-sessions)).
4. Click **Start**. The session opens in a new tab.

![The New session dialog with Claude Code and Codex to choose from, and the name Docs: Release notes](onboarding/en/new-session.png)

- Agents are detected on first run. Turn each one on or off, and set its path and environment variables, under **Settings → Agents** (see [Settings](#settings)).
- OpenCode can also start through `ollama launch opencode` to use a local model.

## Work in a session tab

Each session is one Obsidian tab running the agent in a real terminal (a PTY, or a ConPTY on Windows; drawn with xterm.js).

- **Closing the tab or quitting Obsidian does not end the session.** Reopen it and the last screen is shown again.
- **Paths in the output** that point inside the vault become links.
- **A notice** tells you when a session in another tab finishes or needs an answer.

The tab header has these buttons:

| Button | Does |
|---|---|
| **Insert current note with @** | types the open note's path as `@path` |
| **Previous instruction** | jumps to the previous prompt |
| **Next instruction** | jumps to the next prompt |
| **Last response** | jumps to the last response |

Keys inside a session tab:

| Action | macOS | Windows, Linux |
|---|---|---|
| Larger, smaller, reset font | `Cmd +`, `Cmd -`, `Cmd 0` | `Ctrl+Shift+=`, `Ctrl+Shift+-`, `Ctrl+Shift+0` |
| Copy, paste | — | `Ctrl+Shift+C`, `Ctrl+Shift+V` |
| Close the tab | — | `Ctrl+Shift+W` |
| Command palette | — | `Ctrl+Shift+P` |

On Windows and Linux, plain `Ctrl+<key>` always goes to the agent, not to Obsidian.

## Side panel

The side panel (right sidebar) lists sessions in three groups:

| Group | Holds |
|---|---|
| **Open tabs** | sessions with a tab |
| **Running** | sessions still running without a tab |
| **Recent** | recent sessions |

![The side panel: open tabs, running and recent sessions with state icons and categories, and the Needs input and Needs review counts at the top](onboarding/en/side-panel.png)

- Each row has a state icon, an agent icon, a category chip and the name.
- The **details pane** below shows the selected session's model, effort, connection status, context usage, total tokens and cost, and the last instruction and reply.
- At the bottom, each enabled agent's 5-hour and 7-day usage bars count down to their reset.

## Session states

The tab, the side panel and the Session manager show the same icon, color and motion for a session's state:

| State | Means |
|---|---|
| **Connecting** | the tab is connecting to the session |
| **Working** | the model is responding |
| **Running a command** | the agent is running a shell command |
| **Waiting for your answer** | a question or permission prompt is open |
| **Waiting for input** | it finished responding and you have not looked at the tab yet |
| **Editing** | the built-in editor is open |
| **Compacted (context was reset)** | `/compact` just ran |
| **Idle** | nothing is happening |
| **Not connected** | the tab exists but is not connected yet |
| **Exited** | the agent has exited |
| **Error** | an error occurred |

- Animated states respect `prefers-reduced-motion`.
- A small icon next to the state shows the agent (Claude Code, Codex or OpenCode), in one color like the rest of the UI.
- States are grouped the way Claude's own app filters sessions: **Needs input**, **Needs review**, **Running**, **Done**, plus **Archived**. The side panel shows the Needs input and Needs review counts, and the Session manager filters by these groups.

## Session manager

The Session manager is what a new empty tab shows. It also opens from **Session manager** in the side panel and the command palette. Opening it never starts a session.

![The Session manager: sessions grouped by category with model, effort and cost, and below, the 5-hour and 7-day windows and cost per category](images/manager.png)

- **Session list.** Sessions grouped by category, plus an "Other" group and the archive. The table sorts by last activity, model, effort, 5h and 7d cost, and folder.
- **Status filter** (toolbar): All, Needs input, Needs review, Running, Done, Archived.
- **Analysis** (below, collapsible and resizable): 5-hour and 7-day cards with the time to reset, a weekly-pace forecast ("on track", or when it will run out), and cost by category. With more than one agent enabled, there is one section per agent.

## Session menu

Open it with ⋯ on a row, or right-click the row, in the side panel or the Session manager.

![A session's menu open in the side panel: Rename, Move to category, Compact session, Archive, Restart session, End session, Session analytics, Copy ID](onboarding/en/row-menu.png)

| Item | Does |
|---|---|
| **Rename** | renames the session |
| **Move to category…** | changes its category |
| **Suggest name and category…** | asks an agent for a name and category for this session |
| **Change model…** | switches model and effort (running Claude Code sessions) |
| **Compact session** | sends `/compact` |
| **Restart session** | restarts the agent in the same conversation |
| **Session analytics** | opens the turn-by-turn analysis |
| **Copy ID** | copies the session ID |
| **End session** | ends the agent |
| **Archive** | moves the session to the archive |

To archive a running session, end it first.

## Name and group sessions

Name a session `Category: Name`. Each category gets a stable color and its own group in the Session manager.

- **Rename** has one field, with a dropdown of existing categories; type a new one to create it.
- **Move to category…** changes only the category.

![The Move to category dialog for Storefront: Checkout total flicker, with the list of existing categories](onboarding/en/move-category.png)

## Organize names and categories

An agent proposes a `Category: Name` for recent sessions from their folder, first prompt, last few prompts and last reply.

1. Open the ⋯ menu of the side panel or the Session manager and choose **Organize names and categories**. For one session, use **Suggest name and category…** in its row menu.
2. The dialog says which agent it will use. Press **Suggest**.
3. Untick a suggestion you don't want, add a comment if you like, and press **Suggest again for unchecked**.
4. Press **Apply selected**. Nothing is renamed before this.

![The Organize names and categories dialog: current and suggested names side by side, with one suggestion unchecked and a comment for the next try](images/organize.png)

- It covers up to 30 recent sessions that are not archived; by default only those without a name or a category.
- Names are short noun phrases. Categories reuse your existing projects or areas where one fits, and a new one only when none does. Each suggestion has a one-line reason.
- The agent is Claude Code, else Codex, else OpenCode. With Claude Code the model is Sonnet; **Model for suggestions** switches to Haiku, which is faster.
- **Apply selected** renames the same way as **Rename**.
- It sends session excerpts to that agent: see [What Organize sends](../README.md#what-organize-sends).

## Restart, model and effort

**Restart session** ends the agent and resumes the same conversation in the same tab. Use it after changing settings, hooks, skills or environment.

1. Open the session's ⋯ menu. (Restart is there for running sessions.)
2. Choose **Restart session**. If the session is busy, it asks first.

![The session menu with Restart session highlighted](onboarding/en/restart.png)

**Change model…** (running Claude Code sessions) picks a model (an alias such as Opus, Sonnet or Haiku, or a full model ID) and an effort level, and sends `/model` and `/effort` for what changed. `/model` also becomes Claude Code's default for new sessions.

## Built-in editor

1. In a session, press **Ctrl+G** (the **Editor key** setting: Ctrl+G, Ctrl+Q or Option/Alt+G).
2. Write in the pane under the terminal. It has `@` file completion, autosave, and normal paste, IME and undo. The output stays visible.
3. Press **Send** to submit, or **Back to prompt (Esc)** to return without sending.

![The built-in editor under a Claude Code session, with a multi-line prompt and the Send and Back to prompt buttons](onboarding/en/editor.png)

- It also opens for anything the agent hands to an editor, such as `/memory` or `/keybindings`.
- For a Claude Code prompt, the bar has **Model** and **Effort** dropdowns set to the current values. If you change one, **Send** applies it with `/model` and `/effort` before the prompt.
- Each agent is configured to open its editor on the editor key.

## Activity calendar

Shows when each agent was working. Open it from the Session manager toolbar, the side panel's ⋯ menu, or the command palette (**Open activity calendar**).

![The activity calendar: a week of sessions as colored blocks, one lane per agent in each day, with hours and concurrency per agent](images/calendar.png)

| Mode | Shows |
|---|---|
| **7d** (default) | 7 days aligned to your usage limit's reset |
| **Week** | Sunday to Saturday, local time |
| **Day** | one day, 0:00 to 24:00 |

- **7d** follows Claude Code's 7-day window if Claude Code is enabled and its reset is known, else Codex's weekly window, else a week from Sunday. Earlier periods step back 7 days.
- In Day mode each session gets its own column instead of one lane per agent.
- The arrows move one period and stop at the current one; **Latest** returns to it. The mode is remembered. Click a date to open that day.

**Reading a block**

- A block runs from your input to the agent's last output before your next input. Your input is what you typed (a slash command too) or your answer to the agent's question. Notifications, reminders and messages from other sessions do not start a turn.
- Time sub-agents (background agents, teammates) spend working counts too.
- A pause of 30 minutes or more inside a turn is not counted.
- Turns less than 30 minutes apart join into one block. The **30 min / 1 h / 2 h** control changes this gap; the line under the title states the current one.
- A block under a minute shows as one minute and is always a few pixels tall. Overlapping sessions sit side by side.
- The calendar shows the sessions the Session manager lists: archived sessions and unnamed child sessions started by other sessions are left out.

**Working with it**

- Hover a block for its time range and name.
- Click a block to open a details panel on the right (drag the divider to resize; **Close** to go back). It lists each of your turns in the block: when, how long, what you asked or answered, and the final reply under **Response**. Below are the session's details and **Open session**.
- Each agent's summary card (hours, sessions, peak concurrency) is also its show/hide switch. At least one agent stays on, and the choice is remembered.
- **Filter by title** narrows the blocks.
- A line marks the current time in today's column.
- The calendar reloads while it is showing: when you come back to its tab, a few seconds after a session finishes a turn, and every minute while the period includes now. It keeps your place and the open details.

## Usage and limits

- Each agent's account-wide 5-hour and 7-day windows, with the countdown to reset and a weekly-pace forecast, in the side panel and the Session manager.
- **Session analytics** (session menu): cost, tokens, turns and duration; input, output and tool-use bars; and a turn-by-turn table. Select rows to choose a range, and copy it as Markdown.
- Both come from each agent's own local files.

## Agent skills

Two skills are installed with the program, into the vault only:

| Skill | Lets an agent |
|---|---|
| `agent-sessions` | read usage and session details, list sessions, and start one when you ask |
| `agent-sessions-help` | answer questions about using the plugin |

- `agent-sessions` works from a Claude Code, Codex or OpenCode session started in the vault. It reads the 5-hour and 7-day windows and a session's tokens and cost, lists other sessions with their status and last messages, and starts a new session only when you ask (in a folder, with a name, on any enabled agent; Claude Code optionally with Remote Control).
- `agent-sessions-help` answers in the language you ask in: where something is, how to rename, organize or restart, how to use the built-in editor, what is supported.

## Remote Control

For a Claude Code session started with Remote Control, renaming it in Agent Sessions sends `/rename` to the session, so the name also changes in Remote Control (claude.ai and the Claude app).

## Welcome guide

It opens on first install, and after an update only when the new version has something to show.

1. Choose the language.
2. Set up the program and the agents. A missing agent shows its official install command to copy, a link to its documentation, and **Detect again**.

   ![The Install agent-sessions dialog listing the install folder, Python, the hooks added to Claude Code's settings, and the vault's skill folders](onboarding/en/install.png)

3. Start a real session, switch tabs, rename it, and send a prompt from the built-in editor. Each step is ticked as you do it; **Skip** passes one over.
4. Read about restart, organize and the Session manager.

- Closing the guide keeps your place: **Continue the welcome guide** (command palette or settings) resumes it, and **Start the welcome guide from the beginning** runs it again.
- Its pictures load from GitHub while it is open; **Load the guide's pictures from GitHub** turns that off (see [Disclosures](../README.md#disclosures)).
- **Show the welcome guide after updates** stops it reopening after updates.

## Settings

![Settings → Agents: Claude Code and Codex turned on with their executable paths and environment variables, OpenCode turned off](onboarding/en/agents.png)

| Setting | Values |
|---|---|
| **Font**, **Font size** | terminal font |
| **Padding** | Comfortable, Compact, None |
| **Submit key** | Enter by default |
| **Editor key** | Ctrl+G, Ctrl+Q, Option/Alt+G |
| **Recent count (side panel)** | number of recent sessions |
| **Notify when waiting for input** | on, off |
| **Agents** | per agent: on/off, **Executable**, **Environment variables**, **Find again** |
| **Launch with** (OpenCode) | `opencode` or `ollama launch opencode` |
| **Ollama model** (OpenCode) | from `ollama list`, or typed |
| **agent-sessions location** | path; empty uses `~/bin/agent-sessions` if it exists, else the installed copy |
| **Scrollback lines** | terminal history |
| **Editor pane height (%)** | built-in editor height |
| **Model for suggestions** | Sonnet, Haiku |
| **Language** | Auto, English, Japanese |
| **Show the welcome guide after updates** | on, off |
| **Load the guide's pictures from GitHub** | on, off |

- **Language: Auto** follows Obsidian's own language.
- The heights of the side panel's details pane and the Session manager's analysis panel are saved as you drag them.
- With OpenCode on, a status line row in OpenCode's session screen shows the submit-key symbol and whether the session is busy, idle or waiting. There is nothing to configure.

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

- `agent-sessions json` is the machine-readable interface the plugin uses (`scan`, `live`, `detail`, `usage`, `stats`).
- `hook` and `status` serve Claude Code's hooks and `statusLine`; `edit` receives the built-in editor.
- On Windows, the terminal UI (`agent-sessions` with no arguments) and `agent-sessions attach` are not available (they need `curses` and `termios`). The other commands, the built-in editor included, work.

## More troubleshooting

- **A Claude Code hook fails with something like `node: not found`** (often another plugin's hook script). Node is probably installed through a version manager (mise, nvm, asdf, volta) that loads only in an interactive shell (`.zshrc`, `.bashrc`). The plugin also reads an interactive shell's `PATH` ([design.md §4.2](design.md)), so the next session should work. If not, check in a terminal that `$SHELL -i -c 'echo $PATH'` includes node's folder.
- **The program cannot be installed on Windows (Python or Claude Code not found).** The install dialog offers **Install Python with WinGet** and **Install Claude Code with WinGet**; each runs `winget install` per user, without an administrator prompt, when you click it. If the dialog says WinGet is missing, update "App Installer" from the Microsoft Store. A `python.exe` that is only the Microsoft Store's empty alias is not used; install Python with WinGet or from python.org.
- **Claude Code in WSL, Obsidian on Windows.** Not supported (see [Supported environments](../README.md#supported-environments)). Run Obsidian in WSL through WSLg.

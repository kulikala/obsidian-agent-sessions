**English | [日本語](README.ja.md)**

# Agent Sessions

An [Obsidian](https://obsidian.md) plugin that runs [Claude Code](https://claude.com/claude-code), [Codex](https://github.com/openai/codex) and [OpenCode](https://opencode.ai) in terminal tabs next to your notes. It lists your agent sessions in one place, with their state, your usage limits and estimated cost.

![A Claude Code session in a terminal tab, with the side panel listing open, running, and recent Claude Code and Codex sessions](docs/images/overview.png)

## What it does

### The agent runs as its own CLI, in a terminal tab

Each session is the agent's command-line program running in an Obsidian tab, the same program you would run in a terminal. Its slash commands, plan mode, permission prompts, hooks, skills and MCP servers work as usual, with your existing settings and login. File paths in the output that point into the vault open as links, and a button in the tab header inserts the current note as `@path`.

Sessions keep running when you close the tab or quit Obsidian. Reopen one and the last screen is shown again, so you can continue where you left off.

![A Codex session waiting for approval, while a notice reports that a Claude Code session in another tab has finished](docs/images/codex.png)

### Many sessions at once, grouped and labeled by state

- Run several sessions in parallel, with Claude Code, Codex and OpenCode in the same list.
- Each session shows whether it is working, waiting for your answer, finished with a reply you haven't read, or done. The same icon appears in the tab, the side panel and the **Session manager**. A notice tells you when a session in another tab finishes or asks a question.
- Name a session `Category: Name` to group it. The Session manager shows the groups in a sortable table with a status filter (needs input, needs review, running, done, archived).
- **Organize names and categories** suggests a name and category for recent sessions from what was said in them, using one of your installed agents. You review each suggestion, and nothing is renamed until you press **Apply selected**.

![The Session manager: sessions grouped by category with cost per window, and the 5-hour and 7-day usage analytics below](docs/images/manager.png)

![The Organize names and categories dialog, with a suggested category and name for each session](docs/images/organize.png)

### Usage, cost, and an activity calendar

- The 5-hour and 7-day usage windows of each agent, with the time left until reset and a projection of whether you will reach the weekly limit at your current pace. OpenCode has no usage windows.
- Estimated cost per session and per category, and **Session analytics**, a turn-by-turn view of one session's tokens, tool use and cost that can be copied as Markdown. Costs are calculated on your machine from the agents' own transcripts, so they are estimates.
- The **Activity calendar** shows when each agent was working, as blocks per day, by 7-day window, week or day. Click a block to see the prompts in it and open the session.

![The activity calendar: a week of sessions as colored blocks, one lane per agent in each day, with hours and concurrency per agent](docs/images/calendar.png)

### Getting started and everyday use

- A **welcome guide** opens on first install. It checks Python and your agents, installs the helper program after listing what it will write, and has you start a real session, switch tabs, rename it and send a prompt, ticking off each step.
- A **built-in editor** (Ctrl+G) opens the current prompt in a pane under the terminal, with `@` file completion and normal paste, undo and IME input, while the output stays visible.
- **Change model…** switches the model and effort of a running Claude Code session. **Restart session** restarts the agent and continues the same conversation in the same tab, for example after you change its settings or skills.
- Two agent skills are added to the vault, so you can ask an agent about your usage or other sessions, or how to use the plugin.

![The welcome guide](docs/images/welcome.png)

The full feature list is in [`docs/usage.md`](docs/usage.md).

### What it does not do

- It has no chat panel and does not edit the open note inline; the agent works in the terminal tab.
- It is desktop only (not on Obsidian mobile).
- **Change model…** is for Claude Code only, and on Windows only Claude Code is supported.
- OpenCode sub-agent sessions and sessions started with `opencode run` are not listed.

## Privacy

- The plugin does not use the network for its own work. The one exception is the welcome guide, which loads its pictures from GitHub while it is open; a setting turns this off. The agents connect to their own services under your accounts, as they do in a terminal.
- No telemetry, no account. Open source under the MIT license.
- The plugin edits the agents' settings files only to add its own entries (Claude Code's and Codex's are backed up first), and removing the program takes out only those entries.
- The agents have the same permissions as in your own terminal.
- **Organize names and categories** is the only feature that sends session text to a model, through your own agent, and only when you press its button.

The full list of network use, files and programs is in [Disclosures](#disclosures).

## Requirements

- Obsidian 1.8.7 or later, desktop.
- macOS, Linux, or Windows (Windows: Claude Code only).
- Python 3.9 or later; no extra packages. On Windows the install dialog can install it with WinGet.
- At least one of Claude Code, Codex, or OpenCode, installed.

## Install

1. In Obsidian, open **Settings → Community plugins → Browse**, search for **Agent Sessions**, install and enable it.
2. The welcome guide opens. Follow it to install the `agent-sessions` helper program and start your first session. You can close it and come back with **Continue the welcome guide** in the command palette.

Where the program is installed, and installing from source: [`docs/installation.md`](docs/installation.md).

## Supported environments

| Setup | Supported | Verification |
|---|---|---|
| macOS | Yes | Smoke test passed (15 of 15 steps) on macOS 26.6, Python 3.14 |
| Linux (Ubuntu Desktop) | Yes | Smoke test passed on Ubuntu 24.04 (kernel 6.8), Python 3.12 |
| Windows ①: Windows Obsidian + Windows Claude Code | Yes, Claude Code only | Smoke test passed on Windows 11 build 26300, Python 3.13 |
| Windows ②: Windows Obsidian + Claude Code in WSL1 | No | — |
| Windows ③: Windows Obsidian + Claude Code in WSL2 | No | — |
| Windows ④: Linux Obsidian in WSL2 (WSLg) + Claude Code in WSL2 | Expected to work | Not verified; steps in [`docs/testing.md`](docs/testing.md#4-platform--checks) |

The smoke test ran on 2026-10-04 on arm64 virtual machines with Obsidian 1.13.7 and a test agent; what it checks is in [`docs/testing.md`](docs/testing.md). Windows 10 1809 or later should work but has not been tested. On Windows, Codex and OpenCode show "Not available on Windows yet." in the settings.

The plugin and the agent have to run in the same operating system. In ② and ③ the agent's files and processes are inside WSL, where the plugin cannot start or follow the session. If you use the agents in WSL, run Obsidian in WSL too (④). The reasoning is in [`docs/principles.md`](docs/principles.md#4-supported-platforms-are-the-ones-where-agent-and-plugin-share-an-os).

## Troubleshooting

- **"agent-sessions was not found"**: the helper program is not installed yet. Click **Install agent-sessions** in the side panel, or set its location in the plugin's settings if you installed it yourself.
- **An agent is not detected**: set its path in the plugin's settings under the agent, or run **Detect again** in the welcome guide.
- **A session does not pick up changed settings, hooks or skills**: use **Restart session** from the session's ⋯ menu.
- **Windows: Python or Claude Code is missing**: the install dialog offers to install them with WinGet, per user and without an administrator prompt.
- More cases, including hooks that fail with `node: not found`: [`docs/usage.md`](docs/usage.md#more-troubleshooting).

## Uninstall

First open **Settings → agent-sessions program → Remove**. This ends running sessions, removes the entries the program added to the agents' settings and the skills it added to the vault, and deletes the program. Then disable and remove **Agent Sessions** under Community plugins. For a source install, see [`docs/installation.md`](docs/installation.md#uninstall).

## How it works

The plugin bundles a small Python program, `agent-sessions`, as readable source (standard library only) and installs it when you click Install. Its background process (daemon) holds each session's terminal (a PTY; a ConPTY on Windows) and talks to the plugin over a local socket, which is why a session keeps running without a tab or while Obsidian is closed. Session lists, state, usage and cost come from the agents' own transcripts and status files, which are only read, and from hooks and a status line the program adds to the agents. The tab draws the terminal with xterm.js. Design: [`docs/principles.md`](docs/principles.md), [`docs/design.md`](docs/design.md), [`docs/architecture.md`](docs/architecture.md).

## Disclosures

**Network.** The plugin and the program open no network connections for their own work. The plugin talks to its daemon on this machine through a Unix socket (mode 0600); on Windows through `127.0.0.1` on a random port, where a client must first send a secret token. Exception: while the welcome guide is open, its pictures are loaded from GitHub (`raw.githubusercontent.com`, pinned to the plugin's version). No data of yours is sent; GitHub sees your IP address and which picture is requested. Turn this off with **Load the guide's pictures from GitHub** in the settings. Claude Code, Codex and OpenCode connect to their own services under your own accounts.

**Programs it starts.**
- The `agent-sessions` program, with the Python it finds on your machine. The program is written out from the plugin when you click Install; nothing is downloaded.
- The Claude Code, Codex and OpenCode CLIs you have installed (or `ollama launch opencode` if you choose it), and your login shell, to read the same `PATH` as in a terminal.
- On Windows also `reg.exe` (to read `PATH`) and `py.exe` (to find Python), without a console window, and `winget.exe` only when you click an install button.

**Files it reads outside the vault** (to list sessions and calculate usage): `~/.claude/projects/`, `~/.claude/sessions/` and `~/.claude/settings.json`; `~/.codex/` (or `$CODEX_HOME`); OpenCode's database `~/.local/share/opencode/opencode.db` (opened read-only).

**Files it writes outside the vault.**
- `~/.agents/sessions/`: the daemon's socket, logs, status files and caches.
- The program's own folder (`~/.local/share/agent-sessions`, or `%LOCALAPPDATA%\agent-sessions` on Windows; details in [`docs/installation.md`](docs/installation.md#where-the-program-goes)).
- `~/.claude/settings.json`: four hooks and the `statusLine`, after a backup. `~/.claude/keybindings.json`: only if you change the submit key or editor key from the default.
- With Codex enabled, `~/.codex/config.toml`: the submit key, editor key and a default status line, after a backup, each line marked as its own.
- With OpenCode enabled: a status plugin `~/.config/opencode/plugins/agent-sessions.js` and a status line `~/.config/opencode/agent-sessions-tui.jsx`, both marked and overwritten only if they carry the mark; and in `~/.config/opencode/tui.json` the editor key, the submit keys (only if you change the submit key) and the status line entry in its `plugin` list. Your previous `tui.json` values are kept in `~/.agents/sessions/opencode-tui-backup.json` and restored when you turn OpenCode off or remove the program.
- The temporary file the agent hands to the built-in editor.

**Files it writes in the vault.** `<vault>/.agents/sessions/sessions.json` (archive, category colors, folded groups), and, once the program is installed, the `agent-sessions` and `agent-sessions-help` skills in `<vault>/.claude/skills/` (Claude Code) and `<vault>/.agents/skills/` (Codex), which OpenCode also reads, or in `<vault>/.opencode/skills/` when OpenCode is the only agent enabled. Skill files carry an `agent-sessions:managed` mark; files without it are never changed.

**Removal.** **Settings → agent-sessions program → Remove** (or `agent-sessions setup --remove`) takes out the entries and files listed above that it added, puts back your previous OpenCode keybinds, and removes the skills from the vault.

**What Organize sends.** When you press **Suggest** in **Organize names and categories**, the plugin runs one of your agents once: Claude Code (`claude -p`, Sonnet by default, or Haiku in the settings; no tools, no transcript saved), else Codex (`codex exec`, read-only sandbox), else OpenCode (`opencode run`, its stored session deleted afterwards). The dialog names the agent first. For up to 30 sessions (or the one you chose) it sends the folder, the first prompt, the last three prompts you typed and a short excerpt of the last reply, plus your existing category names with up to three example session names each, and, if you ask again, the previous suggestion and your comments. This goes to that agent's service under your account and counts toward its usage limits. Nothing is sent before you press the button.

**Other access.** The vault's file list is read only to complete `@` paths in the built-in editor. The clipboard is used only when you copy a session ID or an analysis table, or press Ctrl+Shift+C / Ctrl+Shift+V in a terminal tab (not on macOS).

## Development

Building, testing, screenshots, adding a language and releasing are in [`docs/development.md`](docs/development.md). Test levels and the manual checklist are in [`docs/testing.md`](docs/testing.md).

## License

MIT, see [`LICENSE`](LICENSE). `plugin/main.js` bundles xterm.js and its addons (also MIT); their notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

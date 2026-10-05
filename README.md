**English | [日本語](README.ja.md)**

# Agent Sessions

An [Obsidian](https://obsidian.md) plugin that runs [Claude Code](https://claude.com/claude-code), [Codex](https://github.com/openai/codex) and [OpenCode](https://opencode.ai) in terminal tabs next to your notes, and lists all your sessions in one place with their state, usage limits and estimated cost.

![A Claude Code session in a terminal tab, with the side panel listing open, running, and recent Claude Code and Codex sessions](docs/images/overview.png)

## Features

- **The agent's own CLI in a tab.** Your settings, login, slash commands, hooks, skills and MCP servers work as in a terminal. Vault paths in the output open as links.
- **Sessions keep running** when you close the tab or quit Obsidian. Reopen one to see its last screen and continue.
- **State at a glance.** Working, waiting for you, unread reply, or done: the same icon in the tab, the side panel and the Session manager. A notice tells you when a session in another tab finishes or asks a question.

![A Codex session waiting for approval, while a notice reports that a Claude Code session in another tab has finished](docs/images/codex.png)

- **Session manager.** Name a session `Category: Name` to group it. Sort, and filter by state.
- **Organize names and categories.** One of your agents suggests a name and category for recent sessions. Nothing is renamed until you apply.

![The Session manager: sessions grouped by category with cost per window, and the 5-hour and 7-day usage analytics below](docs/images/manager.png)

![The Organize names and categories dialog, with a suggested category and name for each session](docs/images/organize.png)

- **Usage and cost.** Each agent's 5-hour and 7-day windows, time to reset, and whether you will reach the weekly limit at your current pace. Estimated cost per session and category, and a turn-by-turn analysis of one session you can copy as Markdown. All calculated on your machine from the agents' transcripts.
- **Activity calendar.** When each agent was working, by 7-day window, week or day. Click a block to see its prompts and open the session.

![The activity calendar: a week of sessions as colored blocks, one lane per agent in each day, with hours and concurrency per agent](docs/images/calendar.png)

- **Built-in editor** (Ctrl+G). Write the prompt in a pane under the terminal, with `@` file completion, normal paste, undo and IME, while the output stays visible.
- **Restart session** picks up changed settings or skills and continues the same conversation. **Change model…** switches a running Claude Code session's model and effort.
- **Welcome guide.** Checks Python and your agents, installs the helper program, and walks you through your first session.
- **Agent skills.** Ask an agent about your usage, your other sessions, or how to use the plugin.

![The welcome guide](docs/images/welcome.png)

All features: [`docs/usage.md`](docs/usage.md).

**Not included:** a chat panel, inline editing of notes, and Obsidian mobile. **Change model…** is for Claude Code only. OpenCode has no usage windows, and its sub-agent sessions and `opencode run` sessions are not listed.

## Requirements

- Obsidian 1.8.7 or later, desktop.
- Python 3.9 or later, no extra packages. It runs the helper program that keeps sessions alive.
- Claude Code, Codex or OpenCode, installed.
- One of the setups below.

## Supported environments

| Obsidian runs on | Agent runs on | Supported |
|---|---|---|
| macOS | macOS | Yes |
| Linux (Ubuntu Desktop) | Linux | Yes |
| Windows 10 (1809+) or 11 | Windows | Claude Code only |
| Windows | WSL | No |
| WSL2 through WSLg | the same WSL distribution | Yes |

Obsidian and the agent must run in the same operating system, because the plugin starts and follows the agent's processes and files. If your agents run in WSL, run Obsidian in WSL through WSLg. Reasoning: [`docs/principles.md`](docs/principles.md#4-supported-platforms-are-the-ones-where-agent-and-plugin-share-an-os).

## Install

1. In Obsidian, open **Settings → Community plugins → Browse**, search for **Agent Sessions**, install and enable it.
2. Follow the welcome guide that opens. It installs the `agent-sessions` helper program and starts your first session. To come back to it later, run **Continue the welcome guide** from the command palette.

Where the program goes, and installing from source: [`docs/installation.md`](docs/installation.md).

## Troubleshooting

- **"agent-sessions was not found"**: click **Install agent-sessions** in the side panel, or set the program's location in the plugin's settings.
- **An agent is not detected**: set its path in the plugin's settings, or click **Detect again** in the welcome guide.
- **A session ignores changed settings, hooks or skills**: choose **Restart session** in the session's ⋯ menu.
- **Windows: Python or Claude Code is missing**: the install dialog installs them with WinGet, per user, without an administrator prompt.
- **A hook fails with `node: not found`**, and other cases: [`docs/usage.md`](docs/usage.md#more-troubleshooting).

## Uninstall

1. **Settings → agent-sessions program → Remove.** This ends running sessions, takes out what the program added (see [Disclosures](#disclosures)), and deletes the program.
2. Disable and remove **Agent Sessions** under Community plugins.

Source installs: [`docs/installation.md`](docs/installation.md#uninstall).

## Disclosures

No telemetry and no account. The agents have the same permissions as in your terminal and connect to their own services under your accounts.

### Network

- The plugin and its program make no network connections for their own work. The plugin talks to the program's background process on this machine: a Unix socket (mode 0600), or on Windows `127.0.0.1` on a random port with a secret token.
- While the welcome guide is open, it loads its pictures from `raw.githubusercontent.com`. No data of yours is sent; GitHub sees your IP address and which picture is requested. Turn this off with **Load the guide's pictures from GitHub** in the settings.

### Programs it starts

- `agent-sessions`, with the Python found on your machine. It is written out from the plugin when you click Install; nothing is downloaded.
- The Claude Code, Codex and OpenCode CLIs you installed (or `ollama launch opencode` if you choose it), and your login shell, to get the same `PATH` as a terminal.
- On Windows: `reg.exe` (to read `PATH`), `py.exe` (to find Python), and `winget.exe` only when you click an install button.

### Files it reads outside the vault

To list sessions and calculate usage:

- `~/.claude/projects/`, `~/.claude/sessions/`, `~/.claude/settings.json`
- `~/.codex/` (or `$CODEX_HOME`)
- `~/.local/share/opencode/opencode.db`, opened read-only

### Files it writes

| Path | Contents | When |
|---|---|---|
| `~/.agents/sessions/` | socket, logs, status files, caches | always |
| `~/.local/share/agent-sessions` (Windows: `%LOCALAPPDATA%\agent-sessions`) | the program | on Install |
| `~/.claude/settings.json` | four hooks, `statusLine` | on Install |
| `~/.claude/keybindings.json` | submit key, editor key | if changed from the default |
| `~/.codex/config.toml` | submit key, editor key, status line | Codex enabled |
| `~/.config/opencode/plugins/agent-sessions.js` | status plugin | OpenCode enabled |
| `~/.config/opencode/agent-sessions-tui.jsx` | status line | OpenCode enabled |
| `~/.config/opencode/tui.json` | editor key, submit keys, status line entry | OpenCode enabled |
| a temporary file | the prompt being edited | built-in editor open |
| `<vault>/.agents/sessions/sessions.json` | archive, category colors, folded groups | always |
| `<vault>/.claude/skills/`, `<vault>/.agents/skills/` | the `agent-sessions` and `agent-sessions-help` skills | on Install |

- `~/.claude/settings.json` and `~/.codex/config.toml` are backed up before they are changed. The previous `tui.json` values are kept in `~/.agents/sessions/opencode-tui-backup.json` and restored on removal.
- Only the plugin's own entries are added or removed. Skill files and OpenCode files carry its mark; files without the mark are never changed.
- When OpenCode is the only agent enabled, the skills go to `<vault>/.opencode/skills/` instead.
- Other folders the program may be installed in: [`docs/installation.md`](docs/installation.md#where-the-program-goes).

### What Organize sends

Nothing is sent until you press **Suggest** in **Organize names and categories**. Then the plugin runs one of your agents once, and the dialog names which:

- Claude Code (`claude -p`, Sonnet, or Haiku in the settings; no tools, no transcript saved), else
- Codex (`codex exec`, read-only sandbox), else
- OpenCode (`opencode run`, its stored session deleted afterwards).

For up to 30 sessions, or the one you chose, it sends the folder, the first prompt, your last three prompts and a short excerpt of the last reply; your existing category names with up to three example session names each; and, if you ask again, the previous suggestion and your comments. This goes to that agent's service under your account and counts toward its usage limits.

### Other access

- The vault's file list: only to complete `@` paths in the built-in editor.
- The clipboard: only when you copy a session ID or an analysis table, or press Ctrl+Shift+C / Ctrl+Shift+V in a terminal tab (not on macOS).

## Development

Build, test, release and design: [`docs/development.md`](docs/development.md).

## License

MIT, see [`LICENSE`](LICENSE). `plugin/main.js` bundles xterm.js and its addons (also MIT); their notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

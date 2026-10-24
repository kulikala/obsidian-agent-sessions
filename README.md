**English | [日本語](README.ja.md)**

# Agent Sessions

**Claude Code, Codex and OpenCode in terminal tabs inside your Obsidian vault.**

[![Release](https://img.shields.io/github/v/release/kulikala/obsidian-agent-sessions?style=flat-square)](https://github.com/kulikala/obsidian-agent-sessions/releases)
[![License](https://img.shields.io/github/license/kulikala/obsidian-agent-sessions?style=flat-square)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?style=flat-square)

[Install](#install) · [Docs](docs/usage.md) · [Troubleshooting](#troubleshooting) · [Disclosures](#disclosures) · [日本語](README.ja.md)

Run [Claude Code](https://claude.com/claude-code), [Codex](https://github.com/openai/codex) and [OpenCode](https://opencode.ai) in terminal tabs inside [Obsidian](https://obsidian.md), next to the notes in your vault.

![A Claude Code session in a terminal tab, with the side panel listing open, running, and recent Claude Code and Codex sessions](docs/images/overview.png)

- **Sessions keep running when you close a tab or quit Obsidian.** A small helper program on your machine, `agent-sessions` (run by Python), keeps them going. ([Programs it starts](#programs-it-starts))
- **An ended session picks up where it left off.** Click it in the side panel, and its conversation continues in a new tab. ([Switch between sessions](#switch-between-sessions-in-the-side-panel))
- **One list shows every session's state, usage and cost.** You see which sessions are running, waiting for you or done. Usage and cost are worked out on your machine from the agents' own files. ([Network](#network))

## Who it is for

For people who have agents write documents, often for several projects at once.

- You use Claude Code or Codex all day, to draft specs, proposals and notes.
- You keep several projects going at once and want to see which session needs you.
- You keep your documents in Obsidian and want its editor next to the terminal.

**Not for** people who want a chat panel or an agent that edits the open note in place (you get the agent's own terminal), people who work only on mobile, or people who want Obsidian on Windows to use agents inside WSL (see [Supported environments](#supported-environments)).

## What Install does

![The Install agent-sessions dialog listing the install folder, Python, the hooks added to Claude Code's settings, and the two agent skills added to the vault](docs/onboarding/en/install.png)

The plugin shows this dialog before it installs anything.

- No telemetry and no account. The plugin connects to the network only for the things listed under [Network](#network).
- The plugin writes four hooks (commands Claude Code runs at set moments) and a status line to `~/.claude/settings.json`, after backing up the file. Through them, Claude Code tells the plugin each session's state and its usage. The hooks apply to all your Claude Code sessions, including ones started outside Obsidian. ([Files it writes](#files-it-writes))
- The plugin adds two agent skills to the vault, so that an agent can answer questions about your sessions, your usage and the plugin. ([Files it writes](#files-it-writes))
- To remove the program and its entries in the agents' settings, the hooks and status line included: **Settings → agent-sessions program → Remove**. ([Uninstall](#uninstall))

## Requirements

- Obsidian 1.8.7 or later, on desktop: macOS, Linux or Windows.
- Python 3.9 or later, with no extra packages. Python runs the helper program.
- Claude Code, Codex or OpenCode, installed and signed in. The agents run on your own subscription or key; the plugin needs no account or key of its own.
- If you have not used any of them, install one from its official page first ([Claude Code](https://claude.com/claude-code), [Codex](https://github.com/openai/codex), [OpenCode](https://opencode.ai)), then come back.

## Supported agents

All three open in tabs and appear in the lists with their state. They differ mainly in the usage figures. Claude Code and Codex subscriptions limit how much you can use in each 5-hour and 7-day window, and the plugin shows how much of each you have used.

| Agent | Opens in a tab | Listed with its state | Usage limits and cost |
|---|---|---|---|
| Claude Code | ✅ Yes | ✅ Yes | ✅ Yes |
| Codex | ✅ Yes | ✅ Yes | ✅ Yes |
| OpenCode | ✅ Yes | ✅ Yes | Cost only |

OpenCode has no 5-hour or 7-day usage limits, so only its cost is shown. Its sub-agent sessions and `opencode run` sessions are not listed.

## Why inside Obsidian

- The agents' key for writing a prompt in an external editor (Ctrl+G by default in this plugin) opens an Obsidian pane instead, with `@` file completion, normal paste and undo, and input methods for languages such as Japanese and Chinese. [More](docs/usage.md#built-in-editor)
- Vault paths in the agent's output open as links.
- A session is an ordinary Obsidian tab, so it sits in a split beside a note.

## Features

### Sessions by category, with usage and cost

The **Session manager** groups sessions by category (a session named `Docs: Release notes` is in Docs) and shows their cost per 5-hour and 7-day window. Below the sessions, each window shows the time until it resets and whether you will reach the limit at your current pace. Costs are estimates. [More](docs/usage.md#session-manager)

![The Session manager: sessions grouped by category with model, effort and cost, and below, the 5-hour and 7-day windows and cost per category](docs/images/manager.png)

### Start a session with any agent

**New session** asks for a name, and for the agent when more than one agent is enabled in the settings. Claude Code, Codex and OpenCode sessions share the same lists. [More](docs/usage.md#start-a-session)

![The New session dialog with Claude Code and Codex to choose from, and the name Docs: Release notes](docs/onboarding/en/new-session.png)

### The agent's own CLI in a tab

Each session is the agent's command-line program in an Obsidian tab, with your settings, login, slash commands, hooks, skills and MCP servers. [More](docs/usage.md#work-in-a-session-tab)

![A Codex session in a terminal tab, asking whether to run a test command](docs/images/codex.png)

### Switch between sessions in the side panel

Open tabs, running sessions without a tab, and recent ones, each with an icon for its state. Click one to bring its tab to the front or open it again; an ended session resumes its conversation. Below the list, a sentence explains the selected session's state. [More](docs/usage.md#switch-between-sessions)

![The side panel: open tabs, running and recent sessions with state icons and categories, and the Needs input and Needs review counts at the top](docs/onboarding/en/side-panel.png)

### And more

- **[Remote Control](docs/usage.md#remote-control-server)**: Claude Code's Remote Control, switched on with the **rc** toggle in the side panel, lets claude.ai and the Claude app start Claude Code sessions in this vault. What it connects to: [Network](#network).
- **[Rename and sort into categories](docs/usage.md#name-and-group-sessions)**: a name like `Docs: Release notes` puts a session in the Docs category.
- **[Names and categories suggested by an agent](docs/usage.md#organize-names-and-categories)**: nothing is renamed until you press **Apply selected**. The agent that makes the suggestions receives session excerpts; see [What Organize sends](#what-organize-sends).
- **[Compact, restart or change model](docs/usage.md#compact-restart-and-change-model)**: from the session's ⋯ menu, compact its conversation to free context, restart the agent, or switch to another model.
- **[Stretch your usage limit](docs/usage.md#stretch-your-usage-limit)**: this does not raise the limit. An agent looks through your recent work for wasted tokens, such as large output left in a conversation or the same files read at the start of every session, and says what to change. Its token statistics are worked out on this machine and stay there; only the analysis you start sends anything. See [What "Stretch your usage limit" sends](#what-stretch-your-usage-limit-sends).
- **[Session analytics](docs/usage.md#session-analytics)**: one session's cost, tokens and turns, with each prompt's own cost.
- **[Activity calendar](docs/usage.md#activity-calendar)**: when each agent was working, shown by 7-day usage window, by week or by day.
- **[Welcome guide](docs/usage.md#welcome-guide)** and two [agent skills](docs/usage.md#agent-skills), which are added to the vault: the guide takes you through setup step by step, and the skills let an agent answer questions about your usage, your other sessions (ended ones too) or the plugin, resume an ended session, find where its session wasted tokens, or name a session.

All features: [`docs/usage.md`](docs/usage.md).

## Supported environments

| Obsidian runs on | Agent runs on | Supported |
|---|---|---|
| macOS | macOS | ✅ Yes |
| Linux | Linux | ✅ Yes |
| Windows 10 (1809+) or 11 | Windows | ✅ Yes |
| Windows | WSL | ❌ No |
| WSL2 through WSLg | the same WSL distribution | ✅ Yes |

Obsidian and the agent must run in the same operating system, because the plugin starts and follows the agent's processes and files. If your agents run in WSL, run Obsidian in WSL through WSLg, and keep the vault in the WSL file system rather than under `/mnt/c`.

## Install

1. In Obsidian, open **Settings → Community plugins**, turn community plugins on if they are off, then choose **Browse**, search for **Agent Sessions**, install and enable it.
2. Follow the welcome guide that opens. It installs the `agent-sessions` helper program and starts your first session. During setup it shows whether Python and each agent were found; if one is missing, see [Requirements](#requirements). To come back to the guide later, run **Continue the welcome guide** from the command palette.

Where the program goes, and installing from source: [`docs/installation.md`](docs/installation.md).

## Troubleshooting

- **"agent-sessions was not found"**: click **Install agent-sessions** in the side panel, or set **agent-sessions location** in the plugin's settings.
- **"Install agent-sessions yourself (see the README)"**: install it from a clone ([`docs/installation.md`](docs/installation.md#from-a-clone)), then set **agent-sessions location** in the plugin's settings to the program in the clone.
- **An agent shows "Not found."**: set the agent's **Executable** in the plugin's settings, or click **Detect again** in the welcome guide.
- **A session ignores changed settings, hooks or skills**: choose **Restart session** in the session's ⋯ menu.
- **Windows: the install dialog says Python or Claude Code is missing**: click **Install Python with WinGet** or **Install Claude Code with WinGet** (per user, no administrator prompt).
- **Windows on ARM: an OpenCode tab stops at `bun:ffi dlopen() is not available in this build (TinyCC is disabled)`**: OpenCode's ARM64 build (the one WinGet installs there) cannot start its terminal UI. Install OpenCode's x64 build instead; Windows runs it under emulation.
- **A hook fails with `node: not found`, or a problem not listed here**: see [`docs/usage.md`](docs/usage.md#more-troubleshooting).

## Uninstall

1. **Settings → agent-sessions program → Remove.** This ends running sessions, removes the program, its entries in the agents' settings, and the skills in the vault, and restores your previous OpenCode `tui.json` values. From `~/.claude/keybindings.json` it removes only the keys the plugin added (`enter`, `meta+enter`, `cmd+enter`, `ctrl+enter`, `shift+enter`, `alt+enter`, `ctrl+q`, `meta+g` and `ctrl+g: null`), and only where the value is still the one the plugin set. A key with another value stays, with a warning. An emptied `Chat` block is removed. It does not bring back a binding you had before, and it does not delete the file.
2. Disable and remove **Agent Sessions** under Community plugins.
3. If you want nothing left, delete `~/.agents/sessions/`, `<vault>/.agents/sessions/`, and the backups `~/.claude/settings.json.bak-*` and `~/.codex/config.toml.bak-*`. Claude Code also leaves empty project folders in `~/.claude/projects/` for the plugin's own runs (see [Files it writes](#files-it-writes)); delete the ones whose names end in `-agents-sessions-organize` or `-agents-sessions-efficiency-run-current`, or contain `agent-sessions-usage-`.

Source installs: [`docs/installation.md`](docs/installation.md#uninstall).

## Disclosures

No telemetry and no account. The plugin itself sends no conversation text anywhere, except when you press **Suggest** in Organize names and categories or **Analyze** in Stretch your usage limit. Remote Control, when you turn it on, works as described under [Network](#network). The agents in your tabs have the same permissions as in your terminal and connect to their own services under your accounts. The agents that Organize and Stretch start have fewer permissions (see [What Organize sends](#what-organize-sends) and [What "Stretch your usage limit" sends](#what-stretch-your-usage-limit-sends)), and Remote Control sessions use the mode you choose.

### Network

- Apart from Remote Control, Claude Code's `/usage`, the welcome guide's pictures and the Windows install buttons, all described below, the plugin and its program make no network connections for their own work. The plugin talks to the program's background process on this machine: a Unix socket (mode 0600, so only your user can open it), or on Windows `127.0.0.1` on a random port with a secret token.
- Remote Control, when you switch it on with the **rc** toggle in the side panel, runs `claude remote-control --spawn=same-dir --permission-mode <mode>` in the vault folder (`same-dir` starts every session in that folder). That Claude Code process stays connected to Anthropic's servers and starts a session in this vault for each connection made from claude.ai or the Claude app by anyone signed in to your Claude account. You choose the mode with **Remote Control permission mode** in the plugin's settings, under Claude Code: default (asks for permission as Claude Code normally does), acceptEdits, plan or auto. The default is auto, where Claude uses tools without asking and Claude Code's classifier (which judges how risky an action is) blocks risky actions; if Claude Code does not accept auto, the sessions run in Claude Code's default mode, which asks for permission. The first time you turn the toggle on, and again the first time after you change the mode to auto, a dialog names the mode, says who can start sessions and, for auto, that Claude uses tools without asking; the server starts only after you confirm. It is off until you click the toggle, and it is never started by loading Obsidian or the plugin. Quitting Obsidian does not stop it, because the program's background process runs the server; switch the toggle off, or use **Remove**, to stop it.
- When Claude Code's status line can't tell your usage windows (you used Claude elsewhere, or a window has just reset), and when you click a usage display to refresh it, the program runs Claude Code's `/usage`, at most once every 5 minutes. Claude Code then asks Anthropic's servers for your account's current usage. It sends no prompt or file and calls no model.
- While the welcome guide is open, it loads its pictures from `raw.githubusercontent.com`. No data of yours is sent; GitHub sees your IP address and which picture is requested. Turn this off with **Load the guide's pictures from GitHub** in the settings.
- On Windows, an install button for Python or Claude Code runs `winget install` for your user only. WinGet downloads the package from its source on the internet. Nothing runs until you click the button.
- A Claude Code session started with Remote Control (`agent-sessions new --remote-control`, run by an agent skill, or resuming a session that was in Remote Control) runs `claude --remote-control=<name>`. That process also stays connected to Anthropic's servers.

### Programs it starts

- `agent-sessions`, with the Python found on your machine. It is written out from the plugin when you click Install; nothing is downloaded.
- `claude remote-control`, only after you click the **rc** toggle.
- `claude -p /usage --no-session-persistence`, while Claude Code is enabled, at most once every 5 minutes, in an empty temporary folder without MCP servers or your user settings. It saves no conversation; see [Network](#network).
- The Claude Code, Codex and OpenCode CLIs you installed, when a session opens, or `ollama launch opencode` if you choose Ollama to launch OpenCode in the settings. The plugin's settings run `ollama list` to offer your Ollama models.
- Your shell, as a login shell and as an interactive shell (which reads `.zshrc` or `.bashrc`), to get the same `PATH` as a terminal. Through the login shell it runs `command -v <agent>` and `npm config get prefix`, to find agents installed with npm.
- `<agent> --version` for each agent, to show its version in the settings, and `codex --help`, to check whether Codex accepts `--no-daemon`.
- `ps`, to see which processes belong to which session. On macOS, `lsof`, to find the files a Codex process has open.
- `rg`, or `grep` if `rg` is missing, to find session names and goals in Claude Code's transcripts.
- On Windows: `reg.exe` (to read `PATH`), `py.exe` (to find Python), `cmd.exe` (to run `.cmd` launcher files such as npm's, and to shorten folder names that contain spaces), and `winget.exe` only when you click an install button.

### Files it reads outside the vault

To list sessions and calculate usage:

- `~/.claude/projects/`, `~/.claude/sessions/`, `~/.claude/settings.json`
- `~/.codex/` (or `$CODEX_HOME`)
- `~/.local/share/opencode/opencode.db`, opened read-only

If `opencode.db` cannot be opened read-only, it is copied, with its `-wal` and `-shm` files, to a temporary folder, read there, and the copy deleted when the program closes it.

These are the default places. The plugin follows `$CLAUDE_CONFIG_DIR` in place of `~/.claude` for `settings.json` and `keybindings.json`, `$XDG_DATA_HOME` for OpenCode's database and `$XDG_CONFIG_HOME` for `~/.config/opencode/`.

For Stretch your usage limit, it also reads:

- The records listed above: Claude Code's transcripts (the conversation files), Codex's rollouts (its session files) and OpenCode's database.
- The sizes of the instruction files each conversation loads first. Claude Code's transcripts record the sizes of `CLAUDE.md`, `.claude/rules/` and auto memory `MEMORY.md` and the number of skills at each session's start, and Codex's rollouts the `AGENTS.md` it loaded. For OpenCode, it reads the size of `AGENTS.md` (or `CLAUDE.md`) in the session's folder and the folders above it up to the Git root, and of `~/.config/opencode/AGENTS.md`.
- The top-level `model` and `model_provider` of `$CODEX_HOME/config.toml` and the model list in `$CODEX_HOME/models_cache.json`, to choose the model for the analysis.
- The providers' `baseURL` in `~/.config/opencode/opencode.json`, to tell which models run on this machine.
- For a file that sessions keep reading, the folders above it, looking for a `.git`, a `CLAUDE.md` or (Codex and OpenCode) an `AGENTS.md`, to tell which instruction file covers it.

### Files it writes

| Path | Contents | When |
|---|---|---|
| `~/.agents/sessions/` | socket, logs, status files, caches | always |
| `~/.local/share/agent-sessions` (Windows: `%LOCALAPPDATA%\agent-sessions`) | the program | on Install |
| `~/.claude/settings.json` | four hooks, `statusLine` | on Install |
| `~/.claude/keybindings.json` | submit key, editor key | if changed from the default |
| `~/.codex/config.toml` | submit and editor keys if changed, status line if unset | Codex enabled |
| `~/.config/opencode/plugins/agent-sessions.js` | status plugin | OpenCode enabled |
| `~/.config/opencode/agent-sessions-tui.jsx` | status line | OpenCode enabled |
| `~/.config/opencode/tui.json` | editor key, submit keys, status line entry | OpenCode enabled |
| a temporary file | the prompt being edited | built-in editor open |
| a temporary folder | a copy of `opencode.db` with its `-wal` and `-shm` files, only if it cannot be opened read-only | while it is read; removed when closed |
| `~/.agents/sessions/efficiency/cache/` | statistics for Stretch your usage limit (numbers and relative paths, no conversation text) | Stretch your usage limit opened |
| `~/.agents/sessions/efficiency/last-<tab>.json`, `prev-<tab>.json` | the last two analyses of each tab in the Stretch dialog (one tab per agent and provider: `claude`, `codex-openai`, `opencode-ollama`, …), with masked quotes | after Analyze |
| `~/.agents/sessions/efficiency-run/current/` | the analysis's empty working folder | during Analyze |
| `<vault>/.agents/sessions/sessions.json` | sessions started here (folder, agent), archive, category colors, folded groups | always |
| `<vault>/.claude/skills/` | the `agent-sessions` and `agent-sessions-help` skills | Claude Code enabled |
| `<vault>/.agents/skills/` | the same skills | Codex enabled |
| `<vault>/.opencode/skills/` | the same skills | only OpenCode enabled |

- `~/.claude/settings.json` and `~/.codex/config.toml` are backed up before they are changed. The previous `tui.json` values are kept in `~/.agents/sessions/opencode-tui-backup.json`.
- The plugin's entries in these files are marked (Codex, OpenCode, skill files) or recognized by their command (Claude Code); nothing else in them is changed. One exception: when the plugin writes `~/.claude/keybindings.json`, it adds `$schema` and `$docs` entries if they are missing and saves the whole file with two-space indentation.
- `sessions.json` travels with the vault if you sync the vault.
- Claude Code keeps an empty project folder under `~/.claude/projects/` (holding at most an empty `memory` folder) for each folder the plugin runs it in, even when no conversation is saved: one for Stretch's working folder, one for Organize's, and a new one for every `/usage` run. The plugin does not delete them; see [Uninstall](#uninstall).
- Other folders the program may be installed in: [`docs/installation.md`](docs/installation.md#where-the-program-goes).

### What Organize sends

Nothing is sent until you press **Suggest** in **Organize names and categories**. Then the plugin runs one of your agents once: Claude Code if it is enabled in the plugin's settings, else Codex, else OpenCode. The dialog names which:

- Claude Code: `claude -p` with Sonnet (or Haiku, in the settings), without tools, nothing saved.
- Codex: `codex exec` in a read-only sandbox, without tools (shell, web search, MCP servers).
- OpenCode: `opencode run` without tools, its stored session deleted afterwards.

For up to 30 sessions, or for the one session you opened it from, it sends the current name, the folder, the first prompt, your last three prompts and a short excerpt of the last reply (the folder, prompts and reply masked in the same way as for Stretch your usage limit, below; the current name and the example session names are sent as they are); your existing category names with their session counts and up to three example session names each; and, if you ask again, the previous suggestion and your comments. The request goes to the agent's service under your account and counts toward that account's usage limits.

### What "Stretch your usage limit" sends

Opening **Stretch your usage limit…** computes statistics on this machine and sends nothing. Only when you press **Analyze** in a tab does the plugin run that conversation's own agent: once, judging all nine checks ([listed in the docs](docs/usage.md#stretch-your-usage-limit)), or, when the range is too large for one request, once per period, one after another, at most ten times. Codex and OpenCode are analysed for the provider their conversations used most; conversations held with another provider are left out.

The range is chosen in this order: the 5-hour usage window, if it is used at least 80%; else the 7-day window, if it is; else the newest calls up to 10,000,000 weighted tokens (input, output and cache tokens weighted to one scale), going back at least 24 hours and at most 7 days. The 80% (50 to 95%) and the 10,000,000 (1,000,000 to 100,000,000) are **Usage limit threshold** and **Budget** in the settings.

- Claude Code: `claude -p` with Sonnet (or Opus, in the settings), without tools, nothing saved.
- Codex: `codex exec` with a read-only sandbox, without tools and no rollout saved, on a model Codex lists for your account (`$CODEX_HOME/models_cache.json`). Sol, Terra and Luna are Codex's three model tiers, named by the end of the model ID (`…-sol`, `…-terra`, `…-luna`): in the newest generation, the plugin takes the Sol model, else Terra, else Luna. If Codex refuses the model, the plugin tries the next of those three, then the next older generation, then the model in `config.toml` (the only one, if the list is missing). A local provider (Ollama, LM Studio) uses its most used model in the range.
- OpenCode: `opencode run` without tools, with the provider and its most used model in the range; the run's session is deleted afterwards. A provider on this machine (Ollama, LM Studio, or a `baseURL` on this machine) is analysed by its local model, so nothing leaves the machine.

A conversation is never sent to another agent or provider, and a tab's statistics name only that provider's sessions. Before you press **Analyze**, **Details** above it shows where the request goes, about how much is sent and in how many requests. **Show what is sent**, inside **Details**, shows the exact text of every request.

What is sent is a digest of every task in the range, in numbers and short excerpts:

- **Sent**: the masked session names and folders, the range's totals, the sizes of the instruction files and the number of skills, and what the statistics noticed. For each turn (one prompt of yours and the agent's work on it): the prompt (up to 600 characters), the start of the agent's reply (200 characters) and the turn's numbers (tokens, tool calls by kind, the paths read, searched or edited, interrupts, pauses, time taken, context size, cache rewrites, models).
- **Not sent**: tool output and file contents.
- **Masked**: paths, URLs (with any user name and password in them), e-mail addresses and anything that looks like a key or token. A path keeps at most its last two parts, or is relative to the vault inside it; a URL keeps its host name. Your home folder and user name are replaced wherever they appear, in a path of any system or as a folder name of their own.
- **Size**: at most 60,000 characters per request. A larger digest is split into requests by period, at most ten; beyond that the prompts are shortened, and then the oldest tasks left out.
- **Savings**: how many tokens a fix could save is worked out by the plugin from the records, not by the agent.
- **Where it runs**: in an empty folder, `~/.agents/sessions/efficiency-run/current/`, made fresh for each run and removed when it ends. Claude Code keeps one empty project folder for it under `~/.claude/projects/`.
- **What stays**: the statistics cache holds no conversation text. The last two results, with their masked quotes, stay in `~/.agents/sessions/efficiency/` until you delete them.
- **Whose account**: unless a local model does the analysis, the request goes to the agent's service under your account and counts toward that account's usage limits.

After an analysis, an issue that a file or setting can fix has **Ask the agent to fix it**. It only starts a new session in the vault, with a request you can read and edit first, set to ask before it changes anything: Claude Code in plan mode (it proposes the change and waits for your approval), Codex with a read-only sandbox that asks before writing, OpenCode with its `plan` agent. The plugin writes no file itself.

### Other access

- The vault's file list: only to complete `@` paths in the built-in editor.
- The clipboard: only when you copy a session ID, an analysis table or the Remote Control connection link, or, except on macOS, press Ctrl+Shift+C / Ctrl+Shift+V in a terminal tab.

## Development

Build, test, release and design: [`docs/development.md`](docs/development.md).

## License

MIT, see [`LICENSE`](LICENSE). `plugin/main.js` bundles xterm.js and its addons (also MIT); their notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

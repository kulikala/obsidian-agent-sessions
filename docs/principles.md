# Design principles

Agent Sessions runs Claude Code, Codex and OpenCode sessions as terminal tabs inside Obsidian. This page lists the principles the design follows. Each one states what is chosen, what is given up (the alternatives that were rejected) and why. Details of the mechanisms are in [`design.md`](design.md), the overview with diagrams in [`architecture.md`](architecture.md), and the testable requirements in [`requirements.md`](requirements.md).

## Contents

1. [A long-lived daemon owns the terminals](#1-a-long-lived-daemon-owns-the-terminals)
2. [Python standard library only, bundled in the plugin](#2-python-standard-library-only-bundled-in-the-plugin)
3. [Agent configuration is touched minimally and reversibly](#3-agent-configuration-is-touched-minimally-and-reversibly)
4. [Supported platforms are the ones where agent and plugin share an OS](#4-supported-platforms-are-the-ones-where-agent-and-plugin-share-an-os)
5. [Local only, read-mostly, and explicit about what leaves the machine](#5-local-only-read-mostly-and-explicit-about-what-leaves-the-machine)
6. [Non-goals](#6-non-goals)

## 1. A long-lived daemon owns the terminals

**Chosen.** A resident process, `agent-sessions daemon`, holds each session's pseudo-terminal (a PTY on macOS and Linux, a ConPTY on Windows) and the agent process behind it. The plugin is a client: a tab attaches to the daemon, receives a replay of the last screen, then streams input and output. Closing a tab, reloading the plugin or quitting Obsidian does not end a session; reopening the tab re-attaches. The plugin starts the daemon on demand.

**Given up.**
- Spawning the agent directly from the plugin (as a child of Obsidian), which is simpler but ties every session to the Obsidian process and loses them on restart or crash.
- Wrapping sessions in `tmux`/`screen`, which adds an external dependency that does not exist on Windows and puts a second terminal emulator between the agent and xterm.js.
- A daemon that restarts sessions from transcripts on demand. The agent's in-flight turn, shell commands and scrollback would be lost.

**Why.** Agent sessions are long: a turn can run for many minutes and a session for days. The user's editor restarts far more often than that, so the terminal must outlive it. A small daemon over a local socket is the least machinery that gives this guarantee on every supported OS, and it keeps the plugin's role to display and interaction. The same split puts all scanning, status detection and cost arithmetic in Python (the CLI, the terminal UI and the plugin read one source of truth), and the processes talk only through files and sockets, never by importing each other.

## 2. Python standard library only, bundled in the plugin

**Chosen.** The program (daemon, CLI, hooks, status line, editor shim) is Python 3.9+ using only the standard library. Its source ships as text inside the plugin's `main.js`; on request the plugin writes it to a per-user directory (the XDG data directory by default; `%LOCALAPPDATA%\agent-sessions` on Windows), together with a launcher whose shebang names the Python it found. The same package also runs from a source checkout. The user needs a Python on the machine; the plugin finds one and, on Windows, can install it with WinGet when the user clicks.

**Given up.**
- Node.js for the daemon. Obsidian's Electron runtime cannot be a long-lived daemon that outlives Obsidian, and relying on a separately installed Node adds the same prerequisite Python does.
- Native modules (`node-pty` and similar). They must be compiled or prebuilt per OS, architecture and Electron ABI, break on Obsidian upgrades, and cannot be shipped through the community plugin channel, which delivers only `main.js`, `manifest.json` and `styles.css`.
- A Python package with pip dependencies or a virtual environment. Hooks and the status line run on every agent event; they must start fast and cannot depend on an environment that drifts from what the plugin expects.
- A compiled single binary, which would need a build and signing pipeline per platform.

**Why.** `pty`, `select`, `socket`, `json`, `sqlite3` and (on Windows) `ctypes` cover everything the program needs. Python is already present on macOS (Command Line Tools) and nearly every Linux, so "no dependencies" means nothing to install beyond the plugin itself. Bundling the source in `main.js` keeps the plugin and the program the same version by construction, and keeps the plugin installable from the normal plugin channel.

## 3. Agent configuration is touched minimally and reversibly

**Chosen.** The program changes only what a feature needs, and only in files the agent already reads:
- Claude Code `settings.json`: the `Stop`, `SessionEnd`, `SessionStart` (matcher `compact`) and `UserPromptSubmit` hooks, and `statusLine`. Entries are recognised by their command (the program's launcher followed by `hook` or `status`), so setup updates only its own entries, leaves everyone else's untouched, and removal deletes exactly those. Before a write that changes the file, a byte-faithful `.bak-<timestamp>` copy is saved.
- The built-in editor: the agent is started with `$VISUAL` pointing at the editor shim; no agent configuration file is edited for it.
- Claude Code `keybindings.json`: only when the user changes the submit key or the editor key away from the default.
- Codex `config.toml`: the submit and editor keys when changed from the default, and a status line when none is set; each line carries the program's mark, and the file is backed up before a change.
- OpenCode, only while it is enabled: a status plugin and a status line file, both marked, and in `tui.json` the editor key, the submit keys when changed, and the status line entry; the previous `tui.json` values are kept and restored on removal.
- The vault: the two skills' files (`SKILL.md`, plus the help skill's `reference.md`) in each enabled agent's project skill folder. A file the program did not write is never overwritten or removed.

**Given up.**
- Setting up everything unconditionally at install time (extra hooks "in case", permission rules, model or environment settings).
- Replacing the user's `statusLine` or hooks wholesale, or keeping a private copy of the agent configuration to point the agent at.
- Wrapping the agent binary in a proxy that injects state, which would change how the agent runs.

**Why.** The agent's configuration is the user's, shared with sessions the plugin never started. A change there has to be small enough to read, safe to repeat, and removable without a trace. Four hook events and the status line carry all the state the plugin needs; the rest is read from files the agent already writes (transcripts and its live-status ledger).

## 4. Supported platforms are the ones where agent and plugin share an OS

**Chosen.** The plugin, the program and the agent must run in the same operating system:

| Setup | Supported |
| --- | --- |
| macOS | yes |
| Linux, including Linux Obsidian under WSLg | yes |
| Windows Obsidian with the agent on Windows (Claude Code, Codex, OpenCode) | yes |
| Linux Obsidian in WSL2 (WSLg) with the agent in the same distribution | yes (it is Linux on both sides) |
| Windows Obsidian with the agent in WSL1 | no |
| Windows Obsidian with the agent in WSL2 | no |

**Given up.**
- Windows Obsidian with the agent in WSL1 or WSL2. The agent runs inside WSL, so its hooks, status line, transcripts, live-status ledger and processes all live on the Linux side. The plugin, running on Windows, cannot start the agent into a ConPTY it owns, observe its files with the same paths and watchers, or re-attach to its processes. Bridging that would mean running a second copy of the program inside WSL and translating paths and process identity in both directions.
- With WSL2 in particular, under its default NAT networking WSL cannot reach Windows' `127.0.0.1`, so the editor round trip (the agent's `$VISUAL` shim connecting back to the plugin) also fails. WSL2's mirrored networking mode might lift this; it is not part of the supported setups.
- The terminal UI and `agent-sessions attach` on Windows (they need `curses` and `termios`). Every other command, the built-in editor included, works there.

**Why.** Each added combination multiplies the places where paths, process ids, sockets and file watchers can disagree, and none of them can be verified cheaply. A small matrix that is actually exercised is worth more than a wide one that mostly works. Where the agent sits on the other side of an OS boundary, the supported way to use it is to run Obsidian on that side: inside WSL, through WSLg.

**Verification.** An automated backend smoke test drives the daemon, CLI and hooks with a fake agent on virtual machines for each supported OS (`tools/smoke`). A short manual UI checklist covers what the smoke test cannot see ([`testing.md`](testing.md)). The Python and TypeScript unit suites run in CI.

## 5. Local only, read-mostly, and explicit about what leaves the machine

**Chosen.**
- **No network use by the plugin or the program, with one exception: the welcome guide's pictures.** Neither opens a connection to a remote host for its own work. While the welcome guide is open, the plugin loads its pictures from GitHub (`raw.githubusercontent.com`), pinned to the plugin's version, as ordinary image requests: no user data is sent, GitHub sees the IP address and which picture is fetched, and no referrer is sent. A setting turns it off. The agent CLIs the plugin launches talk to their own services under the user's own accounts.
- **Local transport only.** The daemon and the plugin's editor server listen on a Unix domain socket (mode 0600, in the user's runtime directory). Windows has no `AF_UNIX` in Python's standard library, so there the "socket path" is a small endpoint file naming a loopback TCP port (`127.0.0.1`, chosen per start) and a random 16-byte token generated per start; a client must send the token first, and any connection that does not is closed.
- **Read-only inputs.** Transcripts, the agents' live-status ledger and OpenCode's database are only read. The agent's settings are written only as described in principle 3. The program's own state lives under `~/.agents/sessions/` and, for the folded groups and categories, a file in the vault.
- **Two paths send session text to a model.** Both run only when the user starts them, and each goes to an agent CLI under the user's own account.
- **"Organize names and categories".** It runs only when the user starts it (from the `⋯` menu for up to 30 recent, non-archived sessions, or from a row's menu for that one session) and presses Suggest, and applies nothing until the user presses Apply. Each entry carries the session id, current name, folder (vault-relative inside the vault, otherwise its name), the first prompt (cut to 300 characters), the last three prompts a person typed (240 each; injected notifications and teammate messages are left out) and the last assistant reply (300). With them go the existing categories: up to 40, each with its session count and up to three example session names. These go on standard input to one headless run of an agent CLI the user has enabled: Claude Code with Sonnet by default (the setting "Model for suggestions" can switch to Haiku; `-p`, no tools, no MCP, no slash commands, hooks disabled, nothing saved), else Codex (`exec`, read-only sandbox, no tools, ephemeral), else OpenCode (`run` as an agent with every tool denied, whose stored session is deleted afterwards). The folder, prompts and reply are masked as the efficiency digest is before they are cut. The run starts in a folder without project instructions, and the dialog names the agent. The excerpts are marked in the prompt as data, not instructions.
- **"Stretch your usage limit…".** Opening it (the `⋯` menu of the side panel or the Session manager, or the command) only computes statistics on this machine: `agent-sessions json efficiency` reads the transcripts and sends nothing. Text leaves the machine only when the user presses Analyze in an agent's pane, and only to that conversation's own agent and provider: Claude Code conversations go to `claude -p` (Sonnet by default, Opus in the setting "Model for the analysis"; no tools, no MCP, no slash commands, hooks disabled, nothing saved), Codex conversations to `codex exec` (read-only sandbox, nothing saved, the newest generation Codex lists for the account, Sol, else Terra, else Luna), OpenCode conversations to `opencode run` with the provider and model they used (its session deleted afterwards); a conversation held with a local model is analysed by that local model, and one pane's statistics name only its own provider's sessions. What is sent is a digest of every task in the range: per task its id, the masked session name and folder, and per turn the user's prompt (up to 600 characters), the first 200 characters of the reply and the turn's numbers (tokens, tool calls by kind, the paths read, searched or edited, interrupts, pauses, elapsed time, context size, cache written again, models); never tool output or file contents. Secrets, e-mail addresses and URL paths are masked, and so are the home folder and the user name in every form: `/Users/<name>`, `/home/<name>`, `C:\Users\<name>` (either separator, any case), WSL's `/mnt/c/Users/<name>` and Claude Code's encoded project folder names (`-Users-<name>-…`) become `~`, and the user name (the login name and the home folder's last part, three characters or more) standing alone between path separators becomes `[user]`. This applies to everything sent: prompts, replies, paths, session names and folders, and the statistics' hints. The statistics' own findings go along as hints, never as the condition of a verdict. One request judges all nine checks; a digest over 60,000 characters is split by period into several requests (at most ten; beyond that prompts are shortened, then the oldest tasks left out), each judging all nine, and the plugin merges their replies in code. The tokens a finding could save are computed by the plugin from the cited tasks' own numbers, never taken from the model's reply. The pane's "Details" show the destination, the total amount, the number of requests and the exact text of every request before anything is sent. Each run starts in an empty folder, `~/.agents/sessions/efficiency-run/current/`, created fresh for the run and removed when it ends (one run at a time; the fixed name means Claude Code keeps a single empty project folder for it); the statistics cache holds no conversation text, so the analysing agent finds none next to it. Fixing a finding starts a new session in the vault, in plan mode (Codex: a read-only sandbox that asks for approval; OpenCode: its `plan` agent), with a request the user sees and can edit; the plugin itself writes no instruction or settings file.

**Given up.**
- Telemetry, update checks and crash reports from the program.
- A cloud service or model API call of the plugin's own. Naming sessions through the user's agent CLI reuses the account and permissions the user already granted that agent, and puts no new credential in the plugin.
- A TCP listener without a token, or one bound beyond loopback, which would let any local user or any machine on the network drive the user's agent sessions.
- Automatic, background naming. It would send session text without a deliberate act.
- Automatic or scheduled analysis by Stretch your usage limit, for the same reason.
- Analysing one agent's conversations with another agent or another provider. A conversation is only ever read by the agent that already had it.

**Why.** The daemon can type into a shell that has the user's full privileges, so reaching it is equivalent to running commands as the user; the transport has to be as private as the OS allows (file permissions on Unix, a secret on Windows, where loopback is shared by all local users). Session transcripts contain code and prompts, so the features that send them are opt-in, bounded in size and visible.

## 6. Non-goals

- A general terminal multiplexer or shell. Sessions are agent sessions; the plugin does not host arbitrary terminals.
- Replacing the agents' own interfaces. The agent runs unmodified in a real terminal; features are layered around it (status, usage, naming, editor), not substituted for it.
- Managing the agent's accounts, models, permissions or MCP servers.
- Running agents remotely, or on a different OS or network namespace from the plugin (see principle 4).
- Obsidian mobile. The plugin is desktop-only (`isDesktopOnly`).
- Syncing or sharing sessions between machines. State is per machine; vault-held metadata is plain files the user's own sync may carry.
- Hosting its own web service, API or account system.
- Bundling or installing the agents. On Windows the install dialog can run WinGet for Python or Claude Code, but only on a click.

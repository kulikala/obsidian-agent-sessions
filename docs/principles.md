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

**Chosen.** A resident process, `agent-sessions daemon`, holds each session's pseudo-terminal (a PTY on macOS and Linux, a ConPTY on Windows) and the agent process behind it. The plugin is a client: a tab attaches to the daemon, receives a replay of the last screen, then streams input and output. Closing a tab, reloading the plugin or quitting Obsidian does not end a session; reopening the tab re-attaches. Only the plugin starts the daemon, on demand.

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
- Claude Code `keybindings.json`: only when the user changes the submit-key setting away from the default.
- Codex and OpenCode: nothing in their user configuration; OpenCode gets a small plugin only while OpenCode is enabled, and it is removed with it.
- The vault: one skill file per enabled agent in the vault's project skill folder. A file the program did not write is never overwritten or removed.

**Given up.**
- Setting up everything unconditionally at install time (extra hooks "in case", permission rules, model or environment settings).
- Replacing the user's `statusLine` or hooks wholesale, or keeping a private copy of the agent configuration to point the agent at.
- Wrapping the agent binary in a proxy that injects state, which would change how the agent runs.

**Why.** The agent's configuration is the user's, shared with sessions the plugin never started. A change there has to be small enough to read, safe to repeat, and removable without a trace. Two hook events and the status line carry all the state the plugin needs; the rest is read from files the agent already writes (transcripts and its live-status ledger).

## 4. Supported platforms are the ones where agent and plugin share an OS

**Chosen.** The plugin, the program and the agent must run in the same operating system:

| Setup | Supported |
| --- | --- |
| macOS | yes |
| Linux, including Linux Obsidian under WSLg | yes |
| ① Windows Obsidian + Windows Claude Code | yes, Claude Code only |
| ④ WSLg Linux Obsidian + WSL2 Claude Code | yes (it is Linux on both sides) |
| ② Windows Obsidian + WSL1 Claude Code | no |
| ③ Windows Obsidian + WSL2 Claude Code | no |

On Windows (①) the settings offer only Claude Code: Codex and OpenCode are disabled there (`agentsSupportedOn("win32")` returns `["claude"]`).

**Given up.**
- ② The agent runs inside WSL, so its hooks, status line, transcripts, live-status ledger and processes all live on the Linux side. The plugin, running on Windows, cannot start the agent into a ConPTY it owns, observe its files with the same paths and watchers, or re-attach to its processes. Bridging that would mean running a second copy of the program inside WSL and translating paths and process identity in both directions.
- ③ Everything in ② applies. In addition, under WSL2's default NAT networking WSL cannot reach Windows' `127.0.0.1`, so the editor round trip (the agent's `$VISUAL` shim connecting back to the plugin) fails. WSL2's mirrored networking mode might lift this; it is untested, so it is not claimed.
- The terminal UI and `agent-sessions attach` on Windows (they need `curses` and `termios`). Every other command, the built-in editor included, works there.

**Why.** Each added combination multiplies the places where paths, process ids, sockets and file watchers can disagree, and none of them can be verified cheaply. A small matrix that is actually exercised is worth more than a wide one that mostly works. Where the agent sits on the other side of an OS boundary, the supported way to use it is to run Obsidian on that side (④).

**Verification.** An automated backend smoke test drives the daemon, CLI and hooks with a fake agent on virtual machines for each supported OS (`tools/smoke`). A short manual UI checklist covers what the smoke test cannot see ([`testing.md`](testing.md)). The Python and TypeScript unit suites run in CI.

## 5. Local only, read-mostly, and explicit about what leaves the machine

**Chosen.**
- **No network use by the plugin or the program.** Neither opens a connection to a remote host. The agent CLIs the plugin launches talk to their own services under the user's own accounts.
- **Local transport only.** The daemon and the plugin's editor server listen on a Unix domain socket (mode 0600, in the user's runtime directory). Windows has no `AF_UNIX` in Python's standard library, so there the "socket path" is a small endpoint file naming a loopback TCP port (`127.0.0.1`, chosen per start) and a random 16-byte token generated per start; a client must send the token first, and any connection that does not is closed.
- **Read-only inputs.** Transcripts, the agents' live-status ledger and OpenCode's database are only read. The agent's settings are written only as described in principle 3. The program's own state lives under `~/.agents/sessions/` and, for the folded groups and categories, a file in the vault.
- **One path sends session text to a model: "Organize names and categories".** It runs only when the user starts it and applies nothing until the user presses Apply. For up to 30 recent, non-archived sessions, each entry carries the session id, current name, folder, the first prompt (cut to 160 characters), the last user prompt (400) and the last assistant reply (300), plus the existing category names. These go on standard input to one headless run of an agent CLI the user has enabled: Claude Code with Haiku by default (`-p`, no tools, no MCP, no slash commands, hooks disabled, nothing saved), else Codex (`exec`, read-only sandbox, ephemeral), else OpenCode (`run`, whose stored session is deleted afterwards). The run starts in a folder without project instructions, and the dialog names the agent. The excerpts are marked in the prompt as data, not instructions.

**Given up.**
- Telemetry, update checks and crash reports from the program.
- A cloud service or model API call of the plugin's own. Naming sessions through the user's agent CLI reuses the account and permissions the user already granted that agent, and puts no new credential in the plugin.
- A TCP listener without a token, or one bound beyond loopback, which would let any local user or any machine on the network drive the user's agent sessions.
- Automatic, background naming. It would send session text without a deliberate act.

**Why.** The daemon can type into a shell that has the user's full privileges, so reaching it is equivalent to running commands as the user; the transport has to be as private as the OS allows (file permissions on Unix, a secret on Windows, where loopback is shared by all local users). Session transcripts contain code and prompts, so the one feature that must send them is opt-in, bounded in size and visible.

## 6. Non-goals

- A general terminal multiplexer or shell. Sessions are agent sessions; the plugin does not host arbitrary terminals.
- Replacing the agents' own interfaces. The agent runs unmodified in a real terminal; features are layered around it (status, usage, naming, editor), not substituted for it.
- Managing the agent's accounts, models, permissions or MCP servers.
- Running agents remotely, or on a different OS or network namespace from the plugin (see principle 4).
- Obsidian mobile. The plugin is desktop-only (`isDesktopOnly`).
- Syncing or sharing sessions between machines. State is per machine; vault-held metadata is plain files the user's own sync may carry.
- Hosting its own web service, API or account system.
- Bundling or installing the agents. On Windows the install dialog can run WinGet for Python or Claude Code, but only on a click.

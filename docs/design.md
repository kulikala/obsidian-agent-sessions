# Agent Sessions design

Requirements are in [`requirements.md`](requirements.md).

## 1. Overview and components

Agent Sessions runs and manages [Claude Code](https://claude.com/claude-code) sessions as terminal tabs inside [Obsidian](https://obsidian.md). Four pieces make up the tool:

- **The daemon** (`agent-sessions daemon`) — a resident process that holds each session's PTY open. Only the plugin starts it.
- **The CLI / `json` output** (the `agent-sessions` binary) — all scanning and aggregation logic lives in Python; the plugin receives JSON and renders it.
- **Hooks and `statusLine`** (`agent-sessions hook` / `agent-sessions status`) — called from Claude Code's `settings.json`, they write state and token usage to files the plugin and CLI read.
- **The plugin** (Obsidian, TypeScript) — the session list, terminal rendering, tab management, restore-on-restart, notifications, and writing `sessions.json`.

Scanning, status detection, and aggregation live only in Python (`agentsessions/`). The plugin displays that JSON, writes `sessions.json`, and renders the PTY as a terminal. This split exists so the CLI, the TUI, and the plugin always see the same session list and the same numbers — there is exactly one place that decides what a session's status is or what a turn cost, and it is not TypeScript.

```
agent-sessions/
├── plugin/                    Obsidian plugin (TypeScript, esbuild, vitest)
│   ├── src/                   Organized by responsibility, the same shape as agentsessions/ below
│   │   ├── main.ts            Plugin entry point: view registration, commands, settings, openSession, sendCommand
│   │   ├── settings.ts        Settings types, defaults, settings tab
│   │   ├── types.ts           Types for `json` output
│   │   ├── i18n.ts            The Japanese/English dictionary and `t()`
│   │   ├── backend/           Calling the CLI/daemon and persisting the plugin's own small state files
│   │   │   ├── backend.ts       Invokes `agent-sessions json …` and types its output
│   │   │   ├── daemon-client.ts Unix socket client (frames, attach, resize)
│   │   │   ├── edit-server.ts   Listens on ~/.agents/sessions/plugin.sock (built-in editor's receiving end)
│   │   │   ├── ui-state.ts      Writes ~/.agents/sessions/ui.json (submit-key symbol, resolved display language)
│   │   │   └── vault-state.ts   Writes ~/.agents/sessions/vault.json (the vault's location, for the CLI/TUI)
│   │   ├── sessions/          Discovering, naming, and tracking the state of sessions
│   │   │   ├── index.ts         SessionIndex: merges scan results, running sessions, and tabs; subscriptions; waitForName
│   │   │   ├── registry.ts      Watches ~/.claude/sessions/*.json (status, pid, rc)
│   │   │   ├── store.ts         Reads/writes/locks <vault>/.agents/sessions/sessions.json
│   │   │   ├── compacted.ts     Watches ~/.agents/sessions/compacted/ (the just-compacted marker)
│   │   │   ├── statusline.ts    Watches ~/.agents/sessions/status/<id>.json
│   │   │   ├── tree.ts          JSON → group tree and the side panel's three sections (pure functions: splitName, OTHER_GROUP, buildManagerTree, buildSideList)
│   │   │   ├── name.ts          Name parsing and the naming dialog's input tokenizer
│   │   │   ├── category.ts      Fixed category colors (palette-index assignment)
│   │   │   ├── open-session.ts  openSession and de-duplication of concurrent calls (a thin, mostly-pure layer)
│   │   │   ├── terminal-status.ts A pure function that decides a tab's single `TerminalStatus`
│   │   │   └── attention.ts     Aggregates "asking"/"waiting" counts (side-panel badge, manager group marks)
│   │   ├── terminal/          Terminal input/output behavior, independent of the `TerminalView` that hosts it
│   │   │   ├── keys.ts          Enter classification, submit-key behavior, non-macOS Ctrl-key classification
│   │   │   ├── keybindings.ts   Reads and rewrites ~/.claude/keybindings.json
│   │   │   ├── links.ts         Path detection in terminal output and vault-relative resolution (pure functions)
│   │   │   ├── marks.ts         Prompt/response marker tracking (pure functions plus a thin xterm-dependent layer)
│   │   │   ├── at-complete.ts   `@`-completion: search-term extraction and replacement (pure functions)
│   │   │   ├── autosave.ts      The built-in editor's autosave debouncer (`SaveDebouncer`)
│   │   │   ├── tui-mode.ts      Whether ~/.claude/settings.json's `tui` is `fullscreen`
│   │   │   └── theme.ts         Obsidian CSS variables → xterm theme
│   │   ├── usage/              Session-analysis results (totals, formatting, the modal)
│   │   │   ├── usage.ts
│   │   │   └── usage-modal.ts
│   │   ├── ui/                 Small DOM-building pieces shared across views
│   │   │   ├── modals.ts        New-session and rename dialogs
│   │   │   └── chip.ts          Category chip rendering, shared by the side panel, manager, and dialogs
│   │   └── views/               `ItemView` subclasses and their DOM-composition helpers
│   │       ├── side.ts          Side panel (skeleton, list rendering, badges)
│   │       ├── side-list.ts     Builds the side panel's three sections (pure function, calls buildSideList)
│   │       ├── manager.ts       Session Manager (skeleton, rendering)
│   │       ├── manager-model.ts Pure functions that flatten the manager's table
│   │       ├── detail.ts        Detail pane (shared by the side panel and the manager)
│   │       ├── limits.ts        5h/7d bars and countdowns
│   │       ├── terminal.ts      The terminal view
│   │       ├── editor-pane.ts   The built-in editor's edit area
│   │       └── rows.ts          Row rendering and the row menu (shared component)
│   ├── test/                  vitest, mirroring src/'s subfolders (pure functions, daemon-client framing, a thin DOM layer)
│   ├── manifest.json          id: agent-sessions / name: Agent Sessions / isDesktopOnly: true
│   ├── styles.css
│   ├── esbuild.config.mjs     → plugin/main.js
│   ├── version-bump.mjs       npm's `version` hook (§21)
│   ├── vitest.config.ts
│   └── package.json
├── bin/agent-sessions          #!/usr/bin/env python3, calls agentsessions.cli.main
├── bin/agent-sessions-code     The built-in editor's $VISUAL entry point (sh; the name contains "code", see §7.4)
├── agentsessions/               Python package (standard library only), organized by responsibility
│   ├── config.py                Path constants (VAULT, STORE_PATH, RUNTIME_DIR, SOCK_PATH, UI_STATE_PATH, …). VAULT has no default; see §3.2
│   ├── i18n.py                  A small message table for CLI/TUI/statusLine strings
│   ├── cli/                     Entry point and subcommand argument parsing
│   │   ├── __init__.py          main(): dispatches to agentsessions.cli.<module>.main(args); `json`'s module is json_cmd (so it doesn't shadow the standard library)
│   │   ├── attach.py daemon.py edit.py hook.py json_cmd.py setup.py status.py   Argument parsing for each subcommand
│   │   └── json_output.py       Builds the `json` subcommand's output
│   ├── daemon/                  The PTY-holding daemon and its wire protocol
│   │   ├── protocol.py          The socket frame format, shared by the daemon and its clients
│   │   ├── server.py            The PTY daemon
│   │   └── client.py            The terminal-attach client (raw mode)
│   ├── sessions/                Discovering and describing sessions
│   │   ├── scan.py              Transcript scanning and name extraction
│   │   ├── cache.py             The scan cache (path → mtime, size, result)
│   │   ├── detail.py            Last user/assistant text, tools used
│   │   ├── live.py              The running-sessions ledger (~/.claude/sessions/*.json)
│   │   ├── store.py             sessions.json (folded groups, archive, category colors); mkdir-based locking
│   │   └── model.py             Session/Row/Doc data shapes and name splitting
│   ├── usage/                   Token/cost aggregation
│   │   ├── turns.py             `json usage` (per-session turn aggregation)
│   │   ├── stats.py             `json stats` (5h/7d window aggregation)
│   │   └── pricing.py           Per-model $/MTok price table and cost calculation
│   ├── claude/                  Integration with Claude Code's own config
│   │   ├── hooks.py             The `hook`/`status` entry points, format_status_line
│   │   ├── setup.py             `setup` (reconciles the hooks and statusLine in settings.json)
│   │   └── keybindings.py       Removes the plugin's own entries from keybindings.json (`setup --remove`)
│   └── tui/
│       ├── app.py               The TUI (select and launch, nothing else)
│       └── items.py             List/panel item building, text wrapping and display width
├── tests/                       Python unittest, mirroring agentsessions/'s subpackages (tests/cli/, tests/daemon/, tests/sessions/, tests/usage/, tests/claude/, tests/tui/; tests for config.py and i18n.py stay at the top level)
├── scripts/
│   ├── install.sh                Creates the symlinks and calls `agent-sessions setup`
│   └── uninstall.sh              Reverses install.sh
├── docs/
├── .github/workflows/           test.yml (CI, §22), release.yml (§21)
├── manifest.json                Copy of plugin/manifest.json (§21)
└── versions.json                Minimum Obsidian version per plugin version (§21)
```

## 2. Processes and responsibilities

| Process | Started by | Responsibility |
|---|---|---|
| The plugin | Obsidian | Session list, terminal rendering, tab management, restore-on-restart, notifications, writing `sessions.json` |
| `agent-sessions daemon` | Only the plugin starts it (with `--detach`, when the socket doesn't respond). The CLI and TUI never start it | Holding PTYs, output buffering, attach/detach, launching and detecting the exit of `claude` |
| `agent-sessions json …` | Spawned by the plugin as needed | Scanning, last-activity, child-session detection, running sessions, recent prompt/response, token aggregation, account-wide statistics |
| `agent-sessions` (TUI) | The user | Pick a session, attach or launch it |
| `agent-sessions hook` / `status` | Claude Code (via `settings.json`) | The hook and statusLine receiving end |
| `agent-sessions setup` | `install.sh`, or run by hand | Reconciles the hooks and `statusLine` in `~/.claude/settings.json` |

## 3. Data and locations

| Location | Contents | Writer |
|---|---|---|
| `<vault>/.agents/sessions/sessions.json` | Folded groups, archive, category colors (below) | The plugin, and `agent-sessions` (TUI, folding only). Written inside the lock in §3.1: read → update → write to a temp file → rename |
| `<vault>/.agents/sessions/sessions.json.lock/` | Mutual exclusion for writes (§3.1) | Whoever is writing |
| `~/.agents/sessions/daemon.sock` | The daemon's socket. Kept outside the vault, since a vault path can run into the `AF_UNIX` path-length limit (104 bytes on macOS, 108 on Linux); directory mode 0700, socket mode 0600 | The daemon |
| `~/.agents/sessions/daemon.pid` / `daemon.log` | The daemon's pid and its own operational log (not session output — see §24) | The daemon |
| `~/.agents/sessions/exited.json` | Exited sessions not yet `forget`-ten (`id → {code, exitedAt}`); written on daemon exit, read on daemon start | The daemon |
| `~/.agents/sessions/status/<session_id>.json` | The JSON `statusLine` receives, written back out verbatim | `agent-sessions status` |
| `~/.agents/sessions/ui.json` | `{submitKey, submitSymbol, language}` — lets `statusLine` show the submit-key symbol and lets the Python side match the plugin's display language (§17) | The plugin (on load, and on every settings save) |
| `~/.agents/sessions/vault.json` | `{"vault": "<path>"}`. Since the vault has no built-in default, this is how code outside Obsidian (the TUI, the CLI) learns where it is; see §3.2 | The plugin (once, on load) |
| `~/.agents/sessions/plugin.sock` | The built-in editor's receiving end (the plugin listens) | The plugin |
| `~/.agents/sessions/events.log` | One hook event per line: `{"event","session_id","transcript_path","ts"}` | `agent-sessions hook` |
| `~/.agents/sessions/scan-cache.json` | The scan cache | `agent-sessions json scan` |
| `~/.agents/sessions/stats-cache.json` | `json stats`'s 10-minute buckets, per-file read offset, and the most recent `message.id`s (for de-duplication) | `agent-sessions json stats` |
| `~/.agents/sessions/compacted/<id>.json` | A marker meaning "just compacted, no prompt sent since" (`{"compactedAt"}`; the plugin only checks whether the file exists) | `agent-sessions hook` (`_update_compacted`) |
| `~/.claude/projects/<p>/<id>.jsonl` | The transcript (the source of truth) | Claude Code (read-only from this project) |
| `~/.claude/sessions/<pid>.json` | The running-session ledger and live status | Claude Code (read-only from this project) |

`sessions.json`:

```json
{
  "version": 1,
  "folded": ["Docs", "その他のセッション"],
  "archived": [{"id": "5778f81f-…", "name": "Release notes", "agent": "claude"}],
  "pendingRenames": {},
  "sessions": {"68d25490-…": {"agent": "claude", "cwd": "/path/to/vault"}},
  "categoryColors": {"Docs": 0, "Infra": 3}
}
```

- `sessions` holds the `agent` and `cwd` of sessions the plugin itself started. A scan's own transcript-derived data takes priority once the transcript exists; this entry exists to show a brand-new session (before its transcript is written) in the list at all.
- `archived`'s `name` is a cached copy for the manager's Archive section; the transcript remains the source of truth.
- `categoryColors` maps a category name (the part of `splitName`'s `Category: Name` split before the colon) to a palette index (0–11). Once assigned, an index never changes (§11).
- `pendingRenames` is read and written back unchanged by both the Python and TypeScript sides; nothing reads it. Renames go through `sendCommand` (§6) directly.

### 3.1 Locking `sessions.json`

The plugin (rename, archive, fold, new session, confirming a category color) and the `agent-sessions` TUI (folding) can write concurrently. A writer takes the lock by `mkdir`-ing `sessions.json.lock/` (Python `os.mkdir`, Node `fs.mkdirSync` — whoever succeeds holds the lock). On `EEXIST` it waits 50ms and retries, giving up with an error after 2 seconds (the plugin shows a `Notice`). A lock whose directory mtime is older than 10 seconds is treated as abandoned and removed with `rmdir` before retrying. Inside the lock: read → update → write to a temp file → rename → `rmdir`. Readers don't take the lock.

### 3.2 Vault resolution

Agent Sessions has no default vault. `agentsessions/config.py`'s `VAULT` (via `_resolve_vault()`, resolved once at import time) is decided in this order: the `AGENT_SESSIONS_VAULT` environment variable → the `vault` field in `~/.agents/sessions/vault.json` → `None` if neither is set. `STORE_DIR`, `STORE_PATH`, and `LOCK_DIR` are `None` too when `VAULT` is `None`, so importing the module never fails just because the vault isn't known yet.

- **The plugin** always sets `AGENT_SESSIONS_VAULT=<this.vaultPath()>` in the `env` it passes both to `agent-sessions json …` (`backend.ts`'s `runJson`, via `envWithVault`) and to the daemon's `start` (`main.ts`, `views/terminal.ts`). The daemon passes `env` straight through to `execvpe` (`daemon/server.py`'s `_op_start`), so `claude` itself and everything it spawns (hooks, statusLine) inherit it too. `vault.json` is written once, in `onload` (the vault doesn't change while Obsidian is running).
- **Python**: `config.require_vault()` returns `VAULT` or raises `VaultNotConfigured` with the message `"Agent Sessions could not find your vault. Enable the Agent Sessions plugin once in Obsidian, or set the AGENT_SESSIONS_VAULT environment variable."` The TUI's entry point (`tui.main()`) calls this before starting `curses`, so a missing vault fails cleanly (exit code 1, a message on stderr) rather than opening a blank screen. `store.load()` returns an empty `Store` when `path` is `None` rather than raising — `json scan` always expects the plugin to supply the env var, but staying alive without it is safer than crashing. `store.save()`/`store.update()` raise `VaultNotConfigured` when `path` is `None`, since silently discarding a write nobody asked for is worse than failing loudly.
- **`install.sh`**: the vault is a required value, either the first argument or `$AGENT_SESSIONS_VAULT`; with neither, it prints usage and exits.

## 4. The daemon and its wire protocol

### 4.1 Why a daemon

Without something holding the PTY open, closing a terminal tab — or reloading Obsidian, which recreates every view — would kill the underlying `claude` process along with it. The daemon is a small resident process, started on demand by the plugin, whose only job is to keep each session's PTY alive independently of any tab or Obsidian instance being attached to it. A tab detaching (closing, or Obsidian restarting) doesn't touch the session; reattaching replays what was missed.

It's a single-threaded `select` loop over the listening socket, every open client connection, and every session's PTY master fd, with no blocking I/O anywhere (sockets and PTYs are non-blocking; each connection's output is flushed from its own queue whenever the socket is writable). `agentsessions/` as a whole — the daemon included — uses only the Python standard library: no dependency to install means the daemon can be launched by a plain `#!/usr/bin/env python3` script with nothing more than a working `python3`, on any machine that has one.

Communication happens over Unix domain sockets (`~/.agents/sessions/daemon.sock`, plus `plugin.sock` for the built-in editor) rather than TCP: both sides always run on the same machine, so a filesystem path is a strictly better address than a port — it can't collide with another process, access control follows filesystem permissions (the containing directory is 0700, the socket itself 0600), and there's nothing to accidentally expose on a network interface.

### 4.2 Sockets and frames

`~/.agents/sessions/daemon.sock`. Both directions share the same frame format:

```
+------+----------------+---------+
| type | length (u32 BE)| payload |
| 1 B  | 4 B            | n B     |
+------+----------------+---------+
```

| type | direction | payload |
|---|---|---|
| `J` | both | JSON (UTF-8): requests, responses, events |
| `D` | both | Raw bytes: client→daemon is PTY input, daemon→client is PTY output |
| `R` | daemon→client | The replay buffer sent right after attach (possibly several frames); replay ends with `{"ev":"replayed"}` |

Requests (`J`, distinguished by `"op"`) and their responses (echoing the same `"seq"`):

| op | arguments | response |
|---|---|---|
| `hello` | `client` (`plugin`/`tui`/`cli`) | `{"ok":true,"version":1,"pid":…}` |
| `list` | — | `{"ok":true,"sessions":[{"id","agent","cwd","pid","startedAt","clients","exited":null or code,"exitedAt"}]}`. Exited sessions stay listed until `forget`-ten |
| `start` | `id`,`agent`,`cwd`,`argv`,`env`,`cols`,`rows` | `{"ok":true}`, or `{"ok":false,"error":"exists"}` if that `id` is already running |
| `attach` | `id`,`cols`,`rows` | `{"ok":true,"exited":null or code}` → `R`… → `{"ev":"replayed"}` → then `D` frames. For an already-exited session, `{"ev":"exit",…}` follows `replayed` immediately. `{"ok":false,"error":"no-session"}` if there is no such session |
| `detach` | — | `{"ok":true}` |
| `resize` | `cols`,`rows` | `{"ok":true}` |
| `kill` | `id`,`signal` (default `TERM`) | `{"ok":true}` |
| `forget` | `id` | Discards an exited session's record and buffer, `{"ok":true}`. `{"ok":false,"error":"running"}` if it's still running |
| `shutdown` | — | `{"ok":true}`, then the daemon exits |

Events (daemon→client, `"ev"`): `exit` (`id`, `code`), `replayed`. A single connection attaches to at most one session at a time; multiple connections (the plugin and the TUI, or two split panes) may attach to the same session — output fans out to all of them, input is accepted from any of them. **The PTY size is the minimum of cols and minimum of rows across every attached connection** (the same rule tmux uses), recomputed on `resize`, `detach`, and disconnect.

Disconnection: if `select` reports the socket readable but `recv` returns empty, or the connection raises `ECONNRESET`/`EPIPE`, it's treated as disconnected — removed from the session's attached connections, `clients` count decremented, size recomputed. This follows the same cleanup path as an explicit `detach`.

### 4.3 Session lifetime

- `start`: `pty.fork()` → the child does `os.chdir(cwd)` then `os.execvpe(argv[0], argv, env)`; the parent sets the initial size with `TIOCSWINSZ`.
- The child's environment is exactly the request's `env` (the daemon's own environment isn't inherited) plus `TERM=xterm-256color`, `COLORTERM=truecolor`, and `AGENT_SESSIONS_ID=<id>`. The plugin builds `env` from three sources: `PATH`, `LANG`, `HOME`, `USER`, `TMPDIR`, and `CLAUDE_CONFIG_DIR` taken from a login shell (`backend.ts`'s `loginEnv`: `$SHELL -l -c env`, run once and cached, falling back to `defaultLoginShell(isMac)` — `/bin/zsh` on macOS, `/bin/sh` on other platforms, since some minimal Linux/WSL2 setups don't have `bash`), so they match what a real terminal would see (Obsidian launched from the Dock, or an equivalent GUI launcher, otherwise inherits a much sparser environment); `VISUAL` (`main.ts`'s `visualPath()`: `~/bin/agent-sessions-code`, or `agent-sessions-code` next to the configured `agent-sessions` path); and `AGENT_SESSIONS_VAULT` (§3.2). `EDITOR` is left untouched.
- Output buffering: a `deque` of chunks per session, capped at 1 MiB total, oldest chunks dropped first. Replay starts at a chunk boundary and is sent in `R` frames of up to 64 KiB. Each connection's send queue is capped at 4 MiB; a client that falls further behind is disconnected.
- On attach: `resize` is applied, then the buffer replays via `R`. If attaching *changed* the PTY size, the row count is reduced by one right after `replayed` and then restored a moment later — this nudges Claude Code into redrawing the bottom of the screen via `SIGWINCH`; when the size didn't change, the replayed screen is already correct as-is.
- Exit detection: EOF or `EIO` on the master fd triggers `waitpid(pid, WNOHANG)`. `SIGCHLD` is also routed through a self-pipe into the `select` loop, to catch the case where a grandchild process still holds the PTY open and EOF hasn't arrived yet. Once detected, every connection attached to that session receives an `exit` event.
- An exited session is **kept until `forget`-ten** (its record and buffer). A background tab that later attaches still gets a replay followed by `exit`, landing on the same exited screen. `forget` is sent by the plugin ("Resume"/"Close") and by the TUI.
- `kill` sends `SIGTERM` to the process group, `SIGKILL` after 10 seconds.
- The daemon itself exits once it has had zero running sessions and zero connections for `idle_exit` seconds (default 600; configurable via `--idle-exit`). On any exit (idle timeout, `shutdown`, `SIGTERM`), it writes **only the sessions that had already exited by that point** (`id`, `code`, `exitedAt`) to `exited.json`, which the next daemon instance reads back on startup and keeps until each one is `forget`-ten (buffers aren't carried over — only the fact that it exited and with what code). Sessions still running when the daemon itself is killed by `SIGTERM` (as part of its own shutdown) aren't recorded there, since that's an external stop, not the session's own exit; they resume normally with `--resume` after a restart. A background tab attaching across a daemon restart still gets `exit` and lands on the exited screen. `exited.json` has no size cap — it doesn't grow unbounded because the plugin sends `forget` for any exited `id` with no open terminal tab, on every `onLayoutReady` and `layout-change` (an `id` that still has a tab is left alone). `SIGTERM` kills every running session before the daemon itself exits. A single daemon instance is guaranteed by `daemon.pid` plus `flock`: a second daemon that fails to acquire the lock exits immediately, and the caller (the plugin) waits one second and reconnects.
- On startup, `~/.agents/sessions/` is created with mode 0700, and the socket is bound under `umask 0077`.

## 5. The `agent-sessions` CLI

| Command | What it does |
|---|---|
| `agent-sessions` | The TUI |
| `agent-sessions daemon [--detach] [--sock PATH] [--runtime-dir DIR] [--idle-exit SEC]` | Starts the daemon. `--detach` double-forks (`setsid`), prints the child's pid, and returns |
| `agent-sessions daemon --running-count [--sock PATH]` | Prints the number of sessions with `exited: null` and returns; never starts the daemon. `0` if the daemon isn't up |
| `agent-sessions daemon --stop [--sock PATH]` | Sends `shutdown` and waits (up to 15s) for the socket to stop responding; a no-op if the daemon wasn't running. Used by `uninstall.sh` to shut the daemon down cleanly before removing files |
| `agent-sessions json scan [--only ID …]` | `{"sessions":[…],"store":{"folded","archived","pendingRenames","sessions"}}`. `--only` re-scans just the listed transcripts, updates the cache, and returns only those |
| `agent-sessions json live` | `{"live":{id:{status,status_label,pid,rc,updated_at,waiting_for?}},"daemon":{"running":bool,"sessions":[…]}}`, merging the running-session ledger (`~/.claude/sessions`) with the daemon's own `list`. `status` is the raw value Claude Code writes (`busy`/`shell`/`idle`/`waiting`/`""`); `status_label` is its display label in the current CLI/TUI language (§17). `waiting_for` is present only when `status` is `waiting`. `running: false` if the daemon isn't up (this never starts it) |
| `agent-sessions json detail ID` | `{"last_user","last_assistant","tools","last_command"}` (`last_command` is the most recent slash command's name, no arguments) |
| `agent-sessions json usage ID [--from ISO] [--to ISO]` | Per-session turn aggregation (§13.1) |
| `agent-sessions json stats` | 5-hour/7-day window aggregation across all sessions (§13.2) |
| `agent-sessions attach ID` | Puts the terminal in raw mode and connects to the daemon's PTY for that session. `Ctrl+\` detaches |
| `agent-sessions edit FILE` | The built-in editor's receiving end (§7.4) |
| `agent-sessions hook` | Appends `{"event","session_id","transcript_path","ts"}` (taken from the JSON on stdin) as one line to `events.log`, and updates the compacted marker (§7.5) |
| `agent-sessions status` | Writes the JSON on stdin to `status/<session_id>.json` and prints one line to stdout — Claude Code's status line (§14) |
| `agent-sessions setup [--dry-run] [--settings PATH] [--keybindings PATH]` | Reads `~/.claude/settings.json` and reconciles `hooks.Stop` (matcher `.*`), `hooks.SessionEnd` (`.*`), `hooks.SessionStart` (matcher `compact` — the compacted marker, §7.5), and `hooks.UserPromptSubmit` (`.*`) to run `"$HOME/bin/agent-sessions" hook` (added if missing, left alone if already present for that event + matcher; a hook whose command runs `bin/cs hook` is rewritten to this command; other tools' hooks are untouched). It sets `statusLine` to `{"type":"command","command":"\"$HOME/bin/agent-sessions\" status"}` when the current value is unset, isn't an object with a string `command`, or is the literal old `bin/cs status` invocation — never based on a loose substring match, so another tool's statusLine (e.g. `ccstatusline`, or one that happens to mention "docs") is left alone even if its command contains "cs". When something changes (and not `--dry-run`), an existing file is first copied to `settings.json.bak-<timestamp>` as an exact byte-for-byte copy (not a re-serialization of the parsed JSON). A `settings.json` that exists but doesn't parse as a JSON object is never silently treated as empty — `setup` stops without writing anything and reports the error (exit code non-zero). Prints what it changed, or `no changes` |
| `agent-sessions setup --remove` | The reverse: removes only the hook entries and statusLine command this project added from `settings.json`, and only the two submit-key entries (`enter`/`meta+enter` under `Chat`) it may have added from `keybindings.json`. A single hook-matcher entry that also has another tool's hooks in it loses only this project's own array element, not the whole entry; an event whose hooks list becomes empty is removed, and so is the `hooks` key itself if nothing is left under it. Other tools' hooks, statusLine, and keybindings entries are always left alone. Writes a backup first, the same way plain `setup` does; if nothing needs removing, nothing is written |

The TUI: a list (groups → named sessions with no category, with no heading → "Other", foldable, `/` to filter, `h` to show the archive) and Enter to open. "Other" (folded by default) holds only nameless, non-child sessions (`tui/items.py`'s `build_items`; the display name is the first 40 characters of the first prompt, or the session id's first 8 characters if there is none). Enter attaches to the daemon if that `id` is already running there (a first `forget` if it had exited), otherwise `execvp`s `claude --resume ID`; the TUI never starts the daemon itself. Folding a group is saved to `folded` inside the §3.1 lock; the fold state of "Other" lives only in the running TUI. There are no management actions (rename, archive, …) in the TUI. Side panel: with `cols >= 60` it's always shown, width `clamp(cols×0.4, 30, 60)`; below that, `p` toggles between the list and panel-only view.

`json scan`'s output (one session):

```json
{"id":"…","agent":"claude","name":"Docs: release notes","group":"Docs","label":"release notes",
 "cwd":"/path/to/project","folder":"project","last_activity":1789400538.7,"child":false,
 "transcript":"/path/to/68d25490-….jsonl"}
```

Scanning (`sessions/scan.py`): transcripts are `~/.claude/projects/*/<uuid>.jsonl`. Names come from one call over every transcript for `custom-title` lines — `rg` if it's on `$PATH`, else `grep` (found via `$PATH`, never a hard-coded path — some environments don't have it at `/usr/bin/grep`, or at all), else transcripts are read directly in Python, line by line; the last matching line in a file wins in every case. The head of each file (up to 2000 lines) yields `cwd`, the first human prompt, and `child` — true when an `agent-setting` line is present, `sessionKind` is `bg`, or the first `entrypoint` seen isn't `cli`. `last_activity` is the timestamp of the last user message or assistant response, found by reading backward from the end of the file (up to 16 MiB; tool-result, meta, and sidechain lines don't count), falling back to the file's mtime.

Caching: `scan-cache.json` holds `path → {mtime,size,head,last_activity}`. A file is skipped when its `mtime` and `size` still match, unless its mtime is within `RACY_WINDOW` of now (§19). A second full scan takes well under 0.1 seconds.

`install.sh` links `~/bin/agent-sessions`, `~/bin/agent-sessions-code`, and `<vault>/.obsidian/plugins/agent-sessions` → `plugin/`. The vault has no default — `$AGENT_SESSIONS_VAULT` if set, otherwise the required first argument; without either, it prints usage and exits. If `plugin/main.js` is missing it suggests running the build. It finishes by calling `agent-sessions setup` with any remaining arguments passed through.

## 6. Sending commands (rename, compact)

`/rename NAME` and `/compact` both go through `main.ts`'s `sendCommand(id, text)` to reach the PTY. The row menu and the dialogs call this one function without caring which path below it takes.

Every path sends the same sequence (`commandBytes`): Ctrl+S (`\x13`, Claude Code's built-in `chat:stash` — stashes a draft if there is one, does nothing otherwise, so it's sent unconditionally) → the command as a **bracketed paste** (`\x1b[200~` + text + `\x1b[201~`; typing it as literal keystrokes would trigger `/` completion and corrupt it) → the submit sequence (`submitSequence()`, §7.2). **The stashed draft is never restored explicitly** — Claude Code restores it on its own after the next submission ("Draft restored").

1. **A tab is open and attached**: write to the PTY from that tab.
2. **No tab, but the daemon has it running**: attach temporarily (120×40), write, detach.
3. **Not on the daemon, or exited** (`forget` first if exited): **start it in the background** — `start` (`--resume`, 120×40) → attach → `registry.waitFor(id, 'idle', 60s)` (waits for the state itself, not a transition, so it works even for an `id` never observed before) → send the command → `waitFor(id, 'busy', 10s)` (catches commands that never go busy) → `waitFor(id, 'idle', 60s)` → send `/exit` the same way → wait up to 30s for `exit` (falling back to `kill`) → detach → `forget` → `rescan([id])`. Progress shows as a `Notice` ("Renaming…"). A timeout raises, and the caller shows it in a `Notice`. The `busy→idle` notification (§12) is suppressed for the duration of this path.

A new, named session follows `start` with the same `waitFor(id,'idle')` → `sendCommand(id, '/rename NAME')`. Both renaming and creating a session fire `SessionIndex.waitForName(id, expected, timeoutMs=5000, intervalMs=300)` right after sending, without waiting for it: it resolves immediately if the name already matches, otherwise rechecks every 300ms (calling `rescan([id])` in between) for up to 5 seconds before giving up silently (worst case, the periodic scan in §10.1 catches up later). `/rename` doesn't invoke the model, so it never goes `busy` and produces no `events.log` entry — without `waitForName`, the tab title would stay stale until the next periodic scan (60 seconds).

Whether the most recent slash command was `/compact` comes from `json detail`'s `last_command`, and disables the row menu's/terminal's "Compress session" action when it was (synchronously, from a cached `detail` — if none is cached yet, the action stays enabled and `compactSession` checks again before sending, showing a `Notice` instead of sending if it turns out to already be compacted).

## 7. The terminal view (`agent-sessions-terminal`)

State (`getState`): `{id, agent, cwd, fontSize?, fresh?}` (`fresh` is true only for a brand-new, not-yet-started session, and clears on the first `start`). Obsidian persists this in the workspace and restores it across restarts.

### 7.1 Connecting, I/O, and sizing

- xterm 5.x: `fontFamily`/`fontSize` from settings (a per-tab `fontSize` takes priority), `lineHeight: 1.0`, `letterSpacing: 0`, `scrollback` from settings (default 5000), `allowProposedApi: true`, `macOptionIsMeta: true`, `cursorBlink: true`. Addons: fit, webgl (falls back to the default canvas renderer on failure), unicode11.
- Padding: the `padding` setting (`comfortable` = 12px / `compact` = 4px / `none` = 0) flows into a CSS variable on the container. `.agent-sessions-terminal-body` is `overflow: hidden`, and `fit()` computes against the area minus padding — `FitAddon` reads the *element's* padding, so the padding lives on the outer wrapper rather than xterm's own parent, keeping the scrollbar out of the padded area.
- Connecting: the first time the `ResizeObserver` reports a non-zero size, `ensureAttached()` runs. If the daemon already has that `id`, it attaches (an exited session replays then immediately shows the exit screen); otherwise it starts one (`argv = [claudePath, '--resume', id]`, or `['--session-id', id]` for a new session). If the daemon can't be reached, it tries to start it, waits one second and reconnects, and shows an error on the exit screen after three failures.
- Output: `D` frames go to `terminal.write(Uint8Array)`. Writes during replay (`R`) are batched, with `scrollToBottom()` once `replayed` arrives.
- Input: `onData`'s string, and `onBinary`, both go out as UTF-8 `D` frames.
- Sizing: `ResizeObserver` → 50ms debounce → `fit()` → `onResize` → `resize`.
- Exit (`exit` event): a "The session has ended (code)" banner appears over the output, with **Resume** and **Close**. Resume is `forget` followed by `start` with `--resume`; Close is `forget` and closing the tab. When the exit follows a failed `--resume`, **Start as new** is offered as well. The same banner area covers the other failure cases: a lost daemon connection offers **Reconnect**; an unreachable daemon, a missing `claude` (with a link to settings), or any other start error offers **Retry**; each also offers **Close**.
- Closing a tab (`onClose`): detaches and closes the connection, disposes xterm. The session itself keeps running. `SessionIndex`, `registry`, `statusline`, and `settings-changed` subscriptions are registered via `this.register(unsubscribe)`, which Obsidian tears down on `onClose`.
- Settings changes: `main.ts` fires `settings-changed` on save, and every open terminal view's `applySettings()` re-applies font, size (a per-tab override if set), padding, and scrollback to xterm and calls `fit()`.
- Header actions (`addAction`): `@` (insert the current note), previous prompt, next prompt, last response. Session-level actions (rename, compress, archive, end, session analysis, copy ID) live in the row menu on the side panel and manager instead. The terminal's own `⋯` (`onPaneMenu`) has Obsidian's standard items (including split right/split down) followed by a separator, then "Rename", "Compress session", "Session analysis", "Copy ID" (archive and end-session stay row-menu-only).

### 7.2 Submit key and Enter

One setting, **submit key** (`enter` default, `shift+enter`, `ctrl+enter`, `alt+enter` (Option), `cmd+enter` — macOS-only, see below for non-macOS). Any other Enter combination becomes a newline. `views/terminal.ts`'s `handleKey` (`attachCustomKeyEventHandler`) intercepts every Enter combination except while composing with an IME (the pure logic lives in `keys.ts`):

- `classifyEnter(ev)`: `passthrough` if it isn't Enter, or during IME composition (`isComposing`/`keyCode 229`). Otherwise classifies the modifier as one of shift/ctrl/alt/cmd (metaKey)/none, in that priority order.
- `resolveEnterAction(cls, submitKey)`: `submit` on a match, otherwise `newline` (or `passthrough` for a non-Enter key or mid-composition).
- `sendSequence(action, submitKey)` (i.e. `submitSequence()`): when `submitKey === 'enter'`, Claude Code's own default applies — submit is `\r`, newline is `\x1b\r`. Any other submit key reverses that in `keybindings.json` (see below), so submit is `\x1b\r` (meta+enter) and newline is `\r`. This is centralized in `sendSubmit()`, which also records the prompt marker (§7.3). Sending a command (§6) and the built-in editor's "Send" (§7.4) use the same function.

Esc stops `keyup` propagation (Obsidian would otherwise steal focus). `Cmd +`/`Cmd -`/`Cmd 0` are the font-size shortcuts; every other Cmd-combination is left to propagate to Obsidian (xterm sends nothing for Cmd-combinations, and blocking them would break Cmd+W/Cmd+P). Ctrl- and Option-combinations, and unmodified keys, go to xterm, with `keydown` propagation stopped so Obsidian's hotkeys don't also see them. Every Enter combination, including Option+Enter, is intercepted by `handleKey`, so it always resolves to either submit or newline per the setting.

`keybindings.json` (under `$CLAUDE_CONFIG_DIR`, not the vault's own `.claude/`) is only touched when `submitKey !== 'enter'`: `Chat.enter` is set to `chat:newline` and `Chat.meta+enter` to `chat:submit` (no other key is touched; `$schema`/`$docs` are added if missing). This is a Claude Code-wide setting, so it also affects `claude` started from any other terminal (the settings tab says so). Reverting to `enter` removes only those two entries. On startup, `reconcileSubmitKey(chatBindings, current)` compares the file's actual state (is Enter remapped to a newline or not) against the current setting (`enter` or not): if they agree, the setting is kept as-is (`shift+enter`/`ctrl+enter`/`alt+enter`/`cmd+enter` can't be told apart just from those two keys); if they disagree, the setting is re-derived with `deriveSubmitKey(chatBindings)` (`enter: chat:newline` plus either `cmd+enter` or `super+enter` present → `cmd+enter`; otherwise → `alt+enter`; no `enter` remap, or `enter: chat:submit` → `enter`). The settings tab re-reads `keybindings.json` every time it opens and offers to reconcile a mismatch. A missing file is treated as "submit"; malformed JSON shows "unreadable" and blocks changes.

Submit-key symbols (`⏎`/`⇧⏎`/`⌃⏎`/`⌥⏎`/`⌘⏎` on macOS, `keys.ts`'s `SUBMIT_KEY_SYMBOLS`) label the "Send" button (e.g. "Send (⌘⏎)") and the statusLine (§14); see below for non-macOS labels and symbols.

#### 7.2.1 Non-macOS key routing

`Platform.isMacOS` (from Obsidian) branches the whole terminal key-handling path. macOS is unchanged from the above.

On other platforms, Obsidian's own hotkey modifier is Ctrl rather than Cmd, and `claude` itself uses Ctrl+C/D/G/R/O/S/L/T and more (a requirement — every key Claude Code uses must reach the terminal). So Ctrl can't simply pass through to Obsidian the way Cmd does on macOS. `keys.ts`'s `classifyCtrlKeyNonMac(ev)` decides where a Ctrl-combination goes (called from `views/terminal.ts`'s `handleKey` only when `!Platform.isMacOS`). The default is **the terminal** (`claude` wins ties), with these exceptions:

| Key | Destination |
|---|---|
| Ctrl+Shift+C | Copies the terminal's selection (`terminal.getSelection()` → `navigator.clipboard.writeText`; does nothing if nothing is selected) — the convention Linux terminal apps use |
| Ctrl+Shift+V | Pastes the clipboard into the PTY (`navigator.clipboard.readText()` → `sendInput`), wrapped in a bracketed paste if `terminal.modes.bracketedPasteMode` is set (same reason as §6: avoid mis-triggering `/` completion) |
| Ctrl+Shift+=/−/0 | Font size (`TerminalView.zoomFont()`, the non-macOS equivalent of Cmd +/−/0) |
| Ctrl+Shift+W | Runs Obsidian's `workspace:close` (closes the tab) |
| Ctrl+Shift+P | Runs Obsidian's `command-palette:open` |
| Ctrl+Shift+<anything else> | Goes to Obsidian (the key event is passed through, not handled) |
| Ctrl+Tab, Ctrl+, | Goes to Obsidian (tab switching, settings — passing the event through is enough, since Obsidian's own default hotkeys already cover these) |
| Any other Ctrl+<key>, **including plain Ctrl+W and Ctrl+P** | Goes to the terminal |

"Goes to Obsidian" means xterm doesn't see it (the handler returns `false`), but `preventDefault`/`stopPropagation` aren't called — the same approach as macOS's Cmd-combinations, letting the native `keydown` reach Obsidian's own hotkey handling (which only does something for combinations Obsidian already binds by default, such as Ctrl+Tab and Ctrl+,). Copy, paste, font size, close-tab, and command-palette are handled directly, so those call `preventDefault`/`stopPropagation` and reach neither xterm nor Obsidian's native handling.

Ctrl+Shift+W and Ctrl+Shift+P exist specifically because plain Ctrl+W and Ctrl+P are reserved for the terminal: Claude Code's own input line uses Ctrl+W for "delete one word" and readline-style input can use Ctrl+P for history, so routing those to Obsidian's close-tab/command-palette would break them inside a session. `views/terminal.ts`'s `runObsidianCommand()` invokes `app.commands.executeCommandById()` (an internal Obsidian API not in its public types, cast the same way `main.ts` casts for `app.setting`) to run `workspace:close`/`command-palette:open` explicitly, since passing the raw key event through wouldn't trigger them — Obsidian's own default hotkeys for those actions are bound to the plain (non-Shift) combinations.

Right-click copy/paste (xterm.js's own `rightClickHandler`/`copyHandler`/`handlePasteEvent`, listening on the element's native `copy`/`paste`/`contextmenu` DOM events) needs no platform branch — it rides the browser's native clipboard events the same way on every platform.

### 7.3 Links, `@`, and jumping

- Links (`links.ts`): via `registerLinkProvider`. A line is scanned for `[\w./~\-]+(?:\.[A-Za-z0-9]+)(?::\d+(?::\d+)?)?` candidates (URLs are skipped); an absolute path inside the vault is made relative, a relative path is resolved against the session's `cwd` and then made vault-relative, and only paths that resolve to a real file (`vault.getAbstractFileByPath`) become links. Clicking opens the file (`openLinkText`) in the main area; a line number moves the cursor there.
- `@` insertion: the command "Agent Sessions: Insert current note as @" and the header's `@` button. `workspace.activeEditor` is `null` while the terminal has focus, so `main.ts` tracks the last `MarkdownView` that was in front via `active-leaf-change`, exposed as `lastMarkdownView()`. The path is relative to the session's `cwd` (absolute if outside it). A multi-line selection appends `#L{from}-{to}`. A path containing spaces is quoted. `@path ` is written to the PTY, and focus moves to the terminal.
- Jumping (`marks.ts`): every time `handleKey` intercepts an Enter that resolves to submit (including the unmodified case) and calls `sendSubmit()`, a prompt marker is recorded (`onData`'s own `\r` doesn't record one, to avoid double-counting a newline that includes `\x1b\r`). A response marker is recorded on the `idle → busy` transition from `registry` (including the case where the very first observation of a session's status is already `busy`), keeping only the most recent one. "Previous prompt" is the nearest marker above the current top of the visible screen; "next prompt" the nearest one below it; "last response" is the response marker. `scrollToLine(marker.line)` does the scrolling. Discarded markers are dropped.
- When `~/.claude/settings.json`'s `"tui"` is `"fullscreen"`, Claude Code redraws the whole screen itself and keeps its own scroll state — nothing accumulates in xterm's scrollback (`buffer.length === rows`). Marker-based jumping doesn't work in that mode, so the three jump buttons send Claude's own scroll keys (PageUp, PageDown, End) instead.

### 7.4 The built-in editor

Claude Code's Ctrl+G calls `$VISUAL` via `spawnSync(cmd, [...args, tmpfile], {stdio:'inherit'})`, waiting for it to exit and re-reading the file on exit code 0 (a non-zero exit or a signal shows "quit unexpectedly" and keeps the original content). An executable whose basename contains `code`, `cursor`, `windsurf`, `codium`, `subl`, `atom`, `gedit`, or `notepad` is treated as a GUI editor and Claude Code skips switching to the terminal's alternate screen buffer (`prepareTerminalForHandoff`). `/memory` uses the same path.

- `bin/agent-sessions-code` (`sh`; `exec "$(dirname "$0")/agent-sessions" edit "$@"`). `install.sh` symlinks it to `~/bin/agent-sessions-code`; its name contains `code` specifically to match the GUI-editor heuristic above. The plugin puts `VISUAL=<its absolute path>` into a session's `start` env (§4.3 — the path must contain no spaces).
- `agent-sessions edit FILE` (`agentsessions/cli/edit.py`) connects to `~/.agents/sessions/plugin.sock` and sends `{"op":"edit","file":FILE,"session":$AGENT_SESSIONS_ID,"cwd":…}`. `{"ok":true}` returns exit code 0; `{"ok":false,"error":"cancel"}` returns 1 (no editor opens; Claude keeps the original content). Any other outcome — `error` of `no-tab` or `busy`, a connection failure, or an unexpected EOF/`ECONNRESET` (including Obsidian crashing) — **falls back to a terminal editor**: `$AGENT_SESSIONS_FALLBACK_EDITOR`, or `vi` if unset, `execvp`'d in the same terminal. It waits indefinitely for a response (Ctrl+C/`SIGTERM` sends `{"op":"cancel"}` and exits 1).
- `edit-server.ts` listens on `~/.agents/sessions/plugin.sock` (unlinking a stale socket on `onload`, closing and unlinking on `onunload`, `chmod 0600` after creation). Frames reuse `daemon-client.ts`'s `encodeFrame`/`FrameDecoder` (`J` only). An `edit` request looks up the terminal view for `session`; none found returns `{"ok":false,"error":"no-tab"}`; otherwise `view.openEditor(file, cwd)` runs and the response reflects send/cancel, then the connection closes. A second `edit` request for a tab already mid-edit gets `{"ok":false,"error":"busy"}`. If the client disconnects first (Claude Code was interrupted), the edit pane closes. If **the tab** closes first (`onClose`, plugin `onunload`, or the socket closing), the original content is written back to the temp file and `cancel` is returned before closing — a single `pendingEdit` field on the view is the source of truth, and every closing path resolves it.
- `views/editor-pane.ts` splits the terminal view's body vertically (top: the rest of xterm; bottom: the edit area). Height is the `editorHeight` setting (default 40%, clamped 10–90%), yielding to the terminal's 8-line minimum; the edit area's own minimum is 4 lines plus its toolbar. Opening/closing re-runs `fit()`. The edit area is a `<textarea>` (native paste, IME, undo; minimal Markdown awareness). Font settings flow in the same way as the terminal (`applySettings(fontFamily, fontSize)`, called on every `settings-changed`), so changes apply live even with the editor open. `.agent-sessions-editor-text` defaults to a slightly looser `letter-spacing: var(--as-editor-letter-spacing, 0.03em)` and `line-height: var(--as-editor-line-height, 1.7)` than the terminal, for readability. Opening it loads the temp file's content, focuses it, and places the cursor at the end. A one-line toolbar shows the filename (basename), "Send (<submit-key symbol>)", and "Back to input (Esc)". Autosave is `autosave.ts`'s `SaveDebouncer` (`schedule`/`flush`/`cancel`, a plain class with no DOM or Obsidian dependency): after 800ms of no typing, it writes to a temp file and renames it into place (an `input` event mid-IME-composition doesn't call `onChanged()`; `compositionend` does, so a save never lands mid-conversion). "Send" and "Back to input" both `flush()` any pending timer and write immediately (a no-op if `text === lastSaved`). "Cancel" (the discard path) only `cancel()`s the timer — `original` is written back separately. A failed autosave write logs to `console.warn` rather than a `Notice`, since it can fire as often as every 800ms.
  - **Send**: if the temp file starts with `claude-prompt-` (a prompt edit), the final content is written and `ok` is returned, then (after a 300ms pause for Claude to read it back) `submitSequence()` is sent to the PTY. Other files (e.g. `/keybindings`) are written but not submitted.
  - **Back to input** (also Esc): writes the current content and returns `ok` without sending — Claude returns to the (non-empty, non-zero-exit) input line as usual.
  - Keys: the submit-key setting sends, any other Enter combination inserts a newline, `Esc` returns to input (or closes an open completion list first). IME composition (`isComposing`/`keyCode 229`) is ignored. Everything else is the textarea's normal behavior. `keydown` propagation is stopped (kept away from Obsidian's hotkeys; Cmd+V/C/X/Z/A stay native). While `pendingEdit` is set, the terminal's own `attachCustomKeyEventHandler` returns `false` for everything and `onData` is discarded (no keys reach the PTY).
  - `@` completion (`at-complete.ts`): the search term updates on non-composing `input` events and on `compositionend`. Typing `@` starts a search term that runs to the next space; a dropdown (up to 8 results) appears below the textarea. Candidates come from `app.vault.getFiles()` filtered with `prepareFuzzySearch`, shown as vault-relative paths. ↑↓ moves the selection, Enter/Tab confirms (replacing `@` through the search term with the vault-relative path from `cwd`, quoted if it contains spaces, plus a trailing space). Esc closes the list without ending the edit. Enter while the list is open confirms rather than submitting.
  - Bracketed paste doesn't apply here (pasting into a plain `<textarea>`).

### 7.5 Tab state and icons

View icons: `layout-dashboard` for the Session Manager, `list-tree` for the side panel (ribbon and sidebar tab). The terminal's icon (base form `square-terminal`) changes with state.

A pure function, `terminalStatus(input)` (`terminal-status.ts`), decides a single `TerminalStatus`:

| State | Condition | Icon | Color / motion |
|---|---|---|---|
| connecting | Mid attach/start | `loader` | Muted, spinning |
| working | `registry` status is `busy` | `loader-circle` | Accent color, spinning |
| running-shell | `registry` status is `shell` (a tool is running a command) | `terminal` | Yellow, blinking (opacity) |
| asking | `registry` status is `waiting` (Claude Code's own value in `~/.claude/sessions/<pid>.json` — AskUserQuestion, a permission prompt, elicitation, a model-switch confirmation, or similar, waiting on a dialog) | `message-circle-question` | Pink, pulsing (scale) |
| waiting | After `busy→idle`, before that tab has been brought to front (unrelated to Claude's own `waiting` status — the names just happen to collide) | `bell-dot` | Orange, pulsing (scale) |
| editing | The built-in editor is open | `pencil-line` | Blue |
| idle | Connected and idle (already seen) | `square-terminal` | Normal |
| detached | The tab exists but isn't connected (after restore, before it's been brought to front) | `square-dashed` | Muted |
| compacted | Just after `/compact` completes (manual or automatic), until the next prompt or the session ends (below) | `archive-restore` | Teal, static |
| exited | `claude` exited | `circle-stop` | Muted |
| error | Can't reach the daemon, `claude` missing, or start failed | `triangle-alert` | Red |

Priority order: error > exited > asking > editing > connecting > running-shell > working > waiting > compacted > detached > idle. Animated states (connecting, working, running-shell, asking, waiting) respect `prefers-reduced-motion`.

A tab's state lives in `plugin.terminalStatuses` (id → state); if several views share an id, the higher-priority one wins. Side-panel and manager rows use this same value when a tab exists, and otherwise the subset derivable from `Row` and `registry` (working/running-shell/asking/compacted/exited/idle/detached). A row's mark is the same icon (`TERMINAL_STATUS_ICON[status]`, `rowStatusMark`), the same shape, color, and motion as the tab (sharing the `agent-sessions-status-<status>` class), with the state name as a tooltip. `asking`/`waiting` rows are additionally highlighted with a background (§8, §10.1).

`asking` is detected without a hook: Claude Code itself writes `status: "waiting"` plus a reason, `waitingFor` (e.g. `"input needed"`, `"permission prompt"`, `"dialog open"`), to `~/.claude/sessions/<pid>.json`. `registry.ts` watches this file and passes the raw value through untouched (`RegistryEntry.waitingFor`, `Row.waitingFor`; `waiting_for` in `json live`). The `Notification` hook (`notification_type` values like `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input`) is a one-shot event that would require reconstructing persistent state and risks being missed entirely, so it isn't used; `status: "waiting"` is itself persistent, so reading it is enough.

`compacted` has no equivalent field in `~/.claude/sessions/<pid>.json`, so it's detected via a hook instead. `SessionStart` carries a `source` (`startup`/`resume`/`clear`/`compact`/`fork`); `compact` covers both a manual `/compact` and automatic context compaction. `PreCompact`, which fires before compaction starts, is one-shot and can't mark "done", so `SessionStart` with `source=compact` (fired once compaction has finished and the session has effectively resumed) is the "enter" signal instead. `agentsessions/claude/hooks.py`'s `_update_compacted(data)`, called from `record_hook`, creates `~/.agents/sessions/compacted/<session_id>.json` (temp file + rename) on `SessionStart`+`source=compact`, and deletes it on `UserPromptSubmit` (the next prompt) or `SessionEnd`. `setup` registers the `SessionStart` hook with matcher `compact` specifically so it doesn't fire on every unrelated startup. The plugin's `CompactedTracker` (`compacted.ts`, the same `fs.watch` + 200ms-debounce shape as `registry.ts`/`statusline.ts`) watches this directory and tracks only file existence, exposed as `has(id)`; `SessionIndex.compactedTracker` feeds into `Row.compacted`.

Since Obsidian 1.7, a tab never brought to front is a deferred view, so its icon and title come from whatever was last saved rather than being computed live. `refreshDeferredTerminalTabs()` (`main.ts`), run on `onLayoutReady`, `layout-change`, and any `index`/`registry` change, writes both `leaf.view.title` (a field `DeferredView` exposes) and the tab-header DOM (`.workspace-tab-header-inner-icon`, `.workspace-tab-header-inner-title`) directly. The icon is `rowTerminalStatus(row)`'s state icon (`detached` if there's no row), with the matching `agent-sessions-status-<status>` class and tooltip. The title is `Row.name`, or `sessionDisplayName` ("Untitled <id8>") if there is none — the same pure function (`name.ts`) that `views/terminal.ts`'s `getDisplayText()` uses, so both agree on the rule.

### 7.6 One session, one tab, and splitting

`openSession(id)` (`open-session.ts`): looks through `workspace.getLeavesOfType('agent-sessions-terminal')` for a leaf whose `view.state.id === id`; if found, `revealLeaf`s it and stops. Otherwise it creates a leaf in the main area (`workspace.getLeaf('tab')`) and calls `setViewState`. A new session follows the same path (writing `sessions.json`'s `sessions[id]` first). Concurrent calls for the same `id` are de-duplicated via `opening: Map<id, Promise<WorkspaceLeaf>>` — a call already in flight for that `id` returns the same promise.

"Split right"/"split down" (the `⋯` menu, `app.workspace.duplicateLeaf(leaf, 'vertical' | 'horizontal')`) and Obsidian's own "Duplicate tab"/"Open in new window" are allowed to create multiple views sharing an `id` — they bypass `openSession` (`TerminalView.setState` doesn't self-close in this case). Each view attaches independently (the daemon's minimum-size rule still applies across them) and detaches independently when closed. A normal open via `openSession` always moves to the existing tab instead, so it never creates a duplicate on its own.

## 8. The side panel (`agent-sessions-side`)

The right sidebar, always present. Four areas laid out as a CSS grid (`auto 1fr <detailHeight> auto`), top to bottom:

1. **Nav row**: `+` (new-session dialog), `layout-grid` (opens the Session Manager in the main area, or reveals it if already open), `⋯` (rescan, open settings). No session-level actions live here.
2. **List** (`views/side-list.ts`; sections have headings, empty sections are omitted):
   - **Open tabs**: sessions with a terminal tab, in tab order. The frontmost tab's row is highlighted. Clicking brings that tab to front. The heading carries a badge with "Needs input N" and "Unread M" items (`attentionCounts`; "needs input" = asking, "unread" = waiting; each omitted at zero), and clicking it opens the first matching session (asking takes priority over waiting). The counts are computed across all three sections together (`attentionCounts(source, [...openTabs, ...running, ...recent])`).
   - **Running**: sessions the daemon holds with no open tab. Clicking opens an attached tab.
   - **Recent**: everything else, most-recently-updated first, up to a setting (default 10). Archived sessions and nameless child sessions are excluded. Clicking opens a `--resume` tab.
   - Row layout: state mark (§7.5's icon/color/motion) + category chip (if any, §11) + name without the category + last-updated + `▣` if a tab exists + `⋯` (always shown). All three sections share this layout. An asking row gets a pale pink background, a 3px left color bar, and a bold name; a waiting row gets a weaker orange background (no bar, not bold). Last-updated is relative — "just now" / "N min ago" / "N h ago" / "yesterday" / "N d ago", and `MM-DD` (no time of day) from a week on — with the absolute `MM-DD HH:MM` in a tooltip; it re-renders once a minute in place (without rebuilding the row). The name column has a `min-width` and never shrinks past it — since it's the only thing on the row that identifies the session, everything else yields first: last-updated hides via a container query once the side panel itself gets narrow, and the other elements (state mark, chip, `⋯`) are already fixed/minimal width.
   - `⋯` opens the row menu: Rename, Compress (disabled if the last command was `/compact`), Archive ⇄ Unarchive, End session (running sessions only), Session analysis, Copy ID (`views/rows.ts`'s `showRowMenu`). Right-click opens the same menu. Clicking, `⋯`, or right-clicking also selects that row (highlight only).
3. **Detail pane** (`views/detail.ts`, §9): a 4px drag handle sits between it and the list above (`mousedown`→`mousemove` updates `sideDetailHeight`, `mouseup` saves it; default 220px, minimum 80px).
4. **Rate limits** (`views/limits.ts`): 5h and 7d bars, usage percentage, and the countdown to reset — `h:mm:ss`, or "N days h:mm" past 24 hours, with no "resets in" label — refreshed every second. `resets_at` missing shows "—". Each row is a fixed-column grid (label, bar, %, countdown) so the bar's rendered width never depends on how wide its neighbors' text is — otherwise the 5h and 7d bars could end up different lengths (e.g. one row's countdown carries a day count and the other doesn't). The source is the most recently modified `status/*.json` file that carries `rate_limits` (account-wide; this assumes one account isn't used concurrently from two places). If the window's reset time has passed but a fresh `rate_limits` hasn't arrived yet, `rollForwardWindow` (the same rule as §10.2's pure function) advances the window so "the current window" is what's shown; since the redraw happens every second and re-evaluates `Date.now()` each time, the display flips over naturally the instant the reset time passes. Clicking the area re-reads the `status/*.json` files immediately rather than waiting for the next automatic refresh (rapid clicks collapse into one, with a brief dimmed/`cursor: progress` state); this doesn't make fresher `rate_limits` values appear, since those are only ever as current as the last time claude's own statusLine hook wrote them — it just re-reads whatever is already on disk.

The side panel subscribes to `workspace`'s `layout-change`/`active-leaf-change`, and to `registry`/`SessionIndex` changes, to re-render.

## 9. The detail view (shared component)

`views/detail.ts` is used by both the side panel and the Session Manager. For a given `Row` (or the frontmost tab's session if none is given):

- A small category chip above the name (if any, §11's colors); the `<h4>` shows only the name, without the category (`categoryAndLabel(row)`, a pure function that splits `row.name` via `splitName`).
- Badges: model, effort (from `statusInfo`; "Default" if unavailable), and rc (a green ● when connected, ○ otherwise or unknown — the same look as §10.1's rc chip).
- A context-usage donut (SVG, `ctxPercent`). If `row.compacted` (§7.5) is true, a small "Compacted" label appears next to it (`.agent-sessions-detail-compacted`), indicating the context was just reset.
- Total tokens and cost: from `json usage`, cached for 60 seconds (`totalTokens` = input + output + cache-read + cache-create; `formatCost` = `$x.xx`).
- The most recent prompt and response (cards, `-webkit-line-clamp: 6`, click to expand), plus recent tools, folder, and ID.

Hovering a row for 300ms also fetches `json detail` (cached) and shows the same content.

## 10. The Session Manager (`agent-sessions-manager`)

The main-area tab, and the default view for a new tab. Opening it never starts a session — **only choosing "New" or clicking a row does.** The manager is the **usage-analysis** view; the side panel is the **current-work** view — a deliberate split of roles.

`buildSkeleton()` builds two stacked sections: **top** (toolbar + body — `.agent-sessions-manager-body`, the table plus the right-hand detail pane, filling the remaining height), **bottom** (analysis — `.agent-sessions-manager-analysis`, §10.3).

### 10.1 The tree, listing, Other, and Archive

The tree order is "groups (headings, foldable) → Other (heading, foldable) → Archive (heading, shown only when the toolbar's "Show archive" is on, always expanded)". Groups are ordered by their most-recently-updated session. Folded state persists in `sessions.json`'s `folded` (expanded by default) (`tree.ts`/`views/manager-model.ts`'s `flattenTree`). Within each section, rows are ordered by last-updated.

- Groups correspond to category names (the part of `splitName` before the colon in `Category: Name`). A group heading is a caret + category chip (§11) + count + that section's combined 5h/7d cost (`categoryTotals`, column-aligned). A real category's heading shows only its chip — never the category name a second time as plain text, since the chip already carries it.
- Named sessions with no category, and sessions with neither a name nor (per `json scan`'s) `child` set, are combined into one "Other" section (`OTHER_GROUP`, the literal persisted string `"その他のセッション"`, shown to users as `t("group.other")`), interleaved by last-updated. Nameless child sessions never appear here either. Every section heading row gets a 4px (`--size-4-1`) top border in the background color, so it never runs into the previous section's last row visually. The fold identifier is `OTHER_GROUP`; a `folded` entry of `__no_category__` (`tree.ts`'s `LEGACY_NO_CATEGORY_GROUP`) also counts as folded.
- Rows inside a group or Other have no chip of their own — the heading already carries the color.
- Sorting by clicking the 5h/7d column headers flattens the tree (no more grouping), and only then does each row carry its own chip, since it's the only remaining color cue.

A group or Other heading gets an urgency mark — the higher-priority of asking/waiting, if either is present anywhere inside it (even folded) — via `urgencyByGroupKey` (`attention.ts`) → `renderGroupUrgencyMark`. The Archive section isn't counted.

Row columns: state mark (§7.5, same icon/color/motion as the tab) · name (chip + name, per the rules above) · last-updated · model · effort · 5h cost · 7d cost · folder · `⋯`. Model and effort show a short form with the full value in a tooltip; unknown values are blank. Row height is at least 32px. Columns are `table-layout: fixed` (mark 24px, last-updated 120px, model 100px, effort 88px, 5h/7d 72px each, folder 160px, `⋯` 28px, name takes the rest) — model/effort/folder are sized so their header text and typical values ("Opus 5.5"/"Sonnet 5", "medium"/"xhigh", a folder name like "obsidian-projects") never clip, so nothing overlaps regardless of the table's overall width. At narrower widths, container queries hide folder (<673px) → effort (<623px) → model (<573px) → 5h (<533px), in that order. Clicking a column header sorts (last-updated = the default grouped tree; 5h/7d cost = a flattened list sorted by that cost, descending). Asking/waiting rows get the same background/bar treatment as §8.

Toolbar: `+`, "Rescan" (`rotate-cw`), a name filter, `⋯` ("Show archive" checkbox). Clicking a row opens it (`openSession(id)`, jumping to an existing tab if one exists). ↑↓ moves the row selection, Enter opens, `/` focuses the filter. A row's `⋯` and right-click open the same row menu as the side panel (`showRowMenu`, §8). The right-hand detail pane is `views/detail.ts` (§9) itself.

Rescan triggers: opening the view, the Rescan button, an `events.log` append (rescanning just that ID via `--only`), a change under `~/.claude/sessions/` (status updates only, no scan), and every 60 seconds while the view is visible. The side panel shares the same scan results (`main.ts` holds one `SessionIndex`, and both views subscribe to it).

### 10.2 Analysis: stat cards and the category bars

The analysis area is a row of stat cards on top, two per-category horizontal bars below (5-hour, then 7-day — the same left-to-right order as the stat cards). Clicking anywhere in the area (other than a category bar row, which scrolls instead — see below) re-fetches `agent-sessions json stats` immediately rather than waiting for the next scheduled fetch (rapid clicks collapse into one, with a `cursor: progress`/dimmed state while the request is in flight). Same trade-off as the side panel's rate-limit view: this re-fetches the aggregation, not the underlying `rate_limits`/transcript data, which only change when claude itself writes new data.

**Stat cards**: two, for the 5-hour and 7-day windows. Each heading is followed by "resets in …" (a countdown). The top row is a usage-percentage bar; below it, a 2×2 labeled mini-table — "Cost $22.90", "Tokens 31.5M", "Calls 142", "Sessions 2" (light labels, bold values), each with a tooltip (e.g. tokens = input + output + cache-read + cache-create, for that window). Numbers come from `agent-sessions json stats` (§13.2). If a window's reset time has passed but a fresh `rate_limits` snapshot hasn't arrived yet, Python's `_roll_forward` (§13.2) has already advanced it to "the current window" server-side, so the card always shows the current one (a rolled-forward window shows "—" for usage percentage, since it isn't known).

**7-day pace projection**: one line under the 7-day card's usage bar (`renderPaceLine`). The pure function `weeklyPace(usedPct, start, end, now, windowCost)` (`views/manager-model.ts`) computes elapsed fraction `e` (how far into the window "now" is) and projects `usedPct / e`. A projection ≤100 shows "On track — about N% by the end of the window at this pace" (green). Above 100, it shows the time it would run out at this pace (`start + elapsed × 100 / usedPct`, formatted "<weekday> HH:MM" via `formatWeekdayTime`) and the margin to reset ("At this pace you'll run out Tue 14:00 (D days H hours before reset)"), plus a second line with a target for the remaining days ("Stay under Z%/day (about $W/day) for the rest of the window" — percentage only if cost can't be computed), in orange. Missing `used_percentage` shows "Usage isn't known"; under 6 hours elapsed shows "Not enough time has passed to project" (too small a sample), both in a muted color. A tooltip carries the elapsed and used percentages. The 5-hour window doesn't show this line (a per-day target isn't meaningful over 5 hours).

**Per-category bars**: one for the 5-hour window and one for the 7-day window — each a horizontal bar per category, the top 8 by cost (any session with no category, named or not, is folded into one "Other" bar via `categoryKeyOf`; values are $ and percentage of that window's total). A real category's fill uses its chip's hue; "Other" is gray (`.is-neutral`). A category at $0 is omitted; if everything is $0, that bar shows "No usage in this window" — the two bars are independent, so one can be empty while the other isn't (e.g. nothing ran in the last 5 hours but the 7-day window has history). Clicking a bar scrolls to and expands that group (its own click handler stops propagation, so it doesn't also trigger the analysis area's click-to-refresh). Both bars call the same pure function, `categoryTotals(rows, stats, window)` (`views/manager-model.ts`), once per window. Laid out side by side (`grid-template-columns: repeat(auto-fit, minmax(260px, 1fr))`, no container query needed) when there's room for both at a readable width, and stacked — 5-hour above 7-day — when there isn't; a vertical divider between them only appears when they're actually side by side (gated by a container query on the pair's own wrapper, not the two bars' individual widths).

### 10.3 Layout, folding, and resizing

The analysis area's heading (caret + "Analysis") toggles folding. A drag handle, matching §8's detail-pane handle, sits between the table and analysis areas (minimum height 120px). Folded state (`managerAnalysisCollapsed`) and height (`managerAnalysisHeight`, default 240px) persist in settings and survive a skeleton rebuild (e.g. a language switch). The handle is hidden while folded.

## 11. Names and categories

**Category** is everything before `: ` in a name (`tree.ts`'s `splitName`, the same rule the TUI and manager groups use). A name with no `: ` has no category.

**Input**: both the new-session and rename dialogs use one combined field (`modals.ts`'s `buildComposedNameField`) for category and name together. A half-width `:` is recognized as a separator the moment it's typed, no trailing space required. A full-width `：` is only recognized once followed by a space (since an IME can produce `：` alone mid-conversion, before the rest of the input lands). The instant a separator is recognized, everything before it (the category text and the separator itself) is removed from the text field and shown instead as a confirmed chip (this also applies to a separator that arrives via paste, through the same `input` event path). Before a separator appears, a dropdown of matching existing categories (`filterCategories`) is shown; ↑↓ moves through it, Enter/Tab confirms the selection (turning it into a chip), Escape closes it. With the name field empty and the cursor at the start, Backspace — or clicking the chip — turns the chip back into text (`tokenizeNameInput` and `filterCategories` are pure functions in `name.ts`). Only the dialog's own button confirms the dialog; Enter in this field confirms a dropdown suggestion, not the dialog.

The resulting name is `Category: Name` (or just `Name` with no category). The rename dialog pre-splits the current name via `splitName` into the chip and the remaining text.

**Color**: each category gets a fixed palette index (0–11; `category.ts`'s `paletteHueDeg(index)` maps it to a hue in 30-degree steps from 0 to 330), recorded in `sessions.json`'s `categoryColors` (§3). `assignCategoryColor(colors, category)`: an already-assigned category keeps its index unchanged; a new one gets the lowest unused index, or — once all 12 are in use — whichever index is used least often (ties go to the lower index). `SessionIndex.categoryColorIndex(category)` returns the confirmed index if there is one, or computes (without writing) what it would be — used for the naming dialog's preview color before a scan confirms it. Every scan, `SessionIndex` runs `ensureCategoryColors` over any category present in the current session list that isn't yet confirmed, writing the results back to `sessions.json` under the lock (a failed lock is swallowed rather than raised, and retried on the next scan).

Chip rendering is centralized in `chip.ts`'s `renderCategoryChip(container, category, colorIndex)`, used identically by the naming dialog, side-panel rows, the manager's headings/rows/category bar, and the detail view (dark theme: `hsl(h 40% 50% / 0.18)` background, `hsl(h 45% 60%)` text; light theme (`.theme-light`): `hsl(h 50% 50% / 0.16)` background, `hsl(h 45% 32%)` text; the category bar's fill uses the same hue, `45% 60%` dark / `45% 32%` light). A chip has no `max-width` or ellipsis — it always shows the full text; only the name beside it (`flex: 1 1 auto`) shrinks to fit.

## 12. State, notifications, and deferred tabs

- `registry.ts`: `fs.watch(~/.claude/sessions)`, debounced 200ms, reads every `*.json` into `sessionId → {status, pid, rc, updatedAt, waitingFor?}` (`rc` reflects whether `bridgeSessionId` is present; `waitingFor` only when `status` is `waiting`). A pid is checked with `process.kill(pid, 0)`; a dead one's ledger entry is ignored.
- On the `busy|shell → idle` transition, if that session's tab isn't in front (or Obsidian itself isn't focused), an 8-second `Notice` appears ("<name>: waiting for input", clicking it calls `openSession`). This can be turned off in settings, and is suppressed for the duration of §6's background-start path.
- All three views subscribe to `registry`/`SessionIndex` changes and update their state marks accordingly (§7.5).
- Exited-session cleanup: on `onLayoutReady` and `layout-change`, any `id` in the daemon's `list` with `exited` set and no open terminal tab gets a `forget`. An `id` that still has a tab is left alone until that tab's Resume/Close sends `forget` itself.
- Deferred-tab name and icon updates: handled by `refreshDeferredTerminalTabs()` as described in §7.5.

## 13. Aggregation

### 13.1 `agent-sessions json usage ID [--from ISO] [--to ISO]`

An `assistant` line's `message.usage` (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`) recurs across several lines sharing the same `message.id`, with identical content. A line whose `message.model` is `<synthetic>` isn't a real API call. Sidechain (sub-agent) and meta lines aren't counted.

`agentsessions/usage/turns.py` reads a transcript from the start and cuts it into turns at each human prompt (`detail.is_human_prompt`); the `assistant` lines that follow accumulate into that turn's usage, de-duplicated by `message.id`. Usage before the first prompt goes into a synthetic pseudo-turn (`index -1`, `before_first: True`, `prompt: ''` — display text for that case is the caller's job; see `usage.beforeFirstPrompt` on the plugin side). Each turn carries `cost` ($, from `usage/pricing.py`), `tools: {name: count}` (`tool_use` blocks in `content`, counted by name, de-duplicated by `message.id`), and `models`. The `total` carries `cost`, `tools`, `duration` (seconds from the first prompt to the last assistant line), `first_ts`, `last_ts`, and `context_last` (the most recent call's `input + cache_read + cache_create`). If any turn has `estimated: true`, so does `total`. `--from`/`--to` filter by a turn's start time (inclusive on both ends). Output: `{"turns":[…],"total":{…},"from","to"}`; each turn is `{index, ts, prompt, calls, input, cache_create, cache_read, output, thinking, cost, tools, estimated, last_ts, context_last, models, before_first}`. `turns` is always the complete list; only `total` reflects the filtered range.

The row menu's "Session analysis" opens a modal (`src/usage/usage-modal.ts`, `width: 90vw; max-width: 1100px`) with a fixed header (title, copy, close), four summary cards (cost; tokens — total input, output below it; turn count; duration), an input bar (cache-read / cache-create / uncached shares, with counts in the legend), an output bar, a tool-use bar (top 12), and a turn table (# · time · prompt (truncated, full text on hover) · input · output · cost). Clicking a row starts a range, another click ends it (highlighting the range), a third click clears it. The cards and bars reflect the selected range, with a "#a–#b" subtitle. Numbers use k/M notation (`usage.ts`'s `formatK`). Range summing and the copyable Markdown rendering are pure functions in `usage.ts` (`sumRange`, `toMarkdown`).

### 13.2 `agent-sessions json stats`

Output: `{"windows":{"five_hour":W,"seven_day":W}}`, where `W = {"start","end","used_percentage","total":{calls,input,output,cache_read,cache_create,cost},"sessions":{id:{calls,input,output,cache_read,cache_create,cost}}}`. `end` is `resets_at` (or the current time if absent); `start` is `end − 5h`/`7d`. `used_percentage` comes from `rate_limits` (`null` if unavailable).

If `end` (`resets_at`) is in the past — right after a reset, before a fresh `rate_limits` has arrived — `_roll_forward(end, used_percentage, duration, now)` advances the window by whole multiples of its length (`math.ceil((now - end) / duration)`, so it copes with being more than one window stale) to produce "the current window"'s `end`. A rolled-forward window sets `used_percentage` to `null`, since the real value won't be known until a fresh `rate_limits` snapshot arrives. `start` follows from the new `end`, so cost aggregation only covers the new window (not the one before it). The side panel's rate-limit view (`views/limits.ts`, §8) reads `status/*.json` directly rather than going through `json stats`, so it carries its own copy of the same rule as a pure function, `rollForwardWindow(w, durationSeconds, now)`.

Aggregation source: `~/.claude/projects/*/*.jsonl` (sidechain lines included; a sub-agent transcript under `<project>/<id>/` is folded into its parent's `id`) with mtime newer than the 7-day window's start. `assistant` lines are de-duplicated by `message.id`, `<synthetic>` excluded, cost from `pricing.cost`.

Caching: per file, 10-minute buckets (`{bucket_start: {calls,…,cost}}`), the last read position (`offset`), and the 200 most recent `message.id`s live in `~/.agents/sessions/stats-cache.json`. A grown file is read from `offset` onward (transcripts are append-only); a shrunk one is read from scratch. Window totals sum from the buckets (10-minute granularity). A corrupted cache (the whole file, or a single entry) is discarded and rebuilt. A second run typically finishes in under a second.

### 13.3 `usage/pricing.py`

`price_of(model) -> {input, output, cache_5m, cache_1h, cache_read, estimated}` ($/MTok). `cost(usage_dict, model) -> float`. Models are matched by longest-prefix:

- `claude-fable-5-1`, `claude-mythos-5-1`: input 10, output 50, cache-read 0.25 (an exception to the pattern below)
- `claude-fable-5`, `claude-mythos-5`: input 10, output 50, cache-read 1.0
- `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`: input 5, output 25, cache-read 0.5
- `claude-opus-4-1`, `claude-opus-4`: input 15, output 75, cache-read 1.5
- `claude-sonnet-5`: input 2, output 10, cache-read 0.2
- `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-sonnet-4`, `claude-3-7-sonnet`: input 3, output 15, cache-read 0.3
- `claude-haiku-4-5`: input 1, output 5, cache-read 0.1
- `claude-3-5-haiku`: input 0.8, output 4, cache-read 0.08
- `claude-3-haiku`: input 0.25, output 1.25, cache-read 0.03

Cache-write cost is input × 1.25 for a 5-minute TTL, input × 2 for a 1-hour TTL (`cache_creation.ephemeral_1h_input_tokens`, if present, uses the 1-hour rate; the rest uses 5-minute). An unrecognized model is priced at the `claude-opus-5` rate with `estimated: true`.

## 14. statusLine

`agent-sessions status` (`hooks.format_status_line`) writes one line for Claude Code's status line:

```
[<submit-key symbol> · ]<model> · <effort> · ctx NN% · rc ●/○
```

- Model is `model.display_name`, or "Default" if unavailable. Effort is `effort.level` (if it's a dict) or `effort` itself (if a string), or "Default" if unavailable.
- `ctx` is `context_window.used_percentage` (rounded), or "—" if unavailable.
- `rc` reflects whether the matching `session_id` in `~/.claude/sessions/*.json` has a `bridgeSessionId` (`live.live_sessions`) — no match, no ledger entry, or not connected all show `○`; only a connected session shows the green `●` (the same rule as the rc badge in the side/manager detail view).
- The submit-key symbol (macOS: `⏎`/`⇧⏎`/`⌃⏎`/`⌥⏎`/`⌘⏎`; other platforms: the shorter `⏎`/`S-⏎`/`C-⏎`/`A-⏎`; `keys.ts`'s `submitKeyStatuslineSymbol(key, isMac)`) is prepended, with a `· ` separator, only when `AGENT_SESSIONS_ID` is set (a session the plugin's daemon started) and `~/.agents/sessions/ui.json` has a `submitSymbol` (written by `plugin/src/backend/ui-state.ts`'s `writeUiState(runtimeDir, submitKey, language, isMac)` on every `onload` and settings save, passing `Platform.isMacOS`). It's omitted whenever `AGENT_SESSIONS_ID` is unset, `ui.json` is missing or unreadable, or `submitSymbol` is absent.

`agent-sessions status` also writes the JSON on stdin, verbatim, to `status/<session_id>.json` (temp file + rename; §3).

## 15. Settings

| Setting | Default |
|---|---|
| Font | macOS: `Menlo, "Hiragino Sans", monospace`. Other platforms: `"DejaVu Sans Mono", "Noto Sans Mono CJK JP", monospace` (`settings.ts`'s `defaultFontFamily(isMac)` — branches only for a fresh install; a saved value is never overridden by a platform default) |
| Font size | 13 |
| Padding | Comfortable (`comfortable`/`compact`/`none`) |
| Submit key | `enter` (§7.2). Backed by `keybindings.json`; five choices on macOS, four on other platforms (`cmd+enter` excluded — see §7.2.1's rationale) |
| Recent count (side panel) | 10 |
| Side panel detail height | 220px (`sideDetailHeight`, minimum 80px) |
| Manager analysis height / folded | 240px / expanded (`managerAnalysisHeight`/`managerAnalysisCollapsed`) |
| Idle notification | On |
| `claude` path | Empty = resolved via a login shell (`$SHELL`, or `defaultLoginShell(isMac)` — `/bin/zsh` on macOS, `/bin/sh` elsewhere) running `command -v claude` |
| `agent-sessions` path | Empty = `~/bin/agent-sessions` |
| Scrollback lines | 5000 |
| Built-in editor height | `editorHeight`, default 40% (10–90%, §7.4) |
| Language | Auto (§17) |

## 16. Theme

`theme.ts` derives `background`/`foreground`/`cursor`/`selectionBackground` from Obsidian's own CSS variables (`--background-primary`, `--text-normal`, `--text-accent`, `--text-selection`). The 16 ANSI colors are a fixed table per light/dark mode. `css-change` triggers re-applying the theme.

## 17. i18n

### 17.1 The plugin (TypeScript)

`manifest.json`'s `description` is always English (`Open and manage Claude Code sessions as terminal tabs in Obsidian.`). The UI itself supports Japanese and English. The language setting has three values: Auto (default — follows `window.localStorage.getItem("language")`: `"ja"` selects Japanese, anything else English), Japanese, English.

`src/i18n.ts` exposes `t(key, vars?)` against `ja`/`en` dictionaries. Every user-facing string — views, menus, dialogs, settings, notifications, modals, tooltips — goes through `t()`. Changing the language fires `settings-changed`, and every view rebuilds its skeleton from scratch.

### 17.2 Python (CLI, TUI, hooks, statusLine)

`agentsessions/i18n.py` provides the same kind of `t(key, **values)` for strings a human actually reads outside the plugin: the TUI screen, CLI stdout/stderr, the statusLine, and the display labels in `json` output (`status_label`, distinct from the raw `status` value — see §5). It intentionally doesn't cover comments, docstrings, or internal log/exception text (nobody reads `daemon.log` or a Python traceback in a chosen language) — those are plain English. It also doesn't use `gettext`/`locale`; the table is small enough that a plain dict is simpler and adds no dependency.

English is the default. The language is chosen in this order:

1. If `AGENT_SESSIONS_ID` is set (a session launched by the plugin's daemon) and `~/.agents/sessions/ui.json` has a `language` of `ja` or `en`, that value — the plugin resolves `auto` to a concrete value before writing it (§17.1), so this matches the plugin's own display language.
2. Otherwise, the first of `LANG`, `LC_ALL`, `LC_MESSAGES` that is set: a value starting with `ja` (case-insensitive) selects Japanese, anything else selects English. With none set, English.

A CLI invocation with no session context (outside a plugin-launched terminal — an interactive `agent-sessions` in a plain shell, for instance) falls straight to step 2, i.e. the shell's own locale. So does `agent-sessions json …` spawned by the plugin (it runs with Obsidian's own environment), which is why `json live` carries both the raw `status` and the display `status_label`.

One Japanese string is deliberately not translated: `OTHER_GROUP`, the literal `"その他のセッション"`, shared by `config.py` and `plugin/src/sessions/tree.ts`. It's persisted as a key in `sessions.json`'s `folded`, so translating it per language would un-fold the group whenever the language changes. Both the TUI (`tui/app.py`'s `_group_label`, mapping `OTHER_GROUP` to `t("tui.other_group")`) and the plugin (`t("group.other")`, §10.1) show a language-appropriate heading rather than this literal — only the persisted identifier itself stays untranslated.

## 18. Error handling

| Situation | Behavior |
|---|---|
| Can't reach the daemon | Tries to start it; after 3 failures, the exit screen shows why (Python missing, socket couldn't be created) |
| `claude` not found | The exit screen shows "claude not found" with a link to settings |
| `--resume` fails (transcript gone) | Shows Claude's own output as-is, with "Start as new" added to the exit screen |
| `json scan` fails | The list keeps its last successful result; a `Notice` shows the first line of stderr |
| `sessions.json` is corrupted | Moved aside to `.broken-<timestamp>` and reinitialized |
| `keybindings.json` can't be read | Settings shows "unreadable"; changes away from `enter` are blocked |
| `sessions.json.lock` can't be acquired in 2 seconds | The write is abandoned with a `Notice`; a lock older than 10 seconds is treated as abandoned and removed |
| Two daemons start at once | The later one fails to `flock` and exits immediately; the plugin waits 1 second and reconnects |
| `exited.json` is corrupted | Moved aside to `.broken-<timestamp>`, the daemon starts with an empty one |
| `stats-cache.json` is corrupted | The affected file (or entry) is discarded and rebuilt |
| WebGL unavailable | Falls back to the canvas renderer (logged only) |

## 19. Platform support

- **macOS**: the primary, fully verified platform.
- **Linux, including Obsidian running under WSLg on Windows**: supported. The daemon, CLI, and their Python-side platform branches are exercised in CI (below) and were additionally verified by hand in `ubuntu:22.04`, `ubuntu:24.04`, and `python:3.10-slim` containers — the daemon's full socket protocol (`start`/`attach`/`resize`/`kill`/`exit`/`shutdown` over a real PTY running `bash`), `bin/agent-sessions`'s shebang and direct execution, `curses` availability for the TUI, and `install.sh`/`uninstall.sh` end to end. A few platform-specific choices exist because of this:
  - `_claude_pids()` (`sessions/live.py`) resolves `ps` via `shutil.which('ps')` rather than assuming `/bin/ps`, and calls it with `-eo pid=,args=` (works on both GNU/procps and BSD `ps`). A minimal environment with no `ps` at all falls back to a plain liveness check (`_alive(pid)`) — the same result, just without the process list.
  - `bin/agent-sessions`'s shebang is `#!/usr/bin/env python3` rather than a hardcoded `/usr/bin/python3`, since some minimal Linux images (e.g. `python:3.10-slim`) only have `python3` at `/usr/local/bin`.
  - `scan()`'s cache trusts a file's `mtime`/`size` to mean "unchanged" — except within `RACY_WINDOW` (2 seconds) of the current time, which it always re-reads regardless of what the cache says. Some Linux filesystems (observed reliably in Docker's default `/tmp`, essentially never on macOS's APFS) coalesce back-to-back writes to nearly the same `mtime`, which would otherwise make an actively-updating transcript look unchanged and return stale cached content — the same failure mode "racy git" addresses for git's own index.
  - The daemon's socket lives under `~/.agents/sessions/` rather than inside the vault partly because `AF_UNIX` path length is capped at 104 bytes on macOS and 108 on Linux, and a vault path can be long.
  - The terminal's key routing, submit-key labels, default font, and default login shell all branch on platform — see §7.2.1 and §15.
  - What hasn't been verified end to end yet: running the Obsidian plugin itself on Linux (including under WSLg) — the terminal keybinding table in particular (§7.2.1) is derived from Claude Code's own key usage and Linux terminal conventions, not from an interactive session on that platform.
- **Windows (native)**: not supported. The daemon depends on `pty`, `fcntl`, and `termios` — all Unix-only standard-library modules with no Windows equivalent — plus a `select.select` loop over both sockets and PTY file descriptors, which Windows' `select` doesn't support for anything but sockets. None of this is a plugin-side restriction that could be worked around; a native Windows build of Obsidian has no PTY to hold open. Running the Linux build of Obsidian under WSL/WSLg avoids the issue entirely, since the daemon then runs under Linux.
- Obsidian desktop only (`isDesktopOnly: true` in `manifest.json`), since the plugin spawns processes and opens Unix sockets — neither is available to a mobile or web build. Minimum Obsidian version 1.7.2 (`minAppVersion`), the version that introduced deferred views (§7.5, §23).
- Python 3.9+, standard library only, resolved via `$PATH` (`python3`).

## 20. Install, uninstall, and setup

`install.sh <vault>` (or `AGENT_SESSIONS_VAULT=<vault> install.sh`, which takes priority over the argument): symlinks `bin/agent-sessions` and `bin/agent-sessions-code` into `~/bin`, symlinks `plugin/` into `<vault>/.obsidian/plugins/agent-sessions`, warns (without failing) if `~/bin` isn't on `$PATH` or `plugin/main.js` hasn't been built, and finishes by calling `agent-sessions setup` (§5) with any remaining arguments to reconcile Claude Code's hooks and statusLine.

`uninstall.sh <vault> [--force] [--purge]`:

1. Checks `daemon --running-count`. With one or more sessions still running, it asks for confirmation (`--force` skips the prompt) before proceeding; aborting leaves everything untouched.
2. `daemon --stop` (a no-op if the daemon isn't running).
3. `agent-sessions setup --remove` (§5) — removes only this project's own hook entries, statusLine, and the two submit-key `keybindings.json` entries; other tools' entries are always left alone.
4. Removes the `~/bin/agent-sessions`, `~/bin/agent-sessions-code`, and `<vault>/.obsidian/plugins/agent-sessions` symlinks. A path that exists but isn't actually a symlink (replaced by hand) is left in place, with a note.
5. Only with `--purge`: also deletes `~/.agents/sessions/` (or `$AGENT_SESSIONS_RUNTIME_DIR` if set — the same variable `agent-sessions daemon` reads for its default `--runtime-dir`) and `<vault>/.agents/sessions/` — daemon runtime state and session bookkeeping (folded groups, archive, category colors), respectively.

Both scripts are `#!/bin/sh` (POSIX, checked with `dash -n`/`sh -n`) and safe to run more than once — running either again when there's nothing left to do just reports that.

## 21. Release process

The plugin version lives in `plugin/manifest.json`, mirrored at the repo root (`manifest.json`) and tracked per-version in `versions.json` (the minimum Obsidian version each plugin release requires). `cd plugin && npm version <patch|minor|major>` runs `plugin/version-bump.mjs` as npm's `version` hook: it writes the new version into `plugin/manifest.json`, copies that file to the repo root (the review bot and BRAT only read the root copy), and — only if the version is new — records `{version: minAppVersion}` in the root `versions.json`. The hook then `git add`s all three files so they land in npm's version commit. `plugin/.npmrc` sets `tag-version-prefix=""`, so the git tag `npm version` creates is the bare version number (e.g. `0.1.1`, not npm's default `v0.1.1`) — exactly matching `manifest.json`'s `version`, which Obsidian's release tooling expects.

Pushing the resulting tag runs `.github/workflows/release.yml` (on any tag): it checks out the repo, runs `npm ci` and `npm run build` in `plugin/` (Node 20), and creates a **draft** GitHub Release for that tag with `main.js`, `manifest.json`, and `styles.css` attached. A maintainer reviews and publishes the draft by hand — nothing here publishes automatically.

## 22. Testing and CI

- **Python** (`unittest`, run with `-W error`, under `tests/`, mirroring `agentsessions/`'s subpackages): `daemon/protocol` (frame splitting/joining), `daemon/server` (`cat` as a stand-in child process for start/attach/replay/resize/kill/forget, the buffer cap, multiple connections and minimum-size negotiation, disconnect cleanup, attaching to an exited session, `exited.json` round-tripping), `daemon/client` (the terminal-attach client), `sessions/store`'s locking (two processes writing concurrently; `categoryColors` round-tripping; `path=None` — no vault configured — making `load` return empty while `save`/`update` raise `VaultNotConfigured`), `claude/setup` (both directions: the settings.json rewrite/backup, `SettingsUnreadable`, and `run_remove`'s selective removal), `claude/keybindings` (the removal side only — see §17.2/§7.2), `cli/daemon` (`--running-count`/`--stop` against a real daemon), `sessions/cache`, `cli/json_output` (the `status`/`status_label` split, `waiting_for` only when applicable), `sessions/live` (`waiting`/`waiting_for`/labels), `usage/pricing` (each price tier, the 1-hour cache rate, unknown models), `usage/turns` (cost, tools, duration, `before_first`), `usage/stats` (windows, buckets, de-duplication, `_roll_forward`'s single- and multi-window-stale cases and their boundaries), `claude/hooks` (`format_status_line`, the submit-key symbol, `_update_compacted`'s write/remove), `config` (`_resolve_vault`'s priority order, `require_vault`), `sessions/model`, `sessions/scan` (including the racy-mtime re-read rule and the `rg`/`grep`/pure-Python fallback chain), `sessions/detail` (including `last_command`), `tui/items` (the TUI's grouping, wrapping, display width), `tui/app` (the early exit with no vault configured, the persisted `OTHER_GROUP` heading's translated label), `cli/edit` (a fake socket server: `ok:true`→0, `cancel`→1, `no-tab`/`busy`→fallback, unreachable/EOF→fallback).
- **TypeScript** (`vitest`, under `plugin/test/`, mirroring `src/`'s subfolders — `test/backend/`, `test/sessions/`, `test/terminal/`, `test/usage/`, `test/views/`; `i18n` and `settings` stay at the top level, matching `i18n.ts`/`settings.ts`): `tree`, `manager-model` (`flattenTree`, selection movement, sorting, `categoryTotals`, `weeklyPace`, `formatWeekdayTime`, `shortModelName`), `side-list` (open-tabs/running/recent sectioning), `links`, `at-complete`, `marks`, `key-role` (`classifyEnter`, `resolveEnterAction` × `sendSequence`, `SUBMIT_KEY_SYMBOLS`, the non-macOS submit-key labels, `classifyCtrlKeyNonMac`), `keybindings` (`readEnterMode`, `readChatBindings`, `applySubmitKey`, `deriveSubmitKey`, `reconcileSubmitKey`, `defaultKeybindingsPath`), `daemon-client` (framing), `daemon-integration` (a real daemon — skipped unless `AGENT_SESSIONS_BIN` points at a built binary), `statusline`, `limits` (formatting, sorting, `rollForwardWindow`), `store` (read/write, locking, the temp-file path), `category` (palette-index assignment), `name` (`tokenizeNameInput`, `filterCategories`, `sessionDisplayName`), `detail` (`categoryAndLabel`), `terminal-status` (priority order, `asking`, `compacted`, the icon table), `attention` (`attentionCounts`, `urgencyByGroupKey`), `compacted` (`CompactedTracker`), `autosave` (`SaveDebouncer`), `ui-state`, `vault-state` (`writeVaultState`), `backend` (`envWithVault`, `defaultLoginShell`), `registry` (`waitingFor` passthrough), `index` (`waitForName`, `row.compacted` composition), `edit-server` (frame round-trips and handler branches), `i18n`, `settings`, `usage`, `tui-mode`, `dedupe` (`openSession`'s de-duplication, against a mocked workspace).
- **Manual**: `requirements.md`'s acceptance checks. Hands-on verification in a real Obsidian instance is reserved for reported visual glitches and for interactions the automation described in §23 can't drive (a right-click context menu, for instance).
- **CI** (`.github/workflows/test.yml`, on every push and pull request): the Python suite (`python3 -W error -m unittest discover -s tests -t .`, Python 3.11) runs on `ubuntu-latest` and `macos-latest`. The plugin's `npm ci`, `npm run typecheck`, and `npm test` run on `ubuntu-latest` (Node 20).

## 23. Verification and Obsidian's quirks

Hands-on verification goes through the Obsidian CLI (`obsidian plugin:reload id=agent-sessions`, then querying and driving the already-running Obsidian instance's commands and DOM). Before and after, `document.querySelectorAll(".modal-container").length === 0` checks that no modal was left open. Any tab or session created as a side effect is folded/`forget`-ten afterward.

Things worth knowing:

- **`Modal.open()`** stores the selection it restores on close in `this.selection` — a `Modal` subclass must not reuse that field name for something else.
- **Deferred views**: a tab never brought to front is a `DeferredView`, whose icon and title come from whatever was last saved, not computed live (§7.5, §12) — they only update when written directly into the DOM.
- **`ResizeObserver` doesn't fire on a hidden element**: a background tab or a folded panel either reports zero size or isn't observed at all. The terminal's `ensureAttached()` only runs once it sees a non-zero size for the first time, so a tab staying disconnected until it's brought to front is expected behavior, not a bug (§7.1).
- **`tui: fullscreen`**: Claude Code redraws its own screen and keeps its own scroll position, so nothing accumulates in xterm's scrollback (`buffer.length === rows`). Marker-based jumping is assumed not to work in this mode, and falls back to sending Claude's own scroll keys instead (§7.3).
- The Obsidian CLI's synthetic events don't reliably trigger `showAtMouseEvent` (a right-click menu), so that path is checked by hand instead.

## 24. Security and privacy

Everything this project writes outside the vault lives under `~/.agents/sessions/` (the daemon's runtime state — see §3's table) with the containing directory at mode 0700 and the sockets at 0600, so only the invoking user's own processes can reach them. Session bookkeeping inside the vault (`<vault>/.agents/sessions/sessions.json`) holds only folded-group names, the archive list, and category-color assignments — no transcript content or prompts.

Claude Code's own files (`~/.claude/projects/*/*.jsonl`, `~/.claude/sessions/*.json`) are read-only from this project's point of view; nothing here ever writes to them. `~/.claude/settings.json` and `~/.claude/keybindings.json` are the two exceptions — `agent-sessions setup` edits `settings.json`'s hooks and `statusLine`, and the plugin can edit `keybindings.json`'s `Chat` context when the submit key isn't `enter` — Only entries this project recognizes as its own are ever touched or removed; `settings.json` is also copied to a timestamped backup (`settings.json.bak-<timestamp>`) before `setup` or `setup --remove` writes it. `keybindings.json` edits are limited to the two `Chat` keys (plus `$schema`/`$docs` when missing) and take no backup.

The daemon's per-session output buffer (up to 1 MiB) lives in the daemon process's memory only; it is never written to disk. `daemon.log` holds only the daemon's own operational messages (start/stop, errors) — not session output — since `--detach` redirects the daemon process's own stdout/stderr there, not a child PTY's. No API key, token, or credential is handled by this project directly; `claude` manages its own authentication, and this project only launches it and relays its terminal I/O.

## 25. Future work

- **Other agent CLIs (e.g. Codex)**: the data model, `json` output, and UI already carry an `agent` field, but only Claude Code is wired up today. Supporting another CLI would mean an `agentsessions/agents/<name>.py` per agent, covering its own scan source (e.g. `~/.codex/sessions`) and `argv` construction.
- **IDE-bridge features** (accepting/rejecting diffs, live selection updates): undecided, out of scope for now.
- **Linux, end to end**: the Python and TypeScript sides are both exercised on Linux (§19), but running the Obsidian plugin itself on Linux (including under WSLg) hasn't been walked through end to end yet — in particular, whether the non-macOS Ctrl-key table (§7.2.1) actually avoids every collision with Claude Code's own key usage in practice.

**English | [日本語](README.ja.md)**

# Agent Sessions

Run and manage [Claude Code](https://claude.com/claude-code) sessions as terminal tabs inside [Obsidian](https://obsidian.md), with a session list, a usage dashboard, and a daemon that keeps sessions alive when you close a tab or quit Obsidian.

## Features

- **Terminal tabs** — one Claude Code session per Obsidian tab, backed by a real PTY (xterm.js). Close the tab or quit Obsidian and the session keeps running; reopen it and the last screen is replayed.
- **Side panel** — a right-sidebar list of open tabs, running sessions, and recent sessions, plus a details pane and a 5‑hour/7‑day rate‑limit view with a live countdown.
- **Session Manager** — a full session tree grouped by category, a sortable table (last activity, model, effort, 5h/7d cost, folder), and a usage-analytics panel: 5‑hour/7‑day stat cards, a weekly-pace projection ("on track" vs. "will run out at ‑‑"), and a per-category cost breakdown.
- **State-aware tabs and rows** — icons, colors, and motion for each session state (working, running a shell command, waiting for your answer, unread response, editing, compacted, detached, exited, error), shared between the terminal tab, the side panel, and the manager.
- **Naming and categories** — name a session as `Category: Name`; categories get a stable color and their own group in the manager.
- **Built‑in editor** — press Ctrl+G inside a session to edit the current prompt (or `/memory`, `/keybindings`, etc.) in a split pane under the terminal, with `@`-file completion, autosave, and paste/IME/undo handled natively. The terminal output stays visible while you edit.
- **Navigation helpers** — file paths printed in the output become clickable links into the vault, "insert current note as `@path`", and jump buttons for the previous/next prompt and the last response.
- **Session and usage analytics** — per-session token/cost breakdown with a turn-by-turn table, and account-wide 5‑hour/7‑day usage totals, both computed from Claude Code's own transcripts.
- **CLI and TUI** — a standalone `agent-sessions` command for scripting or working outside Obsidian: a terminal UI to pick and attach to a session, and `json` subcommands that back the plugin.
- **Bilingual UI** — English and Japanese, with an "automatic" mode that follows Obsidian's own language setting.

## Requirements

- Tested on macOS. Linux is untested but expected to work, since the plugin only relies on a Unix PTY and a Unix domain socket. Windows is not natively supported.
- Obsidian desktop, version 1.7.2 or later (`isDesktopOnly`, since the plugin spawns processes and opens Unix sockets).
- Python 3.9+ using only the standard library, normally at `/usr/bin/python3` (the path is configurable in the plugin settings).
- The [Claude Code](https://claude.com/claude-code) CLI, installed and either on your `PATH` or pointed to from the plugin settings.
- Node.js and npm, only if you are building the plugin from source (see [Development](#development)).

## Installation

There is no packaged release yet, so the plugin is installed from a local clone.

```sh
git clone <this-repository> agent-sessions
cd agent-sessions
(cd plugin && npm install && npm run build)
./install.sh /path/to/your/vault
```

The vault path is required — either as the first argument to `install.sh` or via the `AGENT_SESSIONS_VAULT` environment variable (`AGENT_SESSIONS_VAULT=/path/to/your/vault ./install.sh`).

`install.sh`:

- symlinks `bin/agent-sessions` and `bin/agent-sessions-code` into `~/bin`;
- symlinks `plugin/` into `<vault>/.obsidian/plugins/agent-sessions`;
- runs `agent-sessions setup`, which **modifies `~/.claude/settings.json`** (a backup is written first, as `settings.json.bak-<timestamp>`): it adds or updates the `Stop`, `SessionEnd`, `SessionStart` (matcher `compact`), and `UserPromptSubmit` hooks to point at `agent-sessions hook`, and sets `statusLine` to `agent-sessions status`. It only ever touches entries it recognizes as its own; other hooks are left alone.

Then enable **Agent Sessions** under Obsidian's Community plugins.

Changing the **submit key** setting away from the default (Enter) additionally makes the plugin write to `~/.claude/keybindings.json` (the `Chat` context) so that Claude Code's own keybindings match — this affects Claude Code everywhere, including sessions started outside Obsidian. Reverting the setting removes only the two keys the plugin added.

Once the plugin has started at least once, the `agent-sessions` CLI can be run from outside Obsidian without repeating the vault path: it reads the vault location from `~/.agents/sessions/vault.json`, which the plugin keeps up to date.

## Usage

| Where | What you can do |
|---|---|
| Side panel (right sidebar) | New session, open the Session Manager, settings. A list split into *open tabs*, *running* (attached to the daemon but no tab), and *recent*; each row shows a state icon, a category chip, and the name. A details pane (model, effort, connection status, context usage, total tokens/cost, last prompt/response). A rate-limit view for the 5‑hour/7‑day windows with a countdown to reset. |
| Session Manager | The default view for a new tab. A session tree (grouped by category, plus an "Other" group and an archive), and a collapsible/resizable analytics panel below it: 5‑hour/7‑day usage cards, a weekly-pace projection, and a per-category cost bar. Opening it never starts a session. |
| Terminal tab | One Claude Code session per tab. Header actions: insert the current note as `@path`, jump to the previous/next prompt or the last response. `Cmd +`/`Cmd -`/`Cmd 0` change the tab's font size. Paths printed in the output are clickable if they resolve inside the vault. |
| Ctrl+G (built-in editor) | Opens a split editing pane under the terminal for the file Claude Code would otherwise hand to `$VISUAL`. Supports `@`-file completion, autosave, and native paste/IME/undo. "Send" submits immediately for prompt edits; Esc returns to the input without sending. |
| Row menu (⋯ / right-click) | Rename, compress (`/compact`), view session analysis, archive/unarchive, end session, copy ID. |
| Session analysis | From the row menu: cost, tokens, turn count, and duration cards; input/output/tool-use bars; a turn-by-turn table. Click rows to select a range; copy the result as Markdown. |

### Session states

The terminal tab, the side panel rows, and the manager rows all share the same icon, color, and motion for a session's state: connecting, working (model is responding), running a shell command, waiting for your answer (a question or permission prompt), unread (finished responding, tab not yet brought to front), editing (built-in editor open), idle, detached (tab exists but not yet connected), compacted (just ran `/compact`, context was reset), exited, and error. Animated states respect `prefers-reduced-motion`.

## Settings

Font family and size, padding (comfortable/compact/none), submit key, recent-sessions count, idle notifications, paths to `claude`/`agent-sessions`/Python, terminal scrollback, built-in editor height, display language (auto/Japanese/English), and the saved heights of the side panel's details pane and the manager's analytics panel.

## CLI

```sh
agent-sessions                 # terminal UI: pick a session, attach or resume it
agent-sessions attach ID       # attach from a terminal (Ctrl+\ to detach)
agent-sessions daemon [--detach]
agent-sessions json scan|live|detail ID|usage ID [--from ISO --to ISO]|stats
agent-sessions setup [--dry-run]
```

`agent-sessions json` is the machine-readable interface the plugin itself uses (`scan`, `live`, `detail`, `usage`, `stats`); `hook` and `status` back the Claude Code hooks and `statusLine` described above; `edit` is the receiving end of the built-in editor.

## How it works

A small daemon (`agent-sessions daemon`, started on demand by the plugin) holds each Claude Code session's PTY over a Unix domain socket, so a session keeps running when no tab is attached to it. The plugin talks to the daemon directly for terminal I/O, and shells out to `agent-sessions json …` for everything else (scanning transcripts, computing usage and cost, building the session tree) — that logic lives entirely in Python so the plugin and the CLI/TUI see the same data.

Session bookkeeping (folded groups, archive, category colors) lives in `<vault>/.agents/sessions/sessions.json`; daemon and runtime state (socket, logs, status snapshots, caches) live under `~/.agents/sessions/`. Claude Code's own files (`~/.claude/projects/*/*.jsonl`, `~/.claude/sessions/*.json`) are only ever read, never written.

See [`docs/design.md`](docs/design.md) for the full design and [`docs/requirements.md`](docs/requirements.md) for the requirements this plugin is built against.

## Uninstall

There is no automated uninstall script; reverse the steps `install.sh` performed:

1. Disable and remove **Agent Sessions** from Obsidian's Community plugins, then delete the `<vault>/.obsidian/plugins/agent-sessions` symlink (or directory).
2. Remove the `~/bin/agent-sessions` and `~/bin/agent-sessions-code` symlinks.
3. In `~/.claude/settings.json`, remove the `Stop`/`SessionEnd`/`SessionStart` (matcher `compact`)/`UserPromptSubmit` hook entries that run `agent-sessions hook`, and the `statusLine` entry that runs `agent-sessions status` (a pre-install backup was written as `settings.json.bak-<timestamp>` by `setup`, if you still have it).
4. If you changed the submit key away from Enter, remove the `enter`/`meta+enter` entries the plugin added under `Chat` in `~/.claude/keybindings.json`.
5. The daemon exits on its own after 10 minutes with no sessions and no connections; to stop it immediately, send it `SIGTERM` (its pid is in `~/.agents/sessions/daemon.pid`).
6. Delete `<vault>/.agents/sessions/` and `~/.agents/sessions/` if you want to remove all stored state.

## Development

```sh
cd plugin && npm install
npm test && npm run typecheck && npm run build   # plugin (vitest, tsc, esbuild)
AGENT_SESSIONS_BIN=$PWD/../bin/agent-sessions npm test   # also run the tests that exercise a real daemon

cd ..
/usr/bin/python3 -W error -m unittest discover -s tests -t .   # Python (standard library only)
```

## License

MIT, see [`LICENSE`](LICENSE). `plugin/main.js` bundles xterm.js and its addons (also MIT); their license text and copyright notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

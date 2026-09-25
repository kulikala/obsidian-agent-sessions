**English | [日本語](README.ja.md)**

# Agent Sessions

Run and manage [Claude Code](https://claude.com/claude-code) and [Codex](https://github.com/openai/codex) sessions as terminal tabs inside [Obsidian](https://obsidian.md), with a session list, a usage dashboard, and a daemon that keeps sessions alive when you close a tab or quit Obsidian.

## Features

- **Multi-agent** — Claude Code and Codex sessions, mixed freely in the same list, sorted and filtered together. Auto-detected on first run; enable either or both, with per-agent path and environment-variable settings. Choosing "New session" with both enabled asks which one to start.
- **Terminal tabs** — one session per Obsidian tab, backed by a real PTY (xterm.js). Close the tab or quit Obsidian and the session keeps running; reopen it and the last screen is replayed.
- **Side panel** — a right-sidebar list of open tabs, running sessions, and recent sessions, plus a details pane and a 5‑hour/7‑day rate‑limit view with a live countdown.
- **Session Manager** — a full session tree grouped by category, a sortable table (last activity, model, effort, 5h/7d cost, folder), and a usage-analytics panel: 5‑hour/7‑day stat cards, a weekly-pace projection ("on track" vs. "will run out at ‑‑"), and a per-category cost breakdown.
- **State-aware tabs and rows** — icons, colors, and motion for each session state (working, running a shell command, waiting for your answer, unread response, editing, compacted, detached, exited, error), shared between the terminal tab, the side panel, and the manager.
- **Naming and categories** — name a session as `Category: Name`; categories get a stable color and their own group in the manager.
- **Built‑in editor** — press Ctrl+G inside a session to edit the current prompt (or `/memory`, `/keybindings`, etc.) in a split pane under the terminal, with `@`-file completion, autosave, and paste/IME/undo handled natively. The terminal output stays visible while you edit.
- **Navigation helpers** — file paths printed in the output become clickable links into the vault, "insert current note as `@path`", and jump buttons for the previous/next prompt and the last response.
- **Session and usage analytics** — per-session token/cost breakdown with a turn-by-turn table, and account-wide 5‑hour/7‑day usage totals, computed from each agent's own transcripts.
- **CLI and TUI** — a standalone `agent-sessions` command for scripting or working outside Obsidian: a terminal UI to pick and attach to a session, and `json` subcommands that back the plugin.
- **Bilingual UI** — English and Japanese, with an "automatic" mode that follows Obsidian's own language setting.

## Supported environments

| | |
|---|---|
| **OS** | macOS — tested. Linux, including Linux Obsidian running under WSLg on Windows — supported (the terminal keybindings and the Python side both have platform branches for it, exercised in CI and in Linux containers by hand), but not yet verified on a real Obsidian install end to end. Windows (native) — not supported: the daemon depends on `pty`, `fcntl`, and `termios`, Unix-only standard-library modules with no Windows equivalent, and a native Windows build of Obsidian has no PTY to hold open; running the Linux build of Obsidian under WSLg avoids this entirely. |
| **Obsidian** | Desktop only (`isDesktopOnly`, since the plugin spawns processes and opens Unix sockets — neither is available to a mobile or web build), version 1.7.2 or later (`minAppVersion`). |
| **Python** | 3.9+, standard library only, found via `$PATH` (`python3`). |
| **Claude Code and/or Codex** | At least one of the two, either on your `PATH` or pointed to from the plugin's Agents settings (auto-detected on first run). Claude Code: the plugin relies on its hooks (`Stop`, `SessionEnd`, `SessionStart` with matcher `compact`, `UserPromptSubmit`), its `statusLine`, and — only if you change the submit-key setting away from the default — its `keybindings.json`. Codex: no hooks/statusLine equivalent is used yet; hands-on verification is still pending (see [`docs/design.md`](docs/design.md) §7.7, §25). |
| **Node.js / npm** | Only if you are building the plugin from source (see [Development](#development)); CI builds with Node.js 20. |

## Installation

There is no packaged release yet, so the plugin is installed from a local clone.

```sh
git clone https://github.com/kulikala/obsidian-agent-sessions.git
cd obsidian-agent-sessions
(cd plugin && npm install && npm run build)
./scripts/install.sh /path/to/your/vault
```

The vault path is required — either as the first argument to `install.sh` or via the `AGENT_SESSIONS_VAULT` environment variable (`AGENT_SESSIONS_VAULT=/path/to/your/vault ./scripts/install.sh`).

`install.sh`:

- symlinks `bin/agent-sessions` and `bin/agent-sessions-code` into `~/bin`;
- symlinks `plugin/` into `<vault>/.obsidian/plugins/agent-sessions`;
- runs `agent-sessions setup`, which **modifies `~/.claude/settings.json`** (a backup is written first, as `settings.json.bak-<timestamp>`): it adds or updates the `Stop`, `SessionEnd`, `SessionStart` (matcher `compact`), and `UserPromptSubmit` hooks to point at `agent-sessions hook`, and sets `statusLine` to `agent-sessions status`. It only ever touches entries it recognizes as its own; other hooks are left alone.

Then enable **Agent Sessions** under Obsidian's Community plugins.

Changing the **submit key** setting away from the default (Enter) additionally makes the plugin write to `~/.claude/keybindings.json` (the `Chat` context) so that Claude Code's own keybindings match — this affects Claude Code everywhere, including sessions started outside Obsidian (only this plugin's own terminal tabs are guaranteed to send the chosen key reliably, though; whether a terminal app elsewhere can even tell it apart from plain Enter depends on that terminal). Reverting the setting removes the keys the plugin manages for this setting.

Once the plugin has started at least once, the `agent-sessions` CLI can be run from outside Obsidian without repeating the vault path: it reads the vault location from `~/.agents/sessions/vault.json`, which the plugin keeps up to date.

## Usage

| Where | What you can do |
|---|---|
| Side panel (right sidebar) | New session, open the Session Manager, settings. A list split into *open tabs*, *running* (attached to the daemon but no tab), and *recent*; each row shows a state icon, a category chip, and the name. A details pane (model, effort, connection status, context usage, total tokens/cost, last prompt/response). A rate-limit view for the 5‑hour/7‑day windows with a countdown to reset. |
| Session Manager | The default view for a new tab. A session tree (grouped by category, plus an "Other" group and an archive), and a collapsible/resizable analytics panel below it: 5‑hour/7‑day usage cards, a weekly-pace projection, and a per-category cost bar. Opening it never starts a session. |
| Terminal tab | One session (Claude Code or Codex) per tab. Header actions: insert the current note as `@path`, jump to the previous/next prompt or the last response. `Cmd +`/`Cmd -`/`Cmd 0` (macOS) or `Ctrl+Shift+=`/`Ctrl+Shift+-`/`Ctrl+Shift+0` (other platforms) change the tab's font size. On non-macOS, `Ctrl+Shift+C`/`Ctrl+Shift+V` copy the selection and paste, `Ctrl+Shift+W` closes the tab, and `Ctrl+Shift+P` opens the command palette; plain `Ctrl+<key>` combos (`Ctrl+C`, `Ctrl+G`, `Ctrl+W`, `Ctrl+P`, …) always reach the agent, not Obsidian. The submit-key setting and Enter interception apply to a Claude Code tab only — a Codex tab's own keymap is left untouched. Paths printed in the output are clickable if they resolve inside the vault. |
| Ctrl+G (built-in editor) | Opens a split editing pane under the terminal for the file Claude Code would otherwise hand to `$VISUAL`. Supports `@`-file completion, autosave, and native paste/IME/undo. "Send" submits immediately for prompt edits; Esc returns to the input without sending. |
| Row menu (⋯ / right-click) | Rename, compress (`/compact`), view session analysis, archive/unarchive, end session, copy ID. |
| Session analysis | From the row menu: cost, tokens, turn count, and duration cards; input/output/tool-use bars; a turn-by-turn table. Click rows to select a range; copy the result as Markdown. |

### Session states

The terminal tab, the side panel rows, and the manager rows all share the same icon, color, and motion for a session's state: connecting, working (model is responding), running a shell command, waiting for your answer (a question or permission prompt), unread (finished responding, tab not yet brought to front), editing (built-in editor open), idle, detached (tab exists but not yet connected), compacted (just ran `/compact`, context was reset), exited, and error. Animated states respect `prefers-reduced-motion`.

These are further grouped into the same buckets Claude's own app filters sessions by — needs input, needs review, running, done — with matching icons and colors for each, plus an archived bucket. The Session Manager's toolbar has a status-filter menu for the same six buckets (all / needs input / needs review / running / done / archived).

A small icon next to the state mark shows which agent a session belongs to (Claude Code or Codex) — a plain icon, not a brand logo.

## Settings

Font family and size, padding (comfortable/compact/none), submit key, recent-sessions count, idle notifications, agents (Claude Code/Codex — enabled, path, environment variables), path to `agent-sessions`, terminal scrollback, built-in editor height, display language (auto/Japanese/English), and the saved heights of the side panel's details pane and the manager's analytics panel.

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

```sh
"<path to this repo>/scripts/uninstall.sh" "<vault>"
```

Also disable and remove **Agent Sessions** from Obsidian's Community plugins.

`uninstall.sh` stops the daemon (asking for confirmation first if any session is still
running — pass `--force` to skip that), removes the hooks and `statusLine` it added to
`~/.claude/settings.json` (backing that file up first, the same way `install.sh` does),
removes the `enter`/`meta+enter` entries it may have added under `Chat` in
`~/.claude/keybindings.json` (only if you changed the submit key away from Enter), and
removes the `~/bin/agent-sessions`, `~/bin/agent-sessions-code`, and
`<vault>/.obsidian/plugins/agent-sessions` symlinks (a path that isn't actually a symlink
is left in place with a note, in case you replaced it by hand). It leaves other tools'
hooks, `statusLine`, and keybindings untouched, and is safe to run more than once.

Pass `--purge` to also delete `~/.agents/sessions/` (daemon runtime state) and
`<vault>/.agents/sessions/` (session bookkeeping: folded groups, archive, category colors).

## Development

```sh
cd plugin && npm install
npm test && npm run typecheck && npm run build   # plugin (vitest, tsc, esbuild)
AGENT_SESSIONS_BIN=$PWD/../bin/agent-sessions npm test   # also run the tests that exercise a real daemon

cd ..
python3 -W error -m unittest discover -s tests -t .   # Python (standard library only)
```

### Adding a language

Add `plugin/src/i18n/locales/<code>.ts` (a `Partial<Record<MessageKey, string>>` plus a `<CODE>_SELF_NAME` autonym — see `locales/ja.ts`) and `agentsessions/i18n/locales/<code>.py` (a `MESSAGES` dict — see `locales/ja.py`), then register each one, one line apiece, in `i18n/index.ts`'s `LOCALES` and `i18n/__init__.py`'s `_TABLES`. A locale can start out partial; a key it hasn't filled in yet falls back to English on both sides. See [`docs/design.md`](docs/design.md#17-i18n).

### Release (maintainers)

```sh
cd plugin && npm version patch   # or minor / major; updates plugin/manifest.json, the root manifest.json, and versions.json
git push && git push --tags
```

`plugin/.npmrc` sets `tag-version-prefix=""`, so the tag `npm version` creates is the bare version number (e.g. `0.1.1`, not `v0.1.1`) — exactly matching `manifest.json`'s `version`, which is what Obsidian's release tooling expects.

Pushing the tag runs `.github/workflows/release.yml`, which builds the plugin and attaches `main.js`, `manifest.json`, and `styles.css` to a draft GitHub Release. Review the draft, then publish it.

## License

MIT, see [`LICENSE`](LICENSE). `plugin/main.js` bundles xterm.js and its addons (also MIT); their license text and copyright notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

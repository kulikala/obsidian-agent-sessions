# Agent Sessions requirements

Opens and manages Claude Code and Codex CLI sessions inside Obsidian. Three pieces make up one tool: the plugin (Obsidian), the daemon, and the CLI/TUI.

## Terms

- **Session**: one Claude Code or Codex conversation. For Claude Code, `~/.claude/projects/<project>/<id>.jsonl` is the source of truth and the ID is Claude Code's own session ID; for Codex, `~/.codex/sessions/**/rollout-*.jsonl` and the ID is Codex's own thread ID.
- **Agent**: which CLI a session belongs to — Claude Code or Codex (R-M).
- **Name**: the name set via `/rename` (Claude Code: the transcript's `custom-title` line; Codex: its own thread name). A name of the form `Category: Name` groups by everything before `: `.
- **Running**: a session whose PTY the daemon is holding.
- **Status**: for Claude Code, the value it writes to `~/.claude/sessions/<pid>.json` — `busy`/`shell`/`idle`/`waiting` (waiting on a dialog for an answer); Codex has no such ledger file and is inferred from its transcript's tail instead (design §3.3).
- **Attach/detach**: a tab connecting to, or disconnecting from, a running session's PTY. Detaching doesn't stop the session.

## Scope

| Area | Covered here |
|---|---|
| Session list GUI, terminal, daemon, restore, fonts, renaming, state display and notifications, path linking, `@` insertion, jumping to prompts/responses, CLI/TUI | R-T, R-S, R-D, R-A, R-N, R-C (design §4–§12) |
| Multi-agent (Claude Code / Codex): settings, auto-detection, launch, display | R-M (design §3.3, §7.7) |
| The built-in editor (inside the plugin) | R-E (design §7.4) |
| Token aggregation (per-session and by range), 5-hour/7-day window statistics | R-S12, R-S13 (design §13) |
| Uninstalling | R-U (design §20) |
| Platform support (macOS, Linux, Windows) | R-P (design §19) |
| Release process | R-REL (design §21) |
| An IDE bridge (accept/reject diffs, live selection updates) | Undecided. Out of scope |

Agent CLIs other than Claude Code and Codex (opencode, agy, …) are a future direction (design §25); the data model and screens carry a general `agent` field, not just these two.

## Requirements

### R-T Terminal

- R-T1 A tab is dedicated to one CLI agent (Claude Code or Codex — R-M) — it never falls back to a plain shell. When the agent's process exits, the tab shows an exit screen (Resume / Close).
- R-T2 Font family and size are configurable. Each tab can also change its own size (Cmd +/Cmd −/reset on macOS, the non-macOS equivalents in R-T5c) independently, and keeps that size across a restore.
- R-T2a Terminal padding is configurable: comfortable (default), compact, or none — "none" is meant for laying tabs out in splits.
- R-T3 No clipped characters at the right edge. No flicker while a session is active. Japanese text, emoji, and box-drawing characters keep correct widths.
- R-T4 Colors follow Obsidian's own theme (light/dark) and update when the theme changes.
- R-T5 Every key Claude Code itself uses (Esc, Ctrl+C, arrow keys, Tab, and more) always reaches the terminal — Obsidian's hotkeys never intercept them.
- R-T5a One **submit key** setting (Enter/Shift+Enter/Ctrl+Enter/Option+Enter/Cmd+Enter, default Enter; Cmd+Enter is macOS-only — R-T5c). Any other Enter combination becomes a newline. Claude tabs only — R-T5a through R-T5d don't apply to a Codex tab, whose own keymap isn't touched (R-M).
- R-T5b Changing the submit key writes to Claude Code's own `keybindings.json` (`Chat` context) immediately — not only at startup or through a separate confirmation step — and also cleans up any stale alternate-submit binding left over from a past choice or version. The settings tab shows the result (written / already matched, nothing to write / couldn't be written) every time, re-reads the file every time it opens and offers to reconcile a mismatch, and explains that the change affects Claude Code everywhere, including sessions started outside Obsidian, where whether a real terminal can even tell the chosen key apart from plain Enter depends on that terminal.
- R-T5c On platforms other than macOS, Ctrl (not Cmd) is Obsidian's own hotkey modifier, and Claude Code itself uses many Ctrl combinations. The default routes every Ctrl-combination to the terminal; only Ctrl+Shift+C (copy selection), Ctrl+Shift+V (paste), Ctrl+Shift+=/−/0 (font size), Ctrl+Shift+W (close tab), Ctrl+Shift+P (command palette), Ctrl+Tab, and Ctrl+, go to Obsidian instead. Plain Ctrl+W and Ctrl+P (which Claude Code's own input line can use for word-delete and history) always reach the terminal.
- R-T5d The submit-key setting offers Cmd+Enter only on macOS (a non-macOS Super/Windows key doesn't reliably reach the browser — a window manager can intercept it first); the button/statusLine symbols and labels for the other four choices are shown in a form appropriate to the platform.
- R-T6 Multiple tabs stay independently stable when open at once. Closing a tab leaks no output and leaves no memory behind.

### R-M Multi-agent (Claude Code / Codex)

- R-M1 Settings has an "Agents" section: for each of Claude Code and Codex, an enabled toggle, a path (empty = auto-detect), and multi-line environment variables (`KEY=VALUE` per line). At least one agent stays enabled at all times.
- R-M2 The first time the plugin ever runs with no saved agent settings, it auto-detects each agent — a login shell's `command -v`, then the same probe in an interactive shell (catches a version manager like mise/asdf/nvm/volta whose shell integration only loads interactively), then a list of common install locations aware of those version managers — and enables whichever it finds; if neither is found, Claude Code stays enabled (unchanged from before multi-agent support). A "Detect again" button re-runs detection any time and shows the result and detected version, without changing any toggle itself.
- R-M3 Starting a new session offers a choice of agent only when more than one is enabled (with exactly one enabled, that one is used without asking); the choice made is remembered as the default for next time.
- R-M4 Claude Code and Codex sessions are listed, sorted, grouped, and filtered together — no agent-specific split in the side panel or the Session Manager. A small icon (not a brand logo) on each row and in the detail pane shows which agent a session belongs to.
- R-M5 The submit-key setting, Enter interception, and `keybindings.json` (R-T5a–d) apply to Claude Code tabs only; a Codex tab's own keymap is left untouched.
- R-M6 Renaming/compacting an existing session (R-S6) works the same way regardless of agent. Naming a session at the moment it's created is Claude Code only — a new Codex session can't be named until it's finished starting.
- R-M7 The detail pane's model/effort badges fall back to the most recent turn's values (from `json detail`) for an agent with no statusLine (Codex); "Default" if neither that nor statusLine has a value.
- R-M8 A binary resolved through a version manager may need its own directory on `PATH` at launch (e.g. a `#!/usr/bin/env node` wrapper script) — every launch prepends it, regardless of how the binary was found.
- R-M9 A new Codex session's real (thread) id isn't known until Codex creates its transcript, which can be well after the tab opens. The plugin keeps polling to learn it for as long as the tab stays open, and once learned, that id becomes the session's permanent identity everywhere (tab, row, one-session-one-tab matching) — the same as Claude Code's session id always is.

### R-S Session management (GUI)

- R-S0 Three views: the **side panel** (right sidebar — nav, list, detail, and rate limits; the list/detail split is draggable, and the detail area keeps the dragged height across restarts), the **Session Manager** (a main-area tab — the full session tree and management actions; the default view for a new tab), and the **terminal** (a main-area tab).
- R-S1 The manager's tree is ordered "category groups → Other (uncategorized and unnamed sessions, one section) → Archive (only when 'Show archive' is on)". Each section is ordered by last-updated, most recent first. Groups and Other are individually foldable, and folded state persists.
- R-S2 Last-updated is the time of the last user message or assistant response — not a hook or notification timestamp, and not a file's own mtime.
- R-S3 A child session (`entrypoint` other than `cli`, an `agent-setting` line present, or `sessionKind: bg`) is excluded from Other unless it has a name.
- R-S4 The side panel's list is "open tabs → running (no tab) → recent, N items". Each row shows a category chip, then the name with the category stripped, then a relative last-updated time ("just now" / "N min ago" / "N h ago" / "yesterday" / "N d ago", falling back to "MM-DD" past a week; the absolute time is in a tooltip). Status stays in sync, the frontmost tab's row is highlighted, and clicking a row switches to that tab. The name never shrinks past a minimum width — if the row gets too narrow to fit everything, the time is what disappears, not the name. The rate-limits area shows 5-hour/7-day usage percentages and a countdown to reset (no "resets in" label, just the time itself), laid out so the two bars are always the same length regardless of how wide the percentage/countdown text is; clicking the area re-reads the latest usage data immediately.
- R-S5 Clicking a row opens that session's tab. **If a tab for that session already exists, the view switches to it** — opening from the list never creates a second tab for the same session (splitting or duplicating a tab intentionally can, per R-N4).
- R-S6 Every row's right edge always has a `⋯` (rename via `/rename`; compress via `/compact`, disabled if the last command already was `/compact`; archive, or unarchive if already archived; end session, when running; session analysis; copy ID). Right-click opens the same menu. No session-level action lives in the nav row (new/manager/`⋯`).
- R-S7 A new session comes from a dialog with a single combined input: a category chip, then free text for the name (typing a suggestion, `:`, or pasting a `Category: Name` string all recognize the category and strip it from the text). The name is optional — a session can start unnamed. The rename dialog uses the same input, pre-split into the current category and name. Naming is reflected in the tab title immediately, even for a tab never brought to front. Category color is fixed and shared between the side panel and the manager. New sessions always start in the vault's root folder. If a name was given at creation, `/rename` is sent right after starting (Claude Code only — R-M6).
- R-S8 Renaming (`/rename`) and compressing (`/compact`) apply immediately by sending the command to the session. With no open tab, the plugin attaches temporarily; if the session isn't running at all, it's started in the background, the command is sent, and it's stopped again with `/exit`. A draft in progress is stashed before sending, Claude Code only (it restores the stash automatically afterward) — skipped for any other agent, whose own keybinding for it isn't known (R-M5).
- R-S9 Management state (folded groups, archive, category colors) lives in `<vault>/.agents/sessions/sessions.json`.
- R-S10 Opening the manager never starts `claude`. **Only choosing "New" or clicking a row starts a session.**
- R-S11 The detail pane (shared by the side panel and the manager) shows the name, badges for model/effort/rc (rc: a hollow circle when disconnected or unknown, a solid green circle when connected), a context-usage donut (with a separate mark right after a compact), total tokens and cost, the most recent prompt and response (truncated, click for the full text), tools, folder, and ID. With nothing selected, it shows the frontmost tab's session.
- R-S12 The manager is the **usage-analysis** view: a session list on top, collapsible/resizable analysis below (both states persist). Analysis shows 5-hour and 7-day stat cards (usage percentage, time to reset, cost/tokens/calls/sessions for that window, each labeled), a projection of whether the 7-day pace will hold ("on track", or the time it will run out and a suggested daily budget if not), and a per-category cost bar for each of the 5-hour and 7-day windows, side by side when there's room and stacked when there isn't. Clicking anywhere in the analysis area (other than a category bar row, which scrolls to that group instead) re-fetches the latest usage data immediately. The list is a sortable table (state mark, name, last-updated, model, effort, 5h cost, 7d cost, folder — full model/effort values in a tooltip; group headings show a category chip, count, and 5h/7d totals; rows are at least 32px tall, with columns wide enough that their own header text and typical values never clip, and that never overlap; a category name never appears twice in one row — inside a group, rows show only the name). Sorting by last-updated shows the grouped tree; sorting by 5h/7d cost flattens it, descending. Keyboard: ↑↓/Enter/`/`. The toolbar has icon buttons (new, rescan), a name filter, a status-filter menu (all / needs input / needs review / running / done / archived, matching Claude's own app's filter — the selection persists), and a "Show archive" toggle in `⋯` (governs whether archived sessions are included when the status filter is "all"). The side panel is the **current-work** view.
- R-S13 "Session analysis" (from the row menu) opens a fixed-header modal (90% of the screen's width) with cost/tokens/turn-count/duration cards, input/output/tool-use bars, and a turn table (prompt truncated, with cost). Clicking rows selects a range. Numbers use k/M notation.

### R-D Persistence and restore

- R-D1 Closing a tab doesn't end the session (detach). It stays listed as running, and reopening it shows the continuation.
- R-D2 Restarting Obsidian restores every open tab to the same session. A restored tab connects only **when it's brought to front** — restoring never connects everything at once.
- R-D3 If the daemon is still alive, restoring reconnects and replays the recent output. If not (e.g. the machine restarted), it starts with `claude --resume <id>`.
- R-D4 A session only ends via "End session" or `claude` exiting on its own.

### R-A State, notifications, and status

- R-A1 A tab's icon differs by state (connecting, working, running a shell command, asking a question — waiting for an answer, e.g. AskUserQuestion or a permission prompt — unread response, editing, just-compacted, waiting, detached, exited, error). Color and motion (spin/blink/pulse) distinguish them further, and motion respects `prefers-reduced-motion`. Side-panel and manager row marks share the same icon, color, and motion as the tab. The manager (`layout-dashboard`) and side panel (`list-tree`) icons differ from the terminal's own. These fine-grained states are further classified into groups matching Claude's own app's status buckets — needs input (asking), needs review (unread response, just-compacted), running (connecting, working, running a shell command), done (idle, editing, detached, exited) — with icons, colors, and tooltips aligned to Claude's own app for each group; an archived session always shows as its own group (an archive-box icon), regardless of its last-known state.
- R-A5 A session asking a question or with an unread response is visible even when its tab isn't in front: the side panel's "open tabs" heading shows a badge with the number of sessions needing input and the number needing review (each omitted at zero; clicking opens the highest-priority target), the manager's group headings show the same priority mark, and list rows highlight asking (strong background, color bar, bold) more strongly than needing review (weaker background).
- R-A2 A background session becoming unread triggers an Obsidian notification (can be turned off); clicking it switches to that tab.
- R-A3 `statusLine` (below the session, in Claude Code's own UI; Claude Code only — Codex has none, R-M7) shows the submit-key symbol (only when launched from the plugin, first in the line), model, effort, context-usage percentage, and rc. An unavailable model or effort shows "Default".
- R-A4 State comes from `~/.claude/sessions/<pid>.json` (written by Claude Code) and the JSON `statusLine` receives — never inferred from on-screen text.

### R-N Navigation and references

- R-N1 A file path printed in a session's output (e.g. `path/to/note.md:12`) that resolves inside the vault becomes a clickable link, opening in Obsidian's editor (at that line, if given).
- R-N2 "Insert current note as `@`" inserts the open note's path (relative to the session's working folder) as `@path`. An editor selection appends `#L<start>-<end>`.
- R-N3 Buttons jump to the previous prompt, next prompt, and last response. When Claude Code is in full-screen mode (`tui: fullscreen`), these send Claude's own scroll keys (page up/down, jump to end) instead.
- R-N4 The same session can be shown in more than one view (split right, split down, duplicate tab). Opening from a list always moves to an existing tab rather than creating a new one.
- R-N5 While the built-in editor is open, key input goes to the editor, not the PTY.

### R-C CLI/TUI (`agent-sessions`)

- R-C1 One executable, `agent-sessions` (`agent-sessions-code`, the `$VISUAL` entry point for the built-in editor, is a thin wrapper around it).
- R-C2 No arguments opens the TUI. Selecting a session and pressing Enter attaches if it's running, or launches it with `claude --resume` if not. The TUI has no management actions (rename, archive, …).
- R-C3 Subcommands: `daemon` (the PTY owner; `--detach`, `--running-count`, `--stop`), `json` (`scan`, `live`, `detail`, `usage`, `stats` — what the plugin itself consumes), `attach`, `hook` (`Stop`/`SessionEnd`/`SessionStart` matcher `compact`/`UserPromptSubmit`), `status` (`statusLine`), `edit` (the built-in editor's receiving end), `setup` (reconciles the hooks and `statusLine` in `settings.json`; `setup --remove` reverses it).
- R-C4 The TUI's side panel adapts its width to the terminal's; below a threshold it can switch to a panel-only view, so no state is simply unreachable for being too narrow.
- R-C5 Scanning, last-updated computation, child-session detection, and prompt/response extraction are implemented only in Python. The plugin displays JSON it receives; it doesn't duplicate this logic.
- R-C6 CLI, TUI, and statusLine text are bilingual (Japanese/English), selected independently of the plugin's own UI language — see R-L2.

### R-E Built-in editor

- R-E1 Claude Code's Ctrl+G (`$VISUAL`) opens the plugin's built-in editor.
- R-E2 The editor supports paste, `@`-based file completion, and autosave while typing. Minimal Markdown awareness is enough.
- R-E3 **The session's own output stays visible and scrollable while editing** — the editor doesn't cover the terminal.
- R-E4 "Send" confirms the edit and, for a prompt edit, submits it immediately. "Back to input" (Esc) returns to the input line with the content kept, without submitting.

### R-L Language

- R-L1 The plugin's UI supports Japanese and English. The "Language" setting: Auto (follows Obsidian's own language), Japanese, or English; default Auto. The extension's own description (`manifest.json`) is always English.
- R-L2 The CLI, TUI, and statusLine output are independently bilingual (Japanese/English; see R-C6). Selection order: a plugin-launched session matches the plugin's own resolved display language; otherwise the environment's `LANG`/`LC_ALL`/`LC_MESSAGES` decide, defaulting to English. Internal log and error text (not meant for a chosen-language audience) stays English regardless.

### R-U Uninstall

- R-U1 `uninstall.sh <vault>` removes only what this project added: its own hook entries and `statusLine` in `~/.claude/settings.json` (backed up first), its own submit-key entries in `~/.claude/keybindings.json` (the same six-key `OWNED_KEYS` set the plugin's own cleanup uses, R-T5b — only those still holding their canonical value), the daemon (stopped cleanly first), and its own symlinks (`~/bin/agent-sessions`, `~/bin/agent-sessions-code`, `<vault>/.obsidian/plugins/agent-sessions`). Every other tool's hooks, `statusLine`, and keybindings entries are left untouched. Running it again when nothing is left to remove is safe and reports as much.
- R-U2 `--force` skips the confirmation prompt that otherwise appears when sessions are still running.
- R-U3 `--purge` additionally deletes the daemon's runtime directory (`~/.agents/sessions/`) and the vault's session bookkeeping (`<vault>/.agents/sessions/`); without it, both are left in place.

### R-P Platform support

- R-P1 macOS is the primary, fully verified platform. Linux — including Obsidian running under WSLg on Windows — is supported: the daemon, CLI, and their platform-specific code paths (process listing, shebang, racy-mtime cache handling, socket path length, default shell, terminal key routing) run in CI on Linux and were additionally verified by hand in containers; running the plugin itself inside a real Linux Obsidian instance hasn't been walked through end to end yet. Native Windows is not supported — the daemon depends on Unix-only standard-library facilities (`pty`, `fcntl`, `termios`) that don't exist there; the Linux build of Obsidian under WSL/WSLg is the supported path for Windows users. Python 3.9+, standard library only, resolved via `$PATH`. Obsidian desktop only (`isDesktopOnly`), minimum version 1.7.2.
- R-P2 Claude Code always launches in interactive mode (`claude`), never the Agent SDK — this preserves interactive-only features such as `/remote-control`.
- R-P3 Files Claude Code writes are read-only from this project's point of view; nothing here modifies them.
- R-P4 The plugin, daemon, CLI, shared library code, tests, and this design documentation live together in one repository.

### R-REL Release process

- R-REL1 Bumping the plugin's version keeps `plugin/manifest.json`, the repository root's `manifest.json` (a copy read by the community-plugin review tooling and BRAT), and the root `versions.json` (minimum Obsidian version per release) all in sync in one step.
- R-REL2 Pushing a version tag builds the plugin and publishes `main.js`, `manifest.json`, and `styles.css` as a **draft** GitHub Release — nothing is published to users until a maintainer reviews and publishes that draft by hand.
- R-REL3 Every push and pull request runs the Python test suite on both Linux and macOS, and the plugin's type-check and test suite on Linux, in CI — a merge is never based on a suite that only ran on one platform.

## Acceptance checks

- Ten tabs, open for an hour: no flicker, no clipped edges, no cross-talk between tabs.
- Closing and reopening a tab replays the last screen and accepts input right away.
- Restarting Obsidian restores every tab to the same session, connecting each one only as it's brought to front.
- Clicking the same session twice in a list never opens a second tab.
- A background tab that starts asking for input changes its icon and raises a notification.
- Changing the font in settings updates every open tab.
- The `agent-sessions` TUI stays usable at a terminal width of 60 columns.
- `uninstall.sh` run twice in a row is a no-op the second time, and leaves other tools' Claude Code configuration untouched throughout.

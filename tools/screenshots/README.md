# README screenshots

`shoot.mjs` produces `docs/images/overview.png`, `manager.png`, and `codex.png` from the plugin as
built in `plugin/main.js`, rendered by a real Obsidian:

```sh
(cd plugin && npm run build)
node tools/screenshots/shoot.mjs          # add --keep to leave the sandbox behind for inspection
```

Requirements: Node.js 22 or later (it uses the built-in `fetch` and `WebSocket`, no packages) and
Obsidian installed at its default location (`OBSIDIAN_BIN=/path/to/Obsidian` overrides it). A
window opens for about half a minute and closes by itself; it runs alongside an Obsidian you
already have open without touching it.

## How it works

Every run builds a throwaway sandbox under the system temp directory:

- **A separate Obsidian** — its own profile (`--user-data-dir`), a vault with a few notes and a
  copy of the built plugin, English UI, the default dark theme. `HOME` points into the sandbox, so
  `~/.claude` and `~/.agents` are the sandbox's; `--use-mock-keychain` keeps macOS from asking
  for a keychain that doesn't exist there.
- **A stand-in CLI** (`fake-cli.mjs`) — the plugin's `agentSessionsPath` points at it, and it
  answers `json scan`, `live`, `detail`, `stats`, and `usage` from the scenario.
- **A stand-in daemon** (`fake-daemon.mjs`) — listens on the sandbox's `daemon.sock`, speaks the
  plugin's framed protocol, and replays a canned transcript (`transcripts.mjs`) when a tab
  attaches; it never starts a process.
- **Claude Code's own files** — the running-session ledger (`~/.claude/sessions`), statusLine
  snapshots (model, effort, context, rate limits), and compacted markers, written by `shoot.mjs`.

The script drives the window over the DevTools protocol (`cdp.mjs`), lays the page out at a fixed
1600×1100 at 2× scale, opens the tabs, flips one session from busy to idle in the background (the
"Needs review" state and the idle notice), and captures each scene.

## Changing what the images show

- `scenario.mjs` — the sessions (names, agents, states, models, costs), the rate-limit numbers,
  and the vault's notes. Times are relative to the moment of the run.
- `transcripts.mjs` — the terminal contents, in the style of each agent's TUI.
- `shoot.mjs` — window size, sidebar width, and the scenes themselves (which tab is in front, what
  is open).

If the plugin starts calling a CLI subcommand the stand-in doesn't know, the run ends by listing
it under "Stand-in CLI calls with no canned answer"; errors from Obsidian's console are listed the
same way.

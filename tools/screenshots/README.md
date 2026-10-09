# Screenshots

Two sets come from the same sandbox: the README images (`docs/images/`, dark; a Japanese run with
`--lang ja` writes `docs/images/ja/`, of which README.ja.md uses `analytics.png`, `calendar.png` and `codex.png`) and the
welcome guide's scenes (`docs/onboarding/<lang>/<scene>.png`, Obsidian's light theme, English and Japanese).

## Re-shooting the welcome guide's scenes

```sh
SCRATCH=$(mktemp -d)                                    # never build into plugin/main.js
(cd plugin && AGENT_SESSIONS_OUTFILE=$SCRATCH/main.js node esbuild.config.mjs production)
node tools/screenshots/shoot.mjs --onboarding --plugin-js $SCRATCH/main.js            # en and ja
node tools/screenshots/shoot.mjs --onboarding --lang ja --plugin-js $SCRATCH/main.js  # one language
git add docs/onboarding && git commit                   # only the images that changed are rewritten
```

The run prints each image with its size and ends with the list of files whose bytes changed;
unchanged images are left alone. Images are 16:10 at 1x (full window 1600x1000, or a crop of it
for dialogs and menus), about 40-250 KB each. A run takes about a minute per language.

**Adding a scene:** add its id to `ONBOARDING_SCENES` in `plugin/src/ui/onboarding-model.ts`, then
add a `shoot("<id>", rect)` call in `onboardingScenes` in `shoot.mjs` (`rect` is the element or
union of elements to frame, or none for the whole window). `scenes.mjs` reads the list straight
from that TypeScript array, and `plugin/test/onboarding-images.test.ts` fails until both
`docs/onboarding/en/<id>.png` and `ja/<id>.png` exist (and checks the parser agrees with the real
constant). Japanese text comes from `scenario-ja.mjs` and the `ja` branches in `transcripts.mjs`;
UI labels are read from the plugin's own locale files.

# README screenshots

The README's `welcome.png` shows the guide's second step with its picture, read from `docs/onboarding/` through a small local server. That needs a development build (the picture-folder override is not in the production bundle): build with `node esbuild.config.mjs dev`, which builds once and exits (the plain `node esbuild.config.mjs` watches and never exits).

`shoot.mjs` produces `docs/images/overview.png`, `manager.png`, `analytics.png` (Session analytics for one session), `codex.png`, `calendar.png` (the activity calendar, last week), `welcome.png` (the
welcome guide, first page), and `organize.png` (the "Organize names and categories" result view)
from a build of the plugin, rendered by a real Obsidian. Build into a scratch directory, never
into `plugin/main.js` (a development vault may link it), and point the script at that file:

```sh
SCRATCH=$(mktemp -d)
(cd plugin && AGENT_SESSIONS_OUTFILE=$SCRATCH/main.js node esbuild.config.mjs production)
node tools/screenshots/shoot.mjs --plugin-js $SCRATCH/main.js   # add --keep to leave the sandbox behind
```

`--efficiency` shoots only the token efficiency dialog's four screens, in the dark and the light theme: `efficiency-empty-<theme>.png` (not analysed yet), `efficiency-analyzing-<theme>.png` (half-way through the checks), `efficiency-result-<theme>.png` (the result just made, its first issue open) and `efficiency-previous-<theme>.png` (the saved result opened again a day later). `--out DIR` writes the README set to DIR (DIR/ja for Japanese) instead of `docs/images/`; use it for images the README does not show:

```sh
node tools/screenshots/shoot.mjs --efficiency --out "$SCRATCH/shots" --plugin-js $SCRATCH/main.js
```

`--plugin-js PATH` (or `AGENT_SESSIONS_PLUGIN_JS`) names the built `main.js`; without it the script
loads `plugin/main.js`. `manifest.json` and `styles.css` come from `plugin/`.

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
  answers `json scan`, `live`, `detail`, `stats`, `usage`, `activity`, and `efficiency` (made-up statistics and excerpts in `efficiency.mjs`) from the scenario (`activity` makes up a few working spans per day for every session, deterministically).
- **A stand-in `claude`** (`fake-claude.mjs`) — the Claude Code path in the plugin's settings;
  "Organize names and categories" runs it headless, and it answers with
  `ORGANIZE_SUGGESTIONS` from `scenario.mjs` in Claude Code's `stream-json` shape; a token
  efficiency check (its prompt carries `<<<DATA`, with the check in `statistics.check`) gets that check's reply from `efficiency.mjs`.
- **A stand-in daemon** (`fake-daemon.mjs`) — listens on the sandbox's `daemon.sock`, speaks the
  plugin's framed protocol, and replays a canned transcript (`transcripts.mjs`) when a tab
  attaches; it never starts a process.
- **Claude Code's own files** — the running-session ledger (`~/.claude/sessions`), statusLine
  snapshots (model, effort, context, rate limits), and compacted markers, written by `shoot.mjs`.

The script drives the window over the DevTools protocol (`cdp.mjs`), lays the page out at a fixed
1600×1100 at 2× scale, opens the tabs, flips one session from busy to idle in the background (the
"Needs review" state and the idle notice), and captures each scene. The welcome guide is opened
with the plugin's own method; the organize dialog through the side panel's menu (the vault is
set to non-native menus so the script can reach it), with real mouse clicks: the "only unnamed"
switch off, Suggest, then one row unticked and given a comment.

## Changing what the images show

- `scenario.mjs` — the sessions (names, agents, states, models, costs, and the turns Session analytics lists), the rate-limit numbers,
  the vault's notes, and the organize suggestions and comment. Times are relative to the moment of the run.
- `transcripts.mjs` — the terminal contents, in the style of each agent's TUI.
- `shoot.mjs` — window size, sidebar width, and the scenes themselves (which tab is in front, what
  is open).

If the plugin starts calling a CLI subcommand the stand-in doesn't know, the run ends by listing
it under "Stand-in CLI calls with no canned answer"; errors from Obsidian's console are listed the
same way.

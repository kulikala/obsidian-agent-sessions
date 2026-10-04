# Installation

Installing, installing from a clone, and uninstalling Agent Sessions in detail. The short version is in the [README](../README.md#install).

1. [Where the program goes](#where-the-program-goes)
2. [From a clone](#from-a-clone)
3. [Uninstall](#uninstall)

The plugin drives a small Python program, `agent-sessions`, which holds the sessions and reads the agents' transcripts. It is bundled with the plugin as plain source and installed with one click; Python 3.9 or later has to be on the machine already.

## Where the program goes

Where it goes: the first usable folder of `$XDG_DATA_HOME/agent-sessions`, `~/.local/share/agent-sessions`, and `~/.agents/sessions/app` — skipping any path with spaces or shell-special characters (it ends up in a hook command and in `$VISUAL`), inside the vault, or not writable. The Python is the one your login shell finds as `python3`, else `/opt/homebrew/bin`, `/usr/local/bin`, or `/usr/bin` (on macOS only once the Command Line Tools are installed, so the stub's installer pop-up never appears). 

On Windows the program goes to `%LOCALAPPDATA%\agent-sessions` (else `~\.agents\sessions\app`), with a launcher `bin\agent-sessions.cmd` (it sets `PYTHONUTF8=1` and runs the Python found at install time) and the editor shim `bin\agent-sessions-code.cmd`; the plugin itself runs `python <script>` directly, without a console window. The path may contain spaces but not `"`, `%`, `!`, `^`, `&`, `|`, `<`, `>`, `` ` ``, `$` or `;`. Python is found through the `py` launcher (`py -3`), python.org's folders (`%LOCALAPPDATA%\Programs\Python\Python3xx`, `%ProgramFiles%\Python3xx`), then `python.exe` on `PATH`; `PATH` is re-read from the registry (user and machine) plus WinGet's `Links` folder, `~\.local\bin` and `%APPDATA%\npm`. When Python or Claude Code is missing, the install dialog offers **Install Python with WinGet** / **Install Claude Code with WinGet** (`winget install --exact --id Python.Python.3.13` or `Anthropic.ClaudeCode`, `--scope user --silent`: per user, no administrator prompt, and only when you click); if WinGet itself is missing, the dialog says to update "App Installer" from the Microsoft Store. Output is UTF-8 throughout (Japanese Windows otherwise defaults to cp932).

Updating the plugin updates the program too; **Settings → agent-sessions program** reinstalls or removes it.

## From a clone

For the `agent-sessions` command in your own terminal (the TUI, scripting; macOS and Linux), or to run the program straight from a checkout, install it from this repository instead — the plugin uses `~/bin/agent-sessions` whenever it exists:

```sh
git clone https://github.com/kulikala/obsidian-agent-sessions.git
cd obsidian-agent-sessions
./scripts/install.sh
```

To install the plugin itself from source too, build it and give `install.sh` your vault, which also links this clone's `plugin/` into the vault (enable **Agent Sessions** under Community plugins afterwards):

```sh
(cd plugin && npm install && npm run build)
./scripts/install.sh /path/to/your/vault   # or AGENT_SESSIONS_VAULT=/path/to/your/vault ./scripts/install.sh
```

`install.sh`:

- symlinks `bin/agent-sessions` and `bin/agent-sessions-code` into `~/bin`;
- with a vault, symlinks `plugin/` into `<vault>/.obsidian/plugins/agent-sessions`;
- runs `agent-sessions setup`, which **modifies `~/.claude/settings.json`** (a backup is written first, as `settings.json.bak-<timestamp>`): it adds or updates the `Stop`, `SessionEnd`, `SessionStart` (matcher `compact`), and `UserPromptSubmit` hooks to point at `agent-sessions hook`, and sets `statusLine` to `agent-sessions status`. It only ever touches entries it recognizes as its own; other hooks are left alone.

Changing the **submit key** setting away from the default (Enter) additionally makes the plugin write to `~/.claude/keybindings.json` (the `Chat` context) so that Claude Code's own keybindings match — this affects Claude Code everywhere, including sessions started outside Obsidian (only this plugin's own terminal tabs are guaranteed to send the chosen key reliably, though; whether a terminal app elsewhere can even tell it apart from plain Enter depends on that terminal). Reverting the setting removes the keys the plugin manages for this setting.

The same goes for the **editor key** (default Ctrl+G; Ctrl+Q and Option/Alt+G are the other choices — keys that Claude Code, Codex and OpenCode all leave free): Claude Code and Codex already open their editor on Ctrl+G, so nothing is written for the default. For another key the plugin binds it to `chat:externalEditor` in `~/.claude/keybindings.json` (freeing Ctrl+G there) and sets `open_external_editor` under `[tui.keymap.global]` in `~/.codex/config.toml`; this also applies to those agents outside Obsidian. OpenCode's default is a different key (Ctrl+X, E), so with OpenCode enabled its `tui.json` always carries the editor key, Ctrl+G included.

Once the plugin has started at least once, the `agent-sessions` CLI can be run from outside Obsidian without repeating the vault path: it reads the vault location from `~/.agents/sessions/vault.json`, which the plugin keeps up to date.

## Uninstall

If you installed the program from the plugin, remove it under **Settings → agent-sessions program → Remove** first: that stops the daemon (ending running sessions), takes its hooks and `statusLine` out of `~/.claude/settings.json`, its lines out of `~/.codex/config.toml`, its submit-key and editor-key keybinds and status line entry out of `~/.config/opencode/tui.json`, its status plugin out of `~/.config/opencode/plugins/` and its status line file out of `~/.config/opencode/`, and the agent skills out of the vault, and deletes its folder. Then disable and remove **Agent Sessions** from Obsidian's Community plugins.

If you installed from a clone:

```sh
"<path to this repo>/scripts/uninstall.sh"            # plugin installed from Community plugins
"<path to this repo>/scripts/uninstall.sh" "<vault>"  # plugin installed from source
```

`uninstall.sh` stops the daemon (asking for confirmation first if any session is still
running — pass `--force` to skip that), removes the hooks and `statusLine` it added to
`~/.claude/settings.json` (backing that file up first, the same way `install.sh` does),
removes the `enter`/`meta+enter` entries (submit key) and the `chat:externalEditor` entry with its freed `ctrl+g` (editor key) it may have added under `Chat` in
`~/.claude/keybindings.json` (only if you changed those keys away from their defaults), and
removes the `~/bin/agent-sessions` and `~/bin/agent-sessions-code` symlinks and, given a
vault, `<vault>/.obsidian/plugins/agent-sessions` (a path that isn't actually a symlink is
left in place with a note, in case you replaced it by hand). It leaves other tools'
hooks, `statusLine`, and keybindings untouched, and is safe to run more than once.

Pass `--purge` to also delete `~/.agents/sessions/` (daemon runtime state) and, given a
vault, `<vault>/.agents/sessions/` (session bookkeeping: folded groups, archive, category colors).

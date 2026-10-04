# Testing

Agent Sessions is tested at three levels: automated unit tests that run on every push, a smoke test that drives a running Obsidian on a real machine with a fake agent, and a UI checklist that a person runs by hand before a release. This document covers all three, and the extra checks for the WSLg platform (④ in [principles.md](principles.md#4-supported-platforms-are-the-ones-where-agent-and-plugin-share-an-os)).

1. [Automated tests](#1-automated-tests)
2. [Smoke test](#2-smoke-test)
3. [Running on a real machine](#3-running-on-a-real-machine)
4. [Platform ④ checks](#4-platform--checks)
5. [UI checklist](#5-ui-checklist)

## 1. Automated tests

| Suite | Command | Where |
| --- | --- | --- |
| Plugin (TypeScript) | `cd plugin && npm ci && npx vitest run` | `plugin/src`, run by vitest |
| Type check | `cd plugin && npm run typecheck` | `tsc -noEmit` |
| Program (Python) | `python3 -W error -m unittest discover -s tests -t .` | `tests/` (includes `tests/smoke`, the fake agent) |
| Smoke tool helpers | `node --test "tools/smoke/test/*.test.mjs"` | `tools/smoke/lib` (Node 22+) |

`-W error` turns every Python warning into a failure.

CI (`.github/workflows/test.yml`) runs on every push and pull request:

| Job | OS | What |
| --- | --- | --- |
| `python` | Linux, macOS | the whole Python suite, Python 3.11 |
| `python-windows` | Windows | `tests/windows` (the ConPTY daemon and Windows process handling), `tests.test_transport` (the loopback transport) and `tests.claude.test_setup`. The rest of the Python suite drives Unix sockets and PTYs directly and assumes Unix. |
| `plugin` | Linux | `npm ci`, `npm run typecheck`, `npm test` (Node 20) |
| `smoke-tools` | Linux | `node --check tools/smoke/inject.js` and the smoke tool's unit tests (Node 22) |

CI does not start Obsidian and does not run the smoke test or the UI checklist.

## 2. Smoke test

The smoke test checks the back end on a machine that has Obsidian, the plugin and the installed `agent-sessions` program. It does not need an agent login and does not touch the DOM for the run stage: a runner on the host connects to Obsidian over DevTools (CDP), evaluates `inject.js` inside Obsidian, and the injected code drives the plugin object and talks to the daemon directly. The session it starts is a fake agent (`tools/smoke/fake_agent.py`): a small program that prints a prompt, echoes what is typed (Japanese included), answers `size` with the terminal size, opens `$VISUAL` on Ctrl+G the way Claude Code does, and quits on `exit`. It writes no transcript and no configuration of its own.

### What the steps check

The run stage (`run`) executes steps 0 to 10 in the first Obsidian instance. Obsidian is then restarted and the verify stage (`v1` to `v4`) checks that the session survived.

| Step | Checks |
| --- | --- |
| 0 leftovers | Ends and forgets sessions named `smoke-*` left by an earlier run. |
| 1 environment and install | Records OS, Obsidian, plugin and program versions and the Python in use; fails if the program is not installed, Python is missing or does not run, or the fake agent was not pushed. |
| 2 daemon | Connects to the daemon, starting it (`agent-sessions daemon --detach`) if it is not running. Fails if the running daemon is older than the installed program. |
| 3 start fake agent | Starts a `smoke-xxxxxx` session through the daemon, attaches, and waits for the fake agent's ready line. |
| 4 input and echo | Types a Japanese marker and expects the echo. |
| 5 resize | Resizes the terminal and expects the fake agent to report the new size. |
| 6 disconnect and reattach | Drops the client connection, reconnects, and expects the replay to hold the earlier output. |
| 7 built-in editor route | Sends Ctrl+G to the fake agent and checks the whole editor round trip: its `$VISUAL` shim, the plugin socket, the plugin's `handleEdit` (replaced for `smoke-` sessions only), and the reply with the edited file. |
| 8 hook and statusLine | Runs the Agent Sessions `Stop` hook and `statusLine` commands found in Claude Code's `settings.json` the way Claude Code runs them (`sh -c`; on Windows Git Bash, else PowerShell) and checks that the event log line and the status file are written. |
| 9 pid and listing | The daemon's pid for the session is alive, and `agent-sessions json scan` does not list the fake session. |
| 10 finish | Ends the session and removes its files, or, in the full run, leaves it running for the restart check. |
| v1 session survived the restart | After the second restart the daemon still lists the session, running, with a live pid. |
| v2 tab reattaches with replay | Opens the session in a terminal tab; the tab attaches and its screen holds the earlier output. |
| v3 input after reattach | Types through the tab and expects the echo. |
| v4 end and clean up | Types `exit`, ends the session, closes the tab and removes the files. |

### What the smoke test touches

- Sessions whose id starts with `smoke-`. Other sessions are never ended, and no other hook is run: step 8 runs only the commands that belong to Agent Sessions.
- A work folder under `~/.agents/sessions/smoke` (the fake agent in `bin/`, the session's working folder in `work/`) and the session's status file.
- The plugin files (`main.js`, `manifest.json`, `styles.css`) in the target vault's `.obsidian/plugins/agent-sessions/`, which the runner overwrites with the build under test.
- The daemon: step 2 starts it if it is not running, and it stays running afterwards.
- Obsidian is restarted twice by the runner.

### Running on prepared machines

Build the plugin, then run the runner from the repository root:

```sh
node tools/smoke/run.mjs --build-dir DIR [--target NAME] [--targets FILE]
```

`DIR` holds the built `main.js` (and `manifest.json` and `styles.css`; the last two are taken from `plugin/` when missing). Without `--target` every target in the file runs, in file order. Without `--targets` the file is `tools/smoke/targets.json` (git-ignored). The runner needs Node.js 22 or newer and nothing to install.

For each target the runner pushes the build and the fake agent, runs the optional `before` command, restarts Obsidian, runs the steps, restarts Obsidian again, runs the verify stage, and writes the results.

What a target machine must provide:

- Obsidian with a test vault that is trusted, with the Agent Sessions plugin enabled in it.
- The `agent-sessions` program installed by the plugin (the plugin's install dialog does this).
- Obsidian started with `--remote-debugging-port=PORT`; the `restartObsidian` command starts it this way.
- A way for the host to run commands on the machine (SSH, typically) and to reach the DevTools port.

#### Targets file

JSON with a `targets` object; each key is a target name.

```json
{
  "targets": {
    "linux": {
      "push": "scp -q {files} linux-box:{dest}/",
      "pluginDir": "/home/tester/vault/.obsidian/plugins/agent-sessions",
      "workDir": "/home/tester/.agents/sessions/smoke/bin",
      "exec": "ssh linux-box {command}",
      "restartObsidian": "ssh linux-box 'pkill -x obsidian; nohup obsidian --remote-debugging-port=9222 >/dev/null 2>&1 &'",
      "tunnel": "ssh -f -N -L 9222:127.0.0.1:9222 linux-box",
      "before": "ssh linux-box 'agent-sessions daemon --stop || true'",
      "cdpPort": 9222
    }
  }
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `push` | yes | Host command that copies files to the machine. Must contain `{files}` (the files, each quoted, space separated) and `{dest}` (the destination folder, quoted). |
| `pluginDir` | yes | The plugin folder in the test vault, on the machine. |
| `workDir` | yes | Where the fake agent goes, on the machine. Use `<home>/.agents/sessions/smoke/bin`. |
| `exec` | yes | Host command that runs a command on the machine. Must contain `{command}` (quoted). Used to create folders. |
| `restartObsidian` | yes | Host command that quits Obsidian and starts it again with `--remote-debugging-port`. It runs twice per target. |
| `cdpPort` | yes | The DevTools port as seen from the host (`127.0.0.1:<port>`). |
| `tunnel` | no | Host command that makes `cdpPort` reachable, run after every restart. It may exit at once (it set something up) or keep running (it is the tunnel); a running one is stopped when the target is done. |
| `before` | no | Host command that runs after the push and before the first restart. If it fails the target fails with its output. |

Commands run on the host through `sh`, with the placeholders filled in quoted. A `pluginDir` or `workDir` that starts with a drive letter (`C:/...`) is created with PowerShell instead of `mkdir -p`.

#### Reading the results

One line per target goes to the terminal (`PASS name: 14 pass, 0 fail, 2 skipped`); the exit code is 1 if any target failed and 2 for a usage error. The full result is written to `tools/smoke/results/<target>-<YYYYMMDD-HHMMSS>.json` and `.md`. The folder is not committed. The home folder is written as `~`.

The `.md` has the verdict, an Environment block (OS and architecture, Obsidian, plugin and program versions, the program path, the Python and its version), then a table for the run stage and one for the verify stage.

- `pass`: the step checked what it says.
- `fail`: the step ran and the check did not hold. The message says what was seen. A target passes only if nothing failed and something passed.
- `skipped`: the step did not run. The message says why:
  - `not reached`: an earlier fatal step (0 to 3, v1, v2) failed, so the rest were not run. Fix the first `fail`; the rest is not a finding. The finish step (10, v4) still runs to clean up.
  - `the run failed` or `no session was kept`: the verify stage did not run because the run stage failed or kept no session.
  - A reason specific to the step, for example step 8: `no Agent Sessions Stop hook or statusLine in the Claude Code settings` (the machine has no agent-sessions hook configured) or `no readable Claude Code settings`. That is a gap in the environment, not a pass: configure the hooks (the plugin's install dialog does) and run again to cover step 8.

A common failure is step 2: `the daemon is older than the installed program; restart the daemon first`. The daemon was started before the test pushed a newer program, so it still runs the old code. Stop it (`agent-sessions daemon --stop` on the machine) and run again. On prepared machines put that command in the target's `before`, so the next run starts the daemon from the new program. Stopping the daemon ends the sessions running on that machine, so do it on test machines only.

## 3. Running on a real machine

The runner can also run on the machine under test (`--local`). This is the way to test a platform with no prepared VM, including ④.

### Prerequisites

- Where the runner runs: on the machine that runs Obsidian. For ④ that is inside WSL (the WSLg Obsidian is a Linux program).
- Node.js 22 or newer. The runner uses Node's built-in WebSocket and `node --test`. A distribution's `apt` package is often Node 18; use the official binaries from nodejs.org or a version manager such as nvm. Check with `node --version`.
- git.
- Python 3.9 or newer, the distribution's `python3`.
- Obsidian, with the Agent Sessions plugin to be installed in a new test vault (below).

### Steps

1. Clone and check out the branch that carries the smoke test:

   ```sh
   git clone https://github.com/kulikala/obsidian-agent-sessions
   cd obsidian-agent-sessions
   git checkout main
   ```

   The smoke test lives on `main`; the branch `feature/smoke-test` carries the same tools.

2. Build the plugin into a folder of its own:

   ```sh
   cd plugin && npm ci && AGENT_SESSIONS_OUTFILE=/tmp/as-build/main.js node esbuild.config.mjs production
   cp manifest.json styles.css /tmp/as-build/
   cd ..
   ```

   `AGENT_SESSIONS_OUTFILE` builds `main.js` somewhere other than `plugin/main.js`. `manifest.json` and `styles.css` are optional in the build folder; the runner falls back to the ones in `plugin/`.

3. Create a new, empty test vault (never a real one). Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/agent-sessions/`, open the vault in Obsidian, trust it, and enable Agent Sessions under Settings, Community plugins. Let the plugin's install dialog install the program (and the Claude Code hooks, if you want step 8 covered).

4. Quit Obsidian and start it again with DevTools:

   ```sh
   obsidian --remote-debugging-port=9222
   ```

   On macOS: `open -a Obsidian --args --remote-debugging-port=9222`.

5. Run the smoke test:

   ```sh
   node tools/smoke/run.mjs --local --build-dir /tmp/as-build
   ```

   With `--local` the machine is the only target and no targets file is read. The runner connects to the Obsidian on the DevTools port (change it with `--cdp-port`; if nothing answers it prompts you to start Obsidian with DevTools first), asks that Obsidian where the open vault's plugin folder is, and copies the build over the plugin installed there, plus the fake agent into `~/.agents/sessions/smoke/bin`. It cannot restart Obsidian for you: twice during the run it prints the command and waits for Enter, once before the run stage and once before the verify stage. Quit Obsidian completely, start it again with `--remote-debugging-port`, wait until the vault has loaded, then press Enter in the terminal that runs the runner.

6. Read `tools/smoke/results/local-<timestamp>.md` (see [Reading the results](#reading-the-results)).

### What a local run touches

The same as in [What the smoke test touches](#what-the-smoke-test-touches), and the plugin files in the vault that Obsidian has open (that is why it must be the test vault). If a run is interrupted, the next run's step 0 removes the leftover `smoke-` session.

### Sharing the result

Before pasting the results `.md` into an issue or a message, read it. The runner replaces the home folder with `~`, but the file still holds the environment block and messages, and a vault path or a machine name outside the home folder is not replaced. It must contain no private paths or names.

## 4. Platform ④ checks

Platform ④ is a Linux Obsidian running under WSLg with Claude Code installed in the same WSL2 distribution. On top of the smoke test, run the checks below by hand, with a real Claude Code session, and record what is asked for.

### Setting up

- Install Linux Obsidian inside WSL: the `.deb` package, or the AppImage plus `libfuse2` (`sudo apt install libfuse2`). Start it from a WSL shell; its window appears through WSLg.
- Create a new empty test vault inside the WSL file system (`~/test-vault`). A second vault under `/mnt/c` is used in one of the checks below.
- Install the plugin and the program as in [Steps](#steps), and run the smoke test with `--local` from a WSL shell.
- Obsidian is restarted twice during the smoke test, from a WSL shell. Windows-side Obsidian is not involved.

### Checks

| Check | How | Record |
| --- | --- | --- |
| Japanese input | In a terminal tab, switch to a Japanese IME on the Windows side, type a sentence, convert, confirm; type in the built-in editor too. | Whether composition shows in place, whether candidates appear next to the cursor, whether committed text reaches the agent intact. |
| Clipboard | Copy text in a Windows application and paste into the terminal tab (`Ctrl+Shift+V`); select text in the tab, copy (`Ctrl+Shift+C`) and paste into a Windows application. Repeat with a multi-line text and one with Japanese. | Which directions work, which keys, any line-ending or encoding damage. |
| Keys | In a Claude Code session: `Ctrl+C` interrupts, `Ctrl+V`/`Ctrl+Shift+V` pastes, `Ctrl+G` opens the built-in editor, `Shift+Enter` inserts a newline (with the submit key set to Enter). | For each key whether it reached the agent or was taken by Windows, WSLg or Obsidian. |
| Vault under `/mnt/c` | Open a vault on the Windows drive, enable the plugin, start a session, and have the agent create and edit a note. Then edit the note from Windows. | Whether the side panel and the file explorer see the changes, how long they take, whether any change is missed. File watching across the 9P mount may be slow or miss changes; note the behavior rather than treating it as a plugin bug. |
| Idle auto-shutdown | Leave WSL idle with sessions running, with no WSL shell or Windows application attached, until WSL stops by itself (the idle timeout depends on the WSL version and the `wsl.conf`/`.wslconfig` settings). | Whether WSL stopped, and what Obsidian and the sessions looked like when you started it again. |
| `wsl --shutdown` | From Windows PowerShell, run `wsl --shutdown` while sessions run, then start WSL and Obsidian again. | The daemon and the sessions end with WSL. After the restart the sessions must be listed and resumable from their transcripts (open them from the list); record whether the conversation resumed. |
| systemd | Read `/etc/wsl.conf`. With `[boot]` `systemd=true`, `systemd-run` exists and `XDG_RUNTIME_DIR` is set, so the daemon starts in a transient user scope (`systemd-run --user --scope`); otherwise it forks and calls `setsid`. | Whether systemd is enabled, and `ps -o pid,ppid,sid,cmd -C python3` or `systemd-cgls --user` output showing which way the daemon was started. Run the smoke test once with systemd on and once with it off. |

### Telling product bugs from environment issues

A WSL2 distribution stops when it has nothing attached, and the daemon stops with it. Before reading a failing smoke run as a product bug, check the environment:

- Run `wsl -l -v` from Windows PowerShell. If the distribution is `Stopped`, WSL shut down mid-run. Many steps failing at once, with `the daemon is not reachable`, a missing session or a lost DevTools connection, points at this. Keep a WSL shell open for the duration of the run and run again.
- `wsl --shutdown` or a WSL update during the run has the same effect.
- A single failing step with a specific message (an echo that never arrives, a replay that lacks the output, the editor call returning an error) is a candidate product bug. Run it again once; if it repeats, report the step name, the message and the Environment block.
- Failures in step 1 (Python missing, program not installed) and the step 2 message about an older daemon are environment issues.
- Step 8 `skipped` means the Claude Code hooks are not configured in this WSL, not a pass.

## 5. UI checklist

The smoke test does not exercise the DOM. Before a release, one person runs this checklist by hand on one OS with the build to be released, in a test vault, with a real Claude Code. Each item states the expected result. Run records are not kept in the repository; the release notes or the pull request say that the checklist was run, on which OS.

### Welcome guide

- [ ] On a first install (a vault where the plugin was never enabled), the welcome guide opens by itself.
- [ ] After updating to a newer version, the guide opens once more; with "Show this guide after updates" turned off on its last page, it does not.
- [ ] The pages are in order (what Agent Sessions is, using sessions, installing the program, first settings) and you can move between them.
- [ ] The settings page offers agent selection (Claude Code, Codex, OpenCode) and the submit key; the choices appear in Settings afterwards.
- [ ] The **Show welcome guide** command and the button in Settings open it again.

### Session rows and menus

- [ ] A new session appears in the side panel with its status (busy, idle, waiting) updating as the agent works.
- [ ] Rename: the row menu's Rename changes the name in the panel, the manager and the tab title.
- [ ] Move to category: the dialog shows the session's name, offers the existing categories in a dropdown and accepts a new one; the row moves to that category.
- [ ] Archive: the row leaves the side panel; in the Session Manager with archived sessions shown, "Remove from archive" brings it back.
- [ ] End session and copy ID work from the menu.

### Built-in editor

- [ ] `Ctrl+G` in a session opens an editor pane under the terminal; the terminal output stays visible.
- [ ] `@` completes file names; Japanese input works in the editor.
- [ ] Send (or the save action) returns the edited text to the agent's prompt; Esc returns to the input without sending.
- [ ] `Ctrl+W`/`Cmd+W` while the editor is open does not close the tab.

### Restart session

- [ ] Row menu, restart session: if the session is busy it asks first; confirming ends the agent and resumes the same conversation in the same tab.
- [ ] After the restart the earlier conversation is still there (the agent shows its history, a new message continues it).
- [ ] The item is absent or disabled for a session that is not running.

### Organize names and categories

- [ ] From the side panel's and the manager's ⋯ menu, the dialog names the agent it will use before anything is sent.
- [ ] Pressing Suggest shows the working view: a spinner, the elapsed seconds, progress; the log is behind "Show log".
- [ ] The result view lists one row per session: current category and name, suggested category (chip) and suggested name, an apply toggle.
- [ ] Unticking a row shows a comment field on that row only; there is also a comment for all.
- [ ] "Suggest again for unchecked" re-suggests only the unticked rows; ticked rows stay as they are.
- [ ] "Apply selected" renames and recategorizes the ticked sessions, and nothing changes before it is pressed. Closing the dialog before that changes nothing.

### A real Claude Code conversation

- [ ] Start a Claude Code session from the plugin; the prompt appears and a message gets an answer.
- [ ] Scroll back through a long answer with the mouse wheel and the keyboard; the output is intact and input still works afterwards.
- [ ] Resize the Obsidian window and the pane; the terminal re-wraps.
- [ ] Quit Obsidian with the session running, start it again: the session is still running, its tab reattaches with the earlier output, and input works.
- [ ] Path output that resolves inside the vault is clickable.

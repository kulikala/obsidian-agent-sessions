# Smoke test

Drives a running Obsidian with the Agent Sessions plugin through DevTools (CDP) and checks the
back end with a fake agent (`fake_agent.py`), so no login is needed. It is a test tool: it is not
bundled with the plugin and adds no command to it.

- `run.mjs`: the runner, on the host. Pushes the build and the fake agent to a target, restarts
  Obsidian with DevTools, runs the steps, restarts Obsidian, runs the check, writes the results.
- `inject.js`: the code that runs inside Obsidian (steps 0 to 10, then the check after the restart).
- `lib/*.mjs`: the pure parts (result aggregation, markdown, home paths, leftovers, targets file).
- `fake_agent.py`: the stand-in agent (prompt, echo, `size`, Ctrl+G opens `$VISUAL`, `exit`).

## Run

Build the plugin first (`cd plugin && npm run build`), then:

```sh
node tools/smoke/run.mjs --build-dir plugin                 # every target in tools/smoke/targets.json
node tools/smoke/run.mjs --build-dir plugin --target macos  # one target
node tools/smoke/run.mjs --build-dir plugin --targets my-targets.json
node tools/smoke/run.mjs --build-dir plugin --local         # this machine, restart Obsidian by hand
```

Needs Node 22 or newer and nothing to install. The vault must be trusted, the plugin enabled and
the program installed on the target. `--local` copies the build over the plugin installed in the
vault that Obsidian has open, then asks you to restart Obsidian with
`--remote-debugging-port=9222` (change with `--cdp-port`).

## Targets file

JSON, `{"targets": {"<name>": {...}}}`. Per target: `push` (needs `{files}` and `{dest}`),
`pluginDir`, `workDir`, `exec` (needs `{command}`), `restartObsidian`, `tunnel` (optional), `cdpPort`.
Commands run on the host through `sh`; the placeholders are filled in quoted.

## Results

`tools/smoke/results/<target>-<YYYYMMDD-HHMMSS>.json` and `.md` (not committed; home folders are
written as `~`). One line per target goes to the terminal, and the exit code is non-zero if any
step failed.

## Tests

```sh
node --test tools/smoke
python3 -W error -m unittest discover -s tests -t .   # includes tests/smoke (the fake agent)
```

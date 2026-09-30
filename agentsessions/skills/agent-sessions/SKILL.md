---
name: agent-sessions
description: Work with Agent Sessions from an agent session - show usage statistics ({{USAGE}}), list and inspect other sessions (names, {{AGENTS_WORD}}folders, status, last messages), and start a new session ({{NAMES}}) when the user explicitly asks for one. Use when the user asks about {{ASKS}}, about what other sessions exist or what one is doing, or to start a new session.
argument-hint: "[what to do]"
---
{{MARKER}}

# Agent Sessions

Run the launcher below. Quote every value for the shell. What follows the skill name is the request.

## Start a new session

Only when the user explicitly asks for a new session. Never start one on your own initiative, to
delegate work, or because it looks useful.

```bash
"{{LAUNCHER}}" new [--cwd '<folder>'] [--name '<name>']{{if multi}} [--agent {{IDS}}]{{endif}}{{if claude}} [--remote-control]{{endif}} [--prompt '<message>']
```

- Pass only what the user asked for. `--cwd` defaults to this session's folder{{if multi}} and `--agent` to this session's own agent{{endif}}.
{{if claude&multi}}
- `--remote-control` is Claude Code only.
{{endif}}
{{if claude&!multi}}
- `--remote-control` starts the session with Remote Control.
{{endif}}
{{if codex}}
- Codex cannot be named at launch: `--name` is ignored for it (a warning is printed).
{{endif}}
- `--prompt` is the new session's first message. Use it only with text the user gave; never make one up.
{{if late}}
- With {{LATE}} the session is recorded only after its first message, so without `--prompt` the command exits 0 as soon as the process is up, and the session appears under its real id after that message (Obsidian links it).
{{endif}}
- Run it once. Exit 0: report what it printed (id, name, {{if claude}}Remote Control URL, {{endif}}how to open). Exit 1: it started but was not confirmed in time; report the id and how to open it, and do not run it again (that starts a second session). Exit 2: it could not start; report the error.
- Stop or remove a session only when the user asks.

## Usage statistics

```bash
{{if windows}}
"{{LAUNCHER}}" stats             # the 5-hour and 7-day windows{{PER_AGENT}}: share used, reset time, calls, tokens, cost
{{endif}}
"{{LAUNCHER}}" show              # this session's calls, tokens, cost, model and tools
"{{LAUNCHER}}" show '<id, id prefix or name>'
```

Give the numbers as printed; costs are estimates.{{if windows}} "usage unknown" means the agent reported no percentage for that window. `--json` gives the raw values.{{endif}}
{{if opencode&windows}}
OpenCode has no usage windows: `stats` does not list it, and `show` gives its tokens and cost.
{{endif}}
{{if !windows}}
OpenCode has no usage windows, so there is no `stats` here; `show` gives tokens and cost.
{{endif}}

## Other sessions

```bash
"{{LAUNCHER}}" sessions [--query '<text>']{{if multi}} [--agent {{IDS}}]{{endif}} [--limit <n>] [--all]
"{{LAUNCHER}}" show '<id, id prefix or name>'
```

`sessions` prints one line per session, newest activity first: id, {{AGENT_WORD}}status, last activity, folder, name (this session ends with `<- this session`). Status: `running` (working or running a shell command), `asking` (waiting for the user's answer), `idle` (waiting for the next message), `ended` (no process; can be resumed). `--all` adds archived and sub-agent sessions.

`show` prints status, folder, usage and model, then the last user message, the last assistant message and the last command. If several sessions match it lists them; run it again with an id. Quote messages only as far as the user needs. These commands only read; they send nothing to a session.

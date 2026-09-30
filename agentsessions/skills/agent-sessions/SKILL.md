---
name: agent-sessions
description: Work with Agent Sessions from an agent session - show usage statistics (the 5-hour and 7-day windows per agent, and the tokens, cost and tools of a session), list and inspect other sessions (names, agents, folders, status, last messages), and start a new session (Claude Code, Codex or OpenCode) when the user explicitly asks for one. Use when the user asks about usage, limits, quota or cost, about what other sessions exist or what one is doing, or to start a new session.
argument-hint: "[what to do]"
---
{{MARKER}}

# Agent Sessions

Run the launcher below. Quote every value for the shell. What follows the skill name is the request.

## Start a new session

Only when the user explicitly asks for a new session. Never start one on your own initiative, to
delegate work, or because it looks useful.

```bash
"{{LAUNCHER}}" new [--cwd '<folder>'] [--name '<name>'] [--agent claude|codex|opencode] [--remote-control] [--prompt '<message>']
```

- Pass only what the user asked for. `--cwd` defaults to this session's folder and `--agent` to this session's own agent.
- `--remote-control` is Claude Code only.
- `--prompt` is the new session's first message. Use it only with text the user gave; never make one up.
- Codex and OpenCode record a session after its first message, so without `--prompt` the command exits 0 as soon as the process is up, and the session appears under its real id after that message (Obsidian links it).
- Run it once. Exit 0: report what it printed (id, name, Remote Control URL, how to open). Exit 1: it started but was not confirmed in time; report the id and how to open it, and do not run it again (that starts a second session). Exit 2: it could not start; report the error.
- Stop or remove a session only when the user asks.

## Usage statistics

```bash
"{{LAUNCHER}}" stats             # the 5-hour and 7-day windows per agent: share used, reset time, calls, tokens, cost
"{{LAUNCHER}}" show              # this session's calls, tokens, cost, model and tools
"{{LAUNCHER}}" show '<id, id prefix or name>'
```

Give the numbers as printed; costs are estimates. "usage unknown" means the agent reported no percentage for that window. `--json` gives the raw values.

## Other sessions

```bash
"{{LAUNCHER}}" sessions [--query '<text>'] [--agent claude|codex|opencode] [--limit <n>] [--all]
"{{LAUNCHER}}" show '<id, id prefix or name>'
```

`sessions` prints one line per session, newest activity first: id, agent, status, last activity, folder, name (this session ends with `<- this session`). Status: `running` (working or running a shell command), `asking` (waiting for the user's answer), `idle` (waiting for the next message), `ended` (no process; can be resumed). `--all` adds archived and sub-agent sessions.

`show` prints status, folder, usage and model, then the last user message, the last assistant message and the last command. If several sessions match it lists them; run it again with an id. Quote messages only as far as the user needs. These commands only read; they send nothing to a session.

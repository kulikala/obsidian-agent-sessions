---
name: agent-sessions-info
description: List and inspect Agent Sessions sessions (Claude Code, Codex, OpenCode) - their names, agents, folders, status (running, asking, idle, ended) and last activity - and read another session's last user message, last assistant message and tools. Use when the user asks what other sessions exist, what one is doing, or what it last said.
---
{{MARKER}}

# Other sessions

## List

```bash
"{{LAUNCHER}}" sessions [--query '<text>'] [--agent claude|codex|opencode] [--limit <n>] [--all]
```

One line per session, newest activity first: id, agent, status, last activity, folder, name. The line for this session ends with `<- this session`.

| Status | Meaning |
|---|---|
| running | The agent is working (or running a shell command) |
| asking | The agent waits for the user's answer (a permission prompt or a question) |
| idle | The agent waits for the next message |
| ended | No agent process is running; the session can be resumed |

`--query` keeps sessions whose id, name, folder, agent or status contains the text. `--all` adds archived and sub-agent sessions. `--json` gives the same as JSON.

## One session

```bash
"{{LAUNCHER}}" show '<id, id prefix or name>'
```

Prints the status, folder, usage and model, then the last user message, the last assistant message and the last command. When several sessions match, it lists them; run it again with an id.

## Reporting

- Quote messages only as far as the user needs them; they can be long.
- This reads sessions. It does not send anything to them or change them.

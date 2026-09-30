---
name: agent-sessions-stats
description: Show Agent Sessions usage statistics - how much of the 5-hour and 7-day usage windows each agent (Claude Code, Codex) has used and when they reset, and the tokens, cost and tool calls of this session or another one. Use when the user asks about usage, limits, remaining quota, token counts or cost.
---
{{MARKER}}

# Usage statistics

## Usage windows

```bash
"{{LAUNCHER}}" stats
```

Prints, for each enabled agent that reports them, the share of the 5-hour and 7-day windows used, when each resets, and the calls, tokens and cost inside it. `stats --json` gives the same as JSON.

## One session

```bash
"{{LAUNCHER}}" show            # this session
"{{LAUNCHER}}" show '<id or name>'
```

Prints the session's calls, input, output and cache tokens, cost, model and the tools it used, followed by its last messages. Add `--json` for the raw values. To find another session's id or name first, use the `agent-sessions-info` skill (`sessions --query`).

## Reporting

- Give the numbers as printed. Costs are estimates.
- "usage unknown" means the agent reported no percentage for that window.

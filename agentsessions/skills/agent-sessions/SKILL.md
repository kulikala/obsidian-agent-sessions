---
name: agent-sessions
description: Work with Agent Sessions from an agent session - show usage statistics ({{USAGE}}), list and inspect sessions (names, categories, {{AGENTS_WORD}}folders, status including ended ones, last messages), find where this session wasted tokens, propose a name and category for a session and rename it, and start a new session ({{NAMES}}) or resume an ended one when the user explicitly asks. Use when the user asks about {{ASKS}}, about what sessions exist or what one is doing, about this session's waste, to name a session, or to start or resume one.
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

Give the numbers as printed; costs are estimates, and "(+N calls without a price)" means the cost leaves those calls out.{{if windows}} "usage unknown" means the agent reported no percentage for that window. `--json` gives the raw values.{{endif}}
{{if opencode&windows}}
OpenCode has no usage windows: `stats` does not list it, and `show` gives its tokens and cost.
{{endif}}
{{if !windows}}
OpenCode has no usage windows, so there is no `stats` here; `show` gives tokens and cost.
{{endif}}

## Other sessions

```bash
"{{LAUNCHER}}" sessions [--query '<text>']{{if multi}} [--agent {{IDS}}]{{endif}} [--status running|asking|idle|ended] [--category '<category>'] [--limit <n>] [--all]
"{{LAUNCHER}}" sessions --categories
"{{LAUNCHER}}" show '<id, id prefix or name>'
```

`sessions` prints one line per session, newest activity first: id, {{AGENT_WORD}}status, last activity, folder, name (this session ends with `<- this session`). Status: `running` (working or running a shell command), `asking` (waiting for the user's answer), `idle` (waiting for the next message), `ended` (no process; sleeping until resumed). Ended sessions are listed with the rest; `--status ended` keeps only them, and `--status` can be given more than once. A name `Category: Name` puts the session in that category: `--category` keeps one category's sessions (`''` for sessions without one), and `--categories` lists the categories with how many sessions each has. `--all` adds archived and sub-agent sessions, marked as such.

`show` prints status, folder, usage and model, then the last user message, the last assistant message and the last command. If several sessions match it lists them; run it again with an id. Quote messages only as far as the user needs. These commands only read; they send nothing to a session.

## Resume an ended session

Only when the user explicitly asks to wake up or resume a session. Never resume one on your own initiative or to hand it work.

```bash
"{{LAUNCHER}}" resume '<id, id prefix or name>' [--prompt '<message>']
```

- It resumes a session whose status is `ended` in the background, with the settings Obsidian uses; it refuses any other status and this session itself. No tab opens: the session shows as running in Obsidian's list, which opens it.
- `--prompt` is a message sent to it as it resumes. Use it only with text the user gave; never make one up.
- Run it once. Exit 0: report what it printed. Exit 1: it started but was not confirmed; report that and do not run it again (that starts a second process). Exit 2: it could not start; report the error.

## Waste in this session

```bash
"{{LAUNCHER}}" analyze [--tasks <n>]
```

It prints this session's token statistics, the checks to judge it by, and between `<<<DATA` and `DATA>>>` the latest tasks (each turn's prompt, the start of the reply and its numbers) with what local statistics found (`hints`). It calls no model: read the data yourself against the checks and report each issue you can point to in specific tasks, its cause and the next step, in the user's language; say so when there is none. Follow the rules printed with it. Give another session's id or name to analyse that one; `--tasks` reaches further back.

## Name a session

```bash
"{{LAUNCHER}}" suggest-name ['<id, id prefix or name>']
"{{LAUNCHER}}" suggest-name ['<id, id prefix or name>'] --check '<Category>: <Name>'
"{{LAUNCHER}}" suggest-name ['<id, id prefix or name>'] --apply '<Category>: <Name>'
```

Without a session it is this one. The first form prints the current name, the folder, the rules a name follows and the existing categories with example names (and, for another session, the start and end of its conversation). Propose one `Category: Name` (prefer an existing category) and check it with `--check`; when it breaks a rule, fix it and check again. Show the user the proposal. Rename with `--apply` only after the user agrees: Obsidian renames the session, this one once your reply has ended. Exit 1 from `--apply` means it was not renamed; pass on the `/rename` it prints.

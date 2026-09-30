---
name: agent-sessions-new
description: Start a new Agent Sessions session (Claude Code, Codex or OpenCode) in a folder, optionally with a name, a first message, or Claude Code Remote Control. Use only when the user explicitly asks to start, open or spawn a new session.
argument-hint: "[session name]"
disable-model-invocation: true
---
{{MARKER}}

# Start a new session

Use this only when the user explicitly asks for a new session. What follows the skill name is the
session name, unless it also says otherwise (which agent, which folder, Remote Control, a first task).

## Steps

1. Decide the options. Leave out anything the user did not ask for.
   - `--name`: the session name. Omit it when none was given.
   - `--cwd`: the folder. Default: this session's working folder.
   - `--agent claude|codex|opencode`: default is this session's own agent, so omit it unless the user names another.
   - `--remote-control`: Claude Code only, and only when the user asks for it.
   - `--prompt`: the new session's first message, when the user gives it a task.
2. Run this once. Quote every value for the shell.

   ```bash
   "{{LAUNCHER}}" new --cwd '<folder>' --name='<name>' [--agent <agent>] [--remote-control] [--prompt '<message>']
   ```

3. Tell the user the ID, name, Remote Control URL (if any) and how to open it, as the command printed them.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | The session started and was confirmed | Report the result |
| 1 | It started but could not be confirmed in time | Report the ID and how to open it, and say it may still be starting. Do not run the command again: that starts a second session |
| 2 | It could not start | Report the error as printed |

- Codex and OpenCode record a session only once its first message is sent, so one started without `--prompt` reports code 1 with the ID still unknown. Give them a `--prompt` (the task, or a short greeting) to have the ID resolved.
- Do not start the session any other way if this fails.
- Stop or remove a session only when the user asks.

---
name: agent-sessions-help
description: Explain how to use the Agent Sessions plugin for Obsidian - running Claude Code, Codex and OpenCode sessions as terminal tabs - from the side panel and the Session manager. Use when the user asks how to do something with Agent Sessions or where something is - starting, switching, renaming, categorizing, organizing, archiving, restarting or ending sessions, the built-in editor (Ctrl+G), the welcome guide, usage and limits, settings, install, update or removal, supported platforms, or why something does not work - in any language.
---
{{MARKER}}

# Agent Sessions help

Answer questions about using the Agent Sessions plugin in Obsidian from `reference.md` in this skill's folder. It holds the facts, grouped by task ("How do I ..."), with the exact menu, setting and command names in English and Japanese.

1. Read `reference.md`, at least the sections that match the question. Do not answer from memory: names and behavior in it are taken from the plugin's own code and docs.
2. Reply in the language the user wrote in. Name each button, menu item, setting and command as the user's Obsidian shows it: the Japanese label for a Japanese UI, the English one otherwise. When the user's UI language is unknown, give the label in the language of the question and add the other in parentheses once.
3. Give the shortest path first: where to click or what to press, then the one or two details that matter (what it does not do, what it asks first). Keep numbered steps for multi-step tasks.
4. If the answer is not in `reference.md`, say it is not documented; do not guess or invent a feature. Point to the plugin's README (https://github.com/kulikala/obsidian-agent-sessions) for the rest.
5. When the setup the user describes is listed as not supported in `reference.md` (for example Obsidian on Windows with an agent in WSL), say so plainly and give the supported alternative from the same section.

What you can do yourself is in the `agent-sessions` skill (usage numbers, a list of the other sessions, starting a session on request). Offer it when the user's goal is one of those, and run it only when they ask. Renaming, categorizing, organizing, archiving, restarting and ending sessions, and changing settings are done by the user in the plugin's UI; explain the steps, do not try to do them.

// The bytes that send one slash command (`/rename NAME`, `/compact`, `/exit`) to an agent's input
// line, in the writes they go in (`main.ts`'s `writeCommand` pauses between writes). Pure.

import type { AgentId } from "../settings";

/** Ctrl+S = Claude Code's `chat:stash` (stashes the draft; Claude restores it automatically after the next submit). */
export const STASH = "\x13";
/** Bracketed paste markers. Wrapping a command in these lets it go in as one block without opening `/` completion. */
export const PASTE_BEGIN = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/** Stash (Claude only) → command as bracketed paste → `submit` (the submit sequence: the configured
 * submit key for Claude and Codex; always `\r` for OpenCode, see below). `draft`: whether the input
 * box holds a draft to stash first. */
export function commandChunks(
	text: string,
	agent: AgentId,
	draft: boolean,
	submit: string,
	platform: string = process.platform
): string[] {
	// Ctrl+S (`chat:stash`) only over a draft: on an empty box it brings a previously stashed
	// draft back instead, and the command would be pasted after it.
	const stash = agent === "claude" && draft ? STASH : "";
	// OpenCode's slash popup answers to `\r` only (`\n` leaves it open), and `\r` runs the
	// highlighted command whichever submit key is configured, so commands always end in `\r`.
	const end = agent === "opencode" ? "\r" : submit;
	const pasted = stash + PASTE_BEGIN + text + PASTE_END;
	// Claude Code: a bare command (`/compact`) leaves the slash-command completion list open, and
	// that list swallows a rebound submit key (meta+Enter). Tab accepts the completion first; it
	// goes in its own write, after the list has had a moment to appear, and the submit after it.
	if (agent === "claude" && !text.includes(" ")) {
		return [pasted, "\t", end];
	}
	// Codex: a bare command needs a trailing space to close its popup, then the submit key.
	if (agent === "codex" && !text.includes(" ")) {
		return [PASTE_BEGIN + text + " " + PASTE_END, end];
	}
	// OpenCode: `\r` runs the highlighted popup command only once the popup is up; arriving with
	// the paste, it's read as Return in the input box (a newline, with the managed keybinds).
	// Codex on Windows: the console hands it the paste as keystrokes, and an Enter right behind a
	// burst of keys is taken as part of a paste (its paste-burst detection), so it goes separately.
	if (agent === "opencode" || (agent === "codex" && platform === "win32")) {
		return [pasted, end];
	}
	return [pasted + end];
}

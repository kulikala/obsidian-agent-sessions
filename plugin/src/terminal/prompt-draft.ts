// Whether the agent's input box holds a draft, read off the screen. Claude Code draws the box as
// a `❯` line (plus continuation lines for a multi-line draft) closed by a `─` rule; an empty box
// shows a dim placeholder ("Try …") after the `❯`, while typed text is drawn at normal intensity.
// Codex draws its composer as a `›` line (continuation lines under it, then a blank line), with a
// dim placeholder ("Ask Codex to do anything") when empty; the `›` itself is dim while input is
// disabled (`codex-rs/tui/src/bottom_pane/chat_composer.rs`).
// Pure: the caller hands over the screen's cells.

export interface ScreenCell {
	chars: string;
	dim: boolean;
}

const PROMPT: Record<string, string> = { claude: "❯", codex: "›" };
const RULE = "─";

/** What Claude Code writes into an empty box at normal intensity instead of the dim placeholder: a
 * hint, not something the user typed. Compared with the box's text, spaces collapsed. */
export const NON_DRAFT_HINTS: readonly string[] = ["Press up to edit queued messages"];

/**
 * The text typed into the last prompt line (`❯` for Claude Code, `›` for Codex) and the lines under
 * it — up to the closing rule, or for Codex the first blank line: every non-dim character after the
 * prompt, spaces collapsed; `""` for an empty box or one showing only one of `NON_DRAFT_HINTS`.
 * `null` if there's no prompt line at all (for Codex also while its `›` is dim: input is disabled),
 * or for an agent whose box isn't known (OpenCode).
 */
export function promptDraft(lines: ScreenCell[][], agent = "claude"): string | null {
	const prompt = PROMPT[agent];
	if (!prompt) {
		return null;
	}
	const codex = agent === "codex";
	let start = -1;
	let col = -1;
	for (let i = lines.length - 1; i >= 0 && start < 0; i--) {
		const cells = lines[i];
		for (let c = 0; c < cells.length; c++) {
			const ch = cells[c].chars;
			if (ch === prompt) {
				if (codex && cells[c].dim) {
					return null;
				}
				start = i;
				col = c;
				break;
			}
			if (ch.trim() !== "" && ch !== "│" && ch !== "\u00a0") {
				break;
			}
		}
	}
	if (start < 0) {
		return null;
	}
	let text = "";
	for (let i = start; i < lines.length; i++) {
		const cells = lines[i];
		const firstInk = cells.find((cell) => cell.chars.trim() !== "" && cell.chars !== "\u00a0");
		if (i > start && (codex ? firstInk === undefined : firstInk?.chars === RULE)) {
			break;
		}
		for (let c = i === start ? col + 1 : 0; c < cells.length; c++) {
			const cell = cells[c];
			if (!cell.dim && cell.chars !== "│") {
				text += cell.chars.replace(/\u00a0/g, " ");
			}
		}
		text += " ";
	}
	const typed = text.replace(/\s+/g, " ").trim();
	return NON_DRAFT_HINTS.includes(typed) ? "" : typed;
}

/** Whether the box holds a draft (`promptDraft` is not empty); `null` where `promptDraft` is. */
export function promptHasDraft(lines: ScreenCell[][], agent = "claude"): boolean | null {
	const draft = promptDraft(lines, agent);
	return draft === null ? null : draft !== "";
}

// Whether Claude Code's input box holds a draft, read off the screen. Claude Code draws the box as
// a `❯` line (plus continuation lines for a multi-line draft) closed by a `─` rule; an empty box
// shows a dim placeholder ("Try …") after the `❯`, while typed text is drawn at normal intensity.
// Pure: the caller hands over the screen's cells.

export interface ScreenCell {
	chars: string;
	dim: boolean;
}

const PROMPT = "❯";
const RULE = "─";

/**
 * `true` if the last `❯` line (and the lines under it, up to the closing rule) has any non-blank,
 * non-dim character after the `❯`; `false` if it has none; `null` if there's no `❯` line at all.
 */
export function promptHasDraft(lines: ScreenCell[][]): boolean | null {
	let start = -1;
	let col = -1;
	for (let i = lines.length - 1; i >= 0 && start < 0; i--) {
		const cells = lines[i];
		for (let c = 0; c < cells.length; c++) {
			const ch = cells[c].chars;
			if (ch === PROMPT) {
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
	for (let i = start; i < lines.length; i++) {
		const cells = lines[i];
		const firstInk = cells.find((cell) => cell.chars.trim() !== "" && cell.chars !== "\u00a0");
		if (i > start && firstInk?.chars === RULE) {
			break;
		}
		for (let c = i === start ? col + 1 : 0; c < cells.length; c++) {
			const cell = cells[c];
			if (!cell.dim && cell.chars !== "│" && cell.chars.replace(/\u00a0/g, "").trim() !== "") {
				return true;
			}
		}
	}
	return false;
}

// Whether a line the plugin typed into an agent's input box has been submitted, judged from what
// the box shows (`TerminalView.promptDraft`). Codex on Windows, while it starts up, can take a
// pasted line and drop the submit key that follows it: the line then waits in the box, and the
// next thing typed joins it. Pure (test/terminal/line-submitted.test.ts).

/** `done`: the box is empty; `resubmit`: it still holds exactly the line; `wait`: no input box on
 * screen (Codex disables input while it starts); `other`: it holds something else. */
export type LineState = "done" | "resubmit" | "wait" | "other";

/** Compared without any whitespace: a long line wraps, and the box's rows are joined with spaces. */
function squeeze(text: string): string {
	return text.replace(/\s+/g, "");
}

export function lineState(draft: string | null, line: string): LineState {
	if (draft === null) {
		return "wait";
	}
	if (draft === "") {
		return "done";
	}
	return squeeze(draft) === squeeze(line) ? "resubmit" : "other";
}

/** The longest line `typeLine` takes: Codex shows a long paste as a placeholder, not as its text. */
export const TYPED_LINE_MAX = 300;

/** Whether `text` can be typed and checked as one line: no line break, and short enough to show
 * as itself in the composer. */
export function isTypedLine(text: string): boolean {
	return !/[\r\n]/.test(text) && text.length <= TYPED_LINE_MAX;
}

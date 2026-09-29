// Tab / Shift+Tab in the built-in editor (Ctrl+G): indent and outdent by two spaces. Pure text
// arithmetic on the textarea's value and selection, so the editor pane only has to apply the
// result (through `insertText`, which keeps it in the undo history).

export const INDENT = "  ";

export interface IndentEdit {
	/** The range of `value` to replace. */
	from: number;
	to: number;
	/** What replaces it. */
	text: string;
	/** The selection afterwards. */
	selectionStart: number;
	selectionEnd: number;
}

/**
 * The edit for Tab (`outdent` false) or Shift+Tab (`outdent` true) at `[start, end)`.
 * - Tab with no selection inserts two spaces at the cursor.
 * - Tab with a selection indents every line the selection touches.
 * - Shift+Tab removes up to two leading spaces from every line the selection (or cursor) is on.
 * Returns `null` when nothing would change (Shift+Tab on lines with no leading space).
 */
export function indentEdit(value: string, start: number, end: number, outdent: boolean): IndentEdit | null {
	if (!outdent && start === end) {
		return { from: start, to: end, text: INDENT, selectionStart: start + INDENT.length, selectionEnd: start + INDENT.length };
	}
	const from = value.lastIndexOf("\n", start - 1) + 1;
	// A selection ending right at the start of a line doesn't take that line in.
	const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
	const next = value.indexOf("\n", last);
	const to = next === -1 ? value.length : next;

	const lines = value.slice(from, to).split("\n");
	// Per line: how many characters were added (+) or removed (−) at its start.
	const deltas = lines.map((line) => (outdent ? -Math.min(INDENT.length, /^ */.exec(line)![0].length) : INDENT.length));
	if (deltas.every((d) => d === 0)) {
		return null;
	}
	const text = lines.map((line, i) => (deltas[i] > 0 ? INDENT + line : line.slice(-deltas[i]))).join("\n");

	// Moves an offset inside the block by what happened at the starts of the lines before it.
	const shift = (offset: number): number => {
		let lineStart = from;
		let moved = 0;
		for (let i = 0; i < lines.length; i++) {
			const lineEnd = lineStart + lines[i].length;
			if (offset <= lineEnd || i === lines.length - 1) {
				const d = deltas[i];
				if (d > 0) {
					// An offset at a line's start stays there, so a whole-line selection stays whole.
					return offset + moved + (offset === lineStart ? 0 : d);
				}
				// An offset inside removed indentation lands at the line's new start.
				return offset + moved + Math.max(d, lineStart - offset);
			}
			moved += deltas[i];
			lineStart = lineEnd + 1;
		}
		return offset + moved;
	};
	return { from, to, text, selectionStart: shift(start), selectionEnd: shift(end) };
}

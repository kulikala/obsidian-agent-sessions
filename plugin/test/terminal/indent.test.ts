import { describe, expect, it } from "vitest";
import { indentEdit } from "../../src/terminal/indent";

/** Applies `indentEdit` to text where `[` and `]` mark the selection (`|` a cursor), and renders the result the same way. */
function run(marked: string, outdent: boolean): string {
	const cursor = marked.indexOf("|");
	const value = marked.replace(/[[\]|]/g, "");
	const start = cursor >= 0 ? cursor : marked.indexOf("[");
	const end = cursor >= 0 ? cursor : marked.indexOf("]") - 1;
	const edit = indentEdit(value, start, end, outdent);
	if (!edit) {
		return marked;
	}
	const out = value.slice(0, edit.from) + edit.text + value.slice(edit.to);
	if (edit.selectionStart === edit.selectionEnd) {
		return out.slice(0, edit.selectionStart) + "|" + out.slice(edit.selectionStart);
	}
	return out.slice(0, edit.selectionStart) + "[" + out.slice(edit.selectionStart, edit.selectionEnd) + "]" + out.slice(edit.selectionEnd);
}

describe("indentEdit", () => {
	it("Tab at a cursor inserts two spaces there", () => {
		expect(run("ab|c", false)).toBe("ab  |c");
		expect(run("|", false)).toBe("  |");
	});

	it("Tab with a selection indents every line it touches", () => {
		expect(run("a\nb[c\nd]e\nf", false)).toBe("a\n  b[c\n  d]e\nf");
		expect(run("x[yz]", false)).toBe("  x[yz]");
	});

	it("keeps a whole-line selection whole, and leaves out a line the selection only reaches the start of", () => {
		expect(run("[a\nb\n]c", false)).toBe("[  a\n  b\n]c");
	});

	it("Shift+Tab removes up to two leading spaces from each line", () => {
		expect(run("    a|b", true)).toBe("  a|b");
		expect(run("[ a\n   b\nc]", true)).toBe("[a\n b\nc]");
	});

	it("Shift+Tab moves a cursor inside the removed indentation to the line's start", () => {
		expect(run(" | a", true)).toBe("|a");
	});

	it("Shift+Tab with nothing to remove changes nothing", () => {
		expect(indentEdit("abc", 1, 1, true)).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import { promptHasDraft, type ScreenCell } from "../../src/terminal/prompt-draft";

/** A screen line from text; characters inside `[` `]` are dim. */
function line(text: string): ScreenCell[] {
	const out: ScreenCell[] = [];
	let dim = false;
	for (const ch of text) {
		if (ch === "[") {
			dim = true;
		} else if (ch === "]") {
			dim = false;
		} else {
			out.push({ chars: ch, dim });
		}
	}
	return out;
}

const RULE = "────────────";

describe("promptHasDraft", () => {
	it("is false for an empty box showing the dim placeholder", () => {
		expect(promptHasDraft([line(RULE), line('❯ [Try "refactor <filepath>"]'), line(RULE)])).toBe(false);
		expect(promptHasDraft([line(RULE), line("❯ "), line(RULE)])).toBe(false);
	});

	it("is true when typed text follows the prompt", () => {
		expect(promptHasDraft([line(RULE), line("❯ hello"), line(RULE)])).toBe(true);
	});

	it("sees the continuation lines of a multi-line draft, stopping at the rule", () => {
		expect(promptHasDraft([line(RULE), line("❯ "), line("  second line"), line(RULE), line("  status")])).toBe(true);
		expect(promptHasDraft([line(RULE), line("❯ "), line(RULE), line("  status text")])).toBe(false);
	});

	it("uses the last prompt line on the screen (earlier ones are history)", () => {
		expect(promptHasDraft([line("❯ old instruction"), line("answer"), line(RULE), line("❯ "), line(RULE)])).toBe(false);
	});

	it("is null when no prompt is on the screen", () => {
		expect(promptHasDraft([line("some output"), line(RULE)])).toBeNull();
	});
});

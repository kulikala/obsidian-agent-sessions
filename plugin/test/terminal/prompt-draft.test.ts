import { describe, expect, it } from "vitest";
import { promptDraft, promptHasDraft, type ScreenCell } from "../../src/terminal/prompt-draft";

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

	it("does not take Claude Code's queued-messages hint for a draft", () => {
		expect(promptHasDraft([line(RULE), line("❯ Press up to edit queued messages"), line(RULE)])).toBe(false);
		expect(promptHasDraft([line(RULE), line("❯ Press up to edit"), line("  queued messages"), line(RULE)])).toBe(false);
		expect(promptHasDraft([line(RULE), line("❯ [Press up to edit queued messages]"), line(RULE)])).toBe(false);
		expect(promptHasDraft([line(RULE), line("❯ Press up to edit queued messages please"), line(RULE)])).toBe(true);
	});

	it("uses the last prompt line on the screen (earlier ones are history)", () => {
		expect(promptHasDraft([line("❯ old instruction"), line("answer"), line(RULE), line("❯ "), line(RULE)])).toBe(false);
	});

	it("is null when no prompt is on the screen", () => {
		expect(promptHasDraft([line("some output"), line(RULE)])).toBeNull();
	});
});

describe("promptHasDraft (Codex)", () => {
	const footer = line("  [? for shortcuts]");
	const status = line("  [gpt-oss:20b default · Context 0% used]");

	it("is false for an empty composer showing the dim placeholder", () => {
		expect(promptHasDraft([line("› [Ask Codex to do anything]"), line(""), footer, status], "codex")).toBe(false);
	});

	it("is true when typed text follows the prompt, including on a continuation line", () => {
		expect(promptHasDraft([line("› hello"), line(""), footer], "codex")).toBe(true);
		expect(promptHasDraft([line("› "), line("  second line"), line(""), footer], "codex")).toBe(true);
	});

	it("takes the last prompt line, not a past message drawn with the same mark", () => {
		expect(promptHasDraft([line("› say hi"), line(""), line("• Hi"), line(""), line("› [Ask Codex to do anything]"), line(""), footer], "codex")).toBe(false);
	});

	it("is null while input is disabled (a dim prompt) or with no composer on screen", () => {
		expect(promptHasDraft([line("[›] [Input disabled.]"), line(""), footer], "codex")).toBeNull();
		expect(promptHasDraft([line("loading"), footer], "codex")).toBeNull();
	});

	it("does not read Claude Code's prompt as Codex's, and knows no box for OpenCode", () => {
		expect(promptHasDraft([line(RULE), line("❯ hello"), line(RULE)], "codex")).toBeNull();
		expect(promptHasDraft([line("› hello")], "claude")).toBeNull();
		expect(promptHasDraft([line(RULE), line("❯ hello"), line(RULE)], "opencode")).toBeNull();
	});
});


describe("promptDraft", () => {
	it("gives the typed text, empty for the placeholder, and null with no composer", () => {
		expect(promptDraft([line("› /rename Race: One"), line(""), line("  [? for shortcuts]")], "codex")).toBe("/rename Race: One");
		expect(promptDraft([line("› [Ask Codex to do anything]"), line("")], "codex")).toBe("");
		expect(promptDraft([line("loading")], "codex")).toBeNull();
	});
});

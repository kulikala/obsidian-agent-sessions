import { describe, expect, it } from "vitest";
import { classifyCodexTitleStatus } from "../../src/sessions/codex-title-status";

describe("classifyCodexTitleStatus (T-108: Codex's own OSC-0 terminal title, read via onTitleChange)", () => {
	it("is 'asking' when the title carries Codex's action-required marker", () => {
		expect(classifyCodexTitleStatus("[ ! ] Action Required — my-thread")).toBe("asking");
		expect(classifyCodexTitleStatus("[ . ] Action Required — my-thread")).toBe("asking");
	});

	it("is 'working' when the title carries one of Codex's own spinner glyphs", () => {
		for (const ch of ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]) {
			expect(classifyCodexTitleStatus(`${ch} my-thread — my-project`)).toBe("working");
		}
	});

	it("prefers 'asking' when (implausibly) both markers are present", () => {
		expect(classifyCodexTitleStatus("[ ! ] Action Required ⠋ my-thread")).toBe("asking");
	});

	it("is null for a plain title with neither marker (thread-name/project-name only)", () => {
		expect(classifyCodexTitleStatus("my-thread — my-project")).toBeNull();
	});

	it("is null for an empty title", () => {
		expect(classifyCodexTitleStatus("")).toBeNull();
	});

	it("does not false-positive on ordinary text merely containing 'Action' or 'Required' alone", () => {
		expect(classifyCodexTitleStatus("Action items — my-project")).toBeNull();
		expect(classifyCodexTitleStatus("Required reading — my-project")).toBeNull();
	});
});

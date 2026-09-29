import { describe, expect, it } from "vitest";
import { isResumeFailure } from "../../src/sessions/resume-failure";

describe("isResumeFailure", () => {
	it("recognises each agent's own message", () => {
		expect(isResumeFailure("claude", "No conversation found with session ID: x")).toBe(true);
		expect(isResumeFailure("codex", "thread abc not found")).toBe(true);
		expect(isResumeFailure("opencode", "Error: Session not found: ses_abc")).toBe(true);
	});

	it("does not take ollama's own 'not found' errors for OpenCode's missing session", () => {
		expect(isResumeFailure("opencode", 'Error: model "gemma3" not found, try pulling it first')).toBe(false);
		expect(isResumeFailure("opencode", "ollama: command not found")).toBe(false);
	});

	it("does not fire on output without a message", () => {
		expect(isResumeFailure("claude", "hello")).toBe(false);
		expect(isResumeFailure("opencode", "")).toBe(false);
	});
});

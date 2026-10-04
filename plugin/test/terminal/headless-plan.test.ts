import { describe, expect, it } from "vitest";
import { afterWait, CLEAR_LINE, planHeadlessCommand, RENAME_WAIT_MS } from "../../src/terminal/headless-plan";

describe("planHeadlessCommand", () => {
	it("waits for the new name after /rename, with a bounded timeout", () => {
		const plan = planHeadlessCommand("claude", "/rename My Session");
		expect(plan.wait).toEqual({ kind: "name", name: "My Session", timeoutMs: RENAME_WAIT_MS });
		expect(RENAME_WAIT_MS).toBeGreaterThan(0);
	});

	it("keeps the busy-to-idle wait for other commands", () => {
		expect(planHeadlessCommand("claude", "/compact").wait).toEqual({ kind: "busy-idle" });
		expect(planHeadlessCommand("codex", "/rename x y").wait.kind).toBe("name");
		expect(planHeadlessCommand("claude", "/renamed").wait).toEqual({ kind: "busy-idle" });
	});

	it("clears the line before the command and before /exit for Claude", () => {
		const plan = planHeadlessCommand("claude", "/compact");
		expect(plan.clearBeforeCommand).toBe(CLEAR_LINE);
		expect(plan.clearBeforeExit).toBe(CLEAR_LINE);
		expect(CLEAR_LINE).toBe("\x15");
	});

	it("leaves Codex and OpenCode sequences as they were", () => {
		for (const agent of ["codex", "opencode"] as const) {
			const plan = planHeadlessCommand(agent, "/compact");
			expect(plan.clearBeforeCommand).toBe("");
			expect(plan.clearBeforeExit).toBe("");
		}
	});
});

describe("afterWait", () => {
	it("sends /exit once the renamed name appeared", () => {
		expect(afterWait({ kind: "name", name: "a", timeoutMs: 1 }, true)).toBe("exit");
	});
	it("tears down without /exit when the name never changed", () => {
		expect(afterWait({ kind: "name", name: "a", timeoutMs: 1 }, false)).toBe("teardown");
	});
	it("does not tear down for the busy-idle wait", () => {
		expect(afterWait({ kind: "busy-idle" }, true)).toBe("exit");
	});
});

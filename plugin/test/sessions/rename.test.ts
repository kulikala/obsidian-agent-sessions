import { describe, expect, it } from "vitest";
import { createNameRoute, isInTurn, renameRoute, renameWhenTurnEnds, sessionAgentOf } from "../../src/sessions/rename";

describe("sessionAgentOf", () => {
	it("trusts the tab before the row or the store (a fresh tab has neither)", () => {
		expect(sessionAgentOf({ tab: "opencode" })).toBe("opencode");
		expect(sessionAgentOf({ tab: "codex", row: "claude", stored: "claude" })).toBe("codex");
	});

	it("falls back to the row, then the store, then Claude", () => {
		expect(sessionAgentOf({ row: "opencode", stored: "codex" })).toBe("opencode");
		expect(sessionAgentOf({ stored: "codex" })).toBe("codex");
		expect(sessionAgentOf({})).toBe("claude");
	});
});

describe("renameRoute", () => {
	it("types /rename for Claude Code and Codex, resolved or not", () => {
		expect(renameRoute("claude", false)).toBe("command");
		expect(renameRoute("codex", true)).toBe("command");
		expect(renameRoute("codex", false)).toBe("command");
	});

	it("never types anything into OpenCode: it keeps the name until the id is known, then stores it", () => {
		expect(renameRoute("opencode", true)).toBe("pending");
		expect(renameRoute("opencode", false)).toBe("store");
	});
});

describe("createNameRoute", () => {
	it("names Claude Code on the command line, Codex through its composer, and keeps OpenCode's until the id is known", () => {
		expect(createNameRoute("claude")).toBe("launch");
		expect(createNameRoute("codex")).toBe("composer");
		expect(createNameRoute("opencode")).toBe("pending");
	});

	it("names a Codex session started with its first message after that turn, not through its queue", () => {
		expect(createNameRoute("codex", true)).toBe("afterTurn");
		expect(createNameRoute("claude", true)).toBe("launch");
		expect(createNameRoute("opencode", true)).toBe("pending");
	});
});

describe("renameWhenTurnEnds", () => {
	function clock(statuses: (string | null)[]) {
		let t = 0;
		let i = 0;
		const renamed: number[] = [];
		return {
			renamed,
			wait: (timeoutMs = 10_000) =>
				renameWhenTurnEnds({
					inTurn: () => isInTurn(statuses[Math.min(i, statuses.length - 1)]),
					now: () => t,
					sleep: (ms) => {
						t += ms;
						i += 1;
						return Promise.resolve();
					},
					timeoutMs,
					pollMs: 1000,
					rename: () => {
						renamed.push(t);
						return Promise.resolve();
					},
				}),
		};
	}

	it("renames at once when the session is not in a turn", async () => {
		const c = clock(["idle"]);
		expect(await c.wait()).toBe("renamed");
		expect(c.renamed).toEqual([0]);
	});

	it("waits while the session works, runs a command or asks, then renames", async () => {
		const c = clock(["busy", "shell", "waiting", "idle"]);
		expect(await c.wait()).toBe("renamed");
		expect(c.renamed).toEqual([3000]);
	});

	it("gives up without renaming when the turn outlasts the wait", async () => {
		const c = clock(["busy"]);
		expect(await c.wait(5000)).toBe("timeout");
		expect(c.renamed).toEqual([]);
	});

	it("a session with no status is not in a turn", () => {
		expect([null, undefined, "", "idle"].map((s) => isInTurn(s))).toEqual([false, false, false, false]);
	});
});

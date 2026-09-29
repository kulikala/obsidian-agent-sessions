import { describe, expect, it } from "vitest";
import { renameRoute, sessionAgentOf } from "../../src/sessions/rename";

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

import { describe, expect, it } from "vitest";
import { orphanDaemonSessions } from "../../src/sessions/orphans";
import type { DaemonSession } from "../../src/types";

function daemon(id: string, over: Partial<DaemonSession> = {}): DaemonSession {
	return { id, agent: "codex", cwd: "/v", pid: 10, startedAt: 1, clients: 0, exited: null, exitedAt: null, ...over };
}

const none = { linkedDaemonIds: new Set<string>(), sessionIds: new Set<string>(), resolving: new Set<string>() };

describe("orphanDaemonSessions", () => {
	it("picks a running Codex or OpenCode session nobody links or resolves", () => {
		const list = [daemon("a"), daemon("b", { agent: "opencode" })];
		expect(orphanDaemonSessions(list, none).map((s) => s.id)).toEqual(["a", "b"]);
	});

	it("leaves Claude Code alone (its id is known at launch)", () => {
		expect(orphanDaemonSessions([daemon("a", { agent: "claude" })], none)).toEqual([]);
	});

	it("skips ended sessions", () => {
		expect(orphanDaemonSessions([daemon("a", { exited: 0, exitedAt: 5 })], none)).toEqual([]);
	});

	it("skips a session sessions.json links, one resumed under its real id, and one a resolver has", () => {
		const list = [daemon("linked"), daemon("real"), daemon("busy"), daemon("free")];
		const known = {
			linkedDaemonIds: new Set(["linked"]),
			sessionIds: new Set(["real"]),
			resolving: new Set(["busy"]),
		};
		expect(orphanDaemonSessions(list, known).map((s) => s.id)).toEqual(["free"]);
	});
});

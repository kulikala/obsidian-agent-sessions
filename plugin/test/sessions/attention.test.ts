import { describe, expect, it } from "vitest";
import { attentionCounts, urgencyByGroupKey } from "../../src/sessions/attention";
import type { Row } from "../../src/sessions/index";
import type { TerminalStatus } from "../../src/sessions/terminal-status";

function row(overrides: Partial<Row> & Pick<Row, "id">): Row {
	return {
		agent: "claude",
		name: null,
		group: null,
		label: null,
		cwd: "/v",
		folder: "v",
		last_activity: 0,
		child: false,
		transcript: null,
		status: null,
		waitingFor: null,
		compacted: false,
		pid: null,
		rc: false,
		daemon: false,
		exited: null,
		hasTab: false,
		archived: false,
		...overrides,
	};
}

/** `resolveRowStatus` only looks at `source.terminalStatuses`, so it can be built
 * directly from an id → state map (`asking` isn't in `TerminalStatus` yet, so it's
 * passed through as a plain string). */
function source(statuses: Record<string, string>): { terminalStatuses: Map<string, TerminalStatus> } {
	return { terminalStatuses: new Map(Object.entries(statuses)) as Map<string, TerminalStatus> };
}

describe("attentionCounts", () => {
	it("counts asking and waiting separately", () => {
		const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" }), row({ id: "d" })];
		const counts = attentionCounts(source({ a: "asking", b: "waiting", c: "waiting", d: "idle" }), rows);
		expect(counts.asking).toBe(1);
		expect(counts.waiting).toBe(2);
	});

	it("counts a looped session in the needs-review bucket", () => {
		const rows = [row({ id: "a" }), row({ id: "b" })];
		const counts = attentionCounts(source({ a: "looped", b: "waiting" }), rows);
		expect(counts.waiting).toBe(2);
		expect(counts.waitingIds).toEqual(["a", "b"]);
	});

	it("is 0 for both, with no ids, when neither is present", () => {
		const rows = [row({ id: "a" }), row({ id: "b" })];
		const counts = attentionCounts(source({ a: "idle", b: "working" }), rows);
		expect(counts).toEqual({ asking: 0, waiting: 0, askingIds: [], waitingIds: [] });
	});

	it("collects each group's ids in list order", () => {
		const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" }), row({ id: "d" })];
		const counts = attentionCounts(source({ a: "waiting", b: "asking", c: "compacted", d: "asking" }), rows);
		expect(counts.askingIds).toEqual(["b", "d"]);
		expect(counts.waitingIds).toEqual(["a", "c"]);
	});

	it("counts compacted as waiting too (both are the needs-review group)", () => {
		const rows = [row({ id: "a" }), row({ id: "b" })];
		const counts = attentionCounts(source({ a: "waiting", b: "compacted" }), rows);
		expect(counts.waiting).toBe(2);
	});

	it("never counts an archived row, regardless of its status", () => {
		const rows = [row({ id: "a", archived: true })];
		const counts = attentionCounts(source({ a: "asking" }), rows);
		expect(counts).toEqual({ asking: 0, waiting: 0, askingIds: [], waitingIds: [] });
	});
});

describe("urgencyByGroupKey", () => {
	const keyOf = (r: Row): string => r.folder;

	it("holds the highest-priority state per group (asking > waiting)", () => {
		const rows = [
			row({ id: "a", folder: "g1" }),
			row({ id: "b", folder: "g1" }),
			row({ id: "c", folder: "g2" }),
		];
		const map = urgencyByGroupKey(source({ a: "waiting", b: "asking", c: "waiting" }), rows, keyOf);
		expect(map.get("g1")).toBe("asking"); // waiting and asking are mixed → asking wins
		expect(map.get("g2")).toBe("waiting");
	});

	it("treats compacted the same as waiting (both are needs-review)", () => {
		const rows = [row({ id: "a", folder: "g1" })];
		const map = urgencyByGroupKey(source({ a: "compacted" }), rows, keyOf);
		expect(map.get("g1")).toBe("waiting");
	});

	it("does not have a key for a group with no matching rows", () => {
		const rows = [row({ id: "a", folder: "g1" })];
		const map = urgencyByGroupKey(source({ a: "idle" }), rows, keyOf);
		expect(map.has("g1")).toBe(false);
		expect(map.size).toBe(0);
	});

	it("counts across all rows passed in, regardless of whether children are collapsed out of rows", () => {
		// Just confirms the contract that a collapsed group's children are still
		// picked up if included in rows (deciding what's collapsed is the caller's job).
		const rows = [row({ id: "a", folder: "g1" })];
		const map = urgencyByGroupKey(source({ a: "asking" }), rows, keyOf);
		expect(map.get("g1")).toBe("asking");
	});

	it("does not count archived rows", () => {
		const rows = [row({ id: "a", folder: "g1", archived: true })];
		const map = urgencyByGroupKey(source({ a: "asking" }), rows, keyOf);
		expect(map.has("g1")).toBe(false);
	});
});

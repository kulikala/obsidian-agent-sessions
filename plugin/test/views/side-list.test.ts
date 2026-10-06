import { describe, expect, it } from "vitest";
import type { Row } from "../../src/sessions/index";
import { computeSideList, leafIdsOf, tabOnlyRow, type TerminalLeafLike } from "../../src/views/side-list";

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

function leaf(id: string | undefined, agent?: string, cwd?: string): TerminalLeafLike {
	return { getViewState: () => ({ state: id === undefined ? undefined : { id, agent, cwd } }) };
}

describe("leafIdsOf", () => {
	it("picks up only leaves whose state.id is a string, in that order", () => {
		expect(leafIdsOf([leaf("a"), leaf(undefined), leaf("b")])).toEqual(["a", "b"]);
	});

	it("is an empty array when there are no leaves", () => {
		expect(leafIdsOf([])).toEqual([]);
	});
});

describe("computeSideList", () => {
	it("sorts open tabs in tab order, and running/recent by last-updated order", () => {
		const sessions = new Map<string, Row>([
			["a", row({ id: "a", daemon: true, last_activity: 10 })],
			["b", row({ id: "b", daemon: true, last_activity: 20 })],
			["c", row({ id: "c", last_activity: 30 })],
			["d", row({ id: "d", last_activity: 5 })],
		]);
		const leaves = [leaf("b"), leaf("a")];

		const list = computeSideList(sessions, leaves, 10);

		// Open tabs: in tab order (the order of leaves).
		expect(list.openTabs.map((r) => r.id)).toEqual(["b", "a"]);
		// Running: no daemon row without a tab (both a and b are already open).
		expect(list.running).toEqual([]);
		// Recent: the rest (c, d), by last-updated order.
		expect(list.recent.map((r) => r.id)).toEqual(["c", "d"]);
	});

	it("limits the recent count via recentCount", () => {
		const sessions = new Map<string, Row>(
			Array.from({ length: 5 }, (_, i) => [String(i), row({ id: String(i), last_activity: i })])
		);

		const list = computeSideList(sessions, [], 2);

		expect(list.recent.map((r) => r.id)).toEqual(["4", "3"]);
	});
});

describe("computeSideList (tabs without a row)", () => {
	const names = new Map([["p", "Test: Codex named"]]);
	const source = {
		pendingName: (id: string) => names.get(id),
		agentEnabled: (agent: string) => agent !== "opencode",
	};

	it("lists an open tab whose session has no row yet, in its tab position, with the name it was given", () => {
		const sessions = new Map<string, Row>([["a", row({ id: "a", daemon: true })]]);
		const list = computeSideList(sessions, [leaf("a"), leaf("p", "codex", "/vault"), leaf("q", "claude", "/vault")], 10, source);

		expect(list.openTabs.map((r) => [r.id, r.agent, r.name, r.tabOnly ?? false])).toEqual([
			["a", "claude", null, false],
			["p", "codex", "Test: Codex named", true],
			["q", "claude", null, true],
		]);
		expect(list.running).toEqual([]);
		expect(list.recent).toEqual([]);
	});

	it("uses the real row once one exists under the tab's id — one row, same place", () => {
		const sessions = new Map<string, Row>([
			["a", row({ id: "a", daemon: true })],
			["real", row({ id: "real", agent: "codex", name: "Test: Codex named", daemon: true })],
		]);
		const list = computeSideList(sessions, [leaf("a"), leaf("real", "codex", "/vault")], 10, source);

		expect(list.openTabs.map((r) => [r.id, r.tabOnly ?? false])).toEqual([
			["a", false],
			["real", false],
		]);
	});

	it("leaves out a tab of a disabled agent, and every rowless tab without a source", () => {
		const leaves = [leaf("o", "opencode", "/vault"), leaf("p", "codex", "/vault")];
		expect(computeSideList(new Map(), leaves, 10, source).openTabs.map((r) => r.id)).toEqual(["p"]);
		expect(computeSideList(new Map(), leaves, 10).openTabs).toEqual([]);
	});
});

describe("tabOnlyRow", () => {
	it("stands in for a running tab with no time shown", () => {
		expect(tabOnlyRow({ id: "p", agent: "codex", cwd: "/vault" }, undefined)).toMatchObject({
			id: "p",
			agent: "codex",
			name: null,
			cwd: "/vault",
			last_activity: 0,
			daemon: true,
			hasTab: true,
			archived: false,
			tabOnly: true,
		});
	});

	it("is null without an id, and Claude when the agent is unknown", () => {
		expect(tabOnlyRow(undefined, "x")).toBeNull();
		expect(tabOnlyRow({ id: "" }, "x")).toBeNull();
		expect(tabOnlyRow({ id: "p" }, "")?.agent).toBe("claude");
	});
});

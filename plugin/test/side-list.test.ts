import { describe, expect, it } from "vitest";
import type { Row } from "../src/index";
import { computeSideList, leafIdsOf, type TerminalLeafLike } from "../src/views/side-list";

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

function leaf(id: string | undefined): TerminalLeafLike {
	return { getViewState: () => ({ state: id === undefined ? undefined : { id } }) };
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

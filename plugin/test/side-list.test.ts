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
	it("state.id が文字列の leaf だけ、その順で拾う", () => {
		expect(leafIdsOf([leaf("a"), leaf(undefined), leaf("b")])).toEqual(["a", "b"]);
	});

	it("leaf が無ければ空配列", () => {
		expect(leafIdsOf([])).toEqual([]);
	});
});

describe("computeSideList", () => {
	it("開いているタブはタブの順、起動中・最近は最終更新順に区分けする", () => {
		const sessions = new Map<string, Row>([
			["a", row({ id: "a", daemon: true, last_activity: 10 })],
			["b", row({ id: "b", daemon: true, last_activity: 20 })],
			["c", row({ id: "c", last_activity: 30 })],
			["d", row({ id: "d", last_activity: 5 })],
		]);
		const leaves = [leaf("b"), leaf("a")];

		const list = computeSideList(sessions, leaves, 10);

		// 開いているタブ：タブの順（leaves の並び）。
		expect(list.openTabs.map((r) => r.id)).toEqual(["b", "a"]);
		// 起動中：タブが無い daemon 行は無い（a・b とも開いている）。
		expect(list.running).toEqual([]);
		// 最近：残り（c, d）を最終更新順。
		expect(list.recent.map((r) => r.id)).toEqual(["c", "d"]);
	});

	it("recentCount で最近の件数を絞る", () => {
		const sessions = new Map<string, Row>(
			Array.from({ length: 5 }, (_, i) => [String(i), row({ id: String(i), last_activity: i })])
		);

		const list = computeSideList(sessions, [], 2);

		expect(list.recent.map((r) => r.id)).toEqual(["4", "3"]);
	});
});

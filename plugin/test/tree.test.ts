import { describe, expect, it } from "vitest";
import type { Row } from "../src/index";
import { emptyStore, type Store } from "../src/store";
import { buildManagerTree, buildSideList, OTHER_GROUP, splitName } from "../src/tree";

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

function store(overrides: Partial<Store> = {}): Store {
	return { ...emptyStore(), ...overrides };
}

describe("splitName", () => {
	it("splits on ': '", () => {
		// Japanese fixture: realistic category/name pair used elsewhere in the suite.
		expect(splitName("RIM: 議事メモ作成")).toEqual(["RIM", "議事メモ作成"]);
	});

	it("no group when there's no separator", () => {
		expect(splitName("酔い酒鮨庵")).toEqual([null, "酔い酒鮨庵"]);
	});

	it("does not split when one side is empty", () => {
		expect(splitName(": 名前だけ")).toEqual([null, ": 名前だけ"]);
		expect(splitName("RIM: ")).toEqual([null, "RIM: "]);
	});
});

describe("buildManagerTree", () => {
	it("orders groups, then Others (merging no-category and no-name, most-recent first)", () => {
		// Japanese fixtures: realistic category/name pairs used elsewhere in the suite.
		const rows: Row[] = [
			row({ id: "1", name: "RIM: 議事メモ作成", last_activity: 300 }),
			row({ id: "2", name: "RIM: Fit&Gap進め方", last_activity: 400 }),
			row({ id: "3", name: "酔い酒鮨庵", last_activity: 200 }),
			row({ id: "4", name: null, child: false, last_activity: 100 }),
			row({ id: "5", name: "Uncategorized but new", last_activity: 500 }),
		];
		const tree = buildManagerTree(rows, store());

		expect(tree.groups).toHaveLength(1);
		expect(tree.groups[0].name).toBe("RIM");
		// Within a group, ordered by last activity (most recent first).
		expect(tree.groups[0].rows.map((r) => r.id)).toEqual(["2", "1"]);

		// "Others" merges the named-but-uncategorized rows (3, 5) with the unnamed one (4)
		// into a single list, ordered by last activity.
		expect(tree.others.rows.map((r) => r.id)).toEqual(["5", "3", "4"]);
	});

	it("unnamed child sessions don't appear in Others", () => {
		const rows: Row[] = [
			row({ id: "1", name: null, child: true, last_activity: 100 }),
			row({ id: "2", name: null, child: false, last_activity: 200 }),
		];
		const tree = buildManagerTree(rows, store());

		expect(tree.others.rows.map((r) => r.id)).toEqual(["2"]);
		expect(tree.groups).toHaveLength(0);
	});

	it("archived rows appear in neither groups nor others", () => {
		// Japanese fixtures: realistic category/name pairs used elsewhere in the suite.
		const rows: Row[] = [
			row({ id: "1", name: "RIM: 議事メモ作成", archived: true, last_activity: 300 }),
			row({ id: "2", name: "Uncategorized session", archived: true, last_activity: 200 }),
			row({ id: "3", name: null, child: false, archived: true, last_activity: 100 }),
			row({ id: "4", name: "RIM: Still alive", archived: false, last_activity: 50 }),
		];
		const st = store({ archived: [{ id: "1", name: "議事メモ作成", agent: "claude" }] });
		const tree = buildManagerTree(rows, st);

		expect(tree.groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual(["4"]);
		expect(tree.others.rows).toHaveLength(0);
		expect(tree.archived.map((a) => a.id).sort()).toEqual(["1", "2", "3"]);
	});

	it("also surfaces from the archived list a session that's in store.archived but not found in the scan", () => {
		const st = store({ archived: [{ id: "ghost", name: "Deleted session", agent: "claude" }] });
		const tree = buildManagerTree([], st);

		expect(tree.archived).toEqual([{ id: "ghost", name: "Deleted session", agent: "claude", row: null }]);
	});

	it("folded state comes from OTHER_GROUP in store.folded", () => {
		const rows: Row[] = [row({ id: "1", name: "RIM: x" }), row({ id: "2", name: "Name without category" })];
		const st = store({ folded: ["RIM", OTHER_GROUP] });
		const tree = buildManagerTree(rows, st);

		expect(tree.groups[0].folded).toBe(true);
		expect(tree.others.folded).toBe(true);
	});

	it("the merged Others is still treated as folded when only the old no-category identifier (__no_category__) is folded (backward compatibility)", () => {
		const rows: Row[] = [row({ id: "1", name: "Name without category" })];
		const st = store({ folded: ["__no_category__"] });
		const tree = buildManagerTree(rows, st);

		expect(tree.others.folded).toBe(true);
	});
});

describe("buildSideList", () => {
	it("open tabs are ordered by tab order; running sessions are the ones without a tab", () => {
		const rows: Row[] = [
			row({ id: "a", daemon: true, hasTab: true, last_activity: 10 }),
			row({ id: "b", daemon: true, hasTab: false, last_activity: 20 }),
			row({ id: "c", daemon: false, hasTab: false, last_activity: 30 }),
		];
		const list = buildSideList(rows, ["a"], 10);

		expect(list.openTabs.map((r) => r.id)).toEqual(["a"]);
		expect(list.running.map((r) => r.id)).toEqual(["b"]);
		expect(list.recent.map((r) => r.id)).toEqual(["c"]);
	});

	it("recent is capped at N entries", () => {
		const rows: Row[] = Array.from({ length: 15 }, (_, i) => row({ id: String(i), last_activity: i }));
		const list = buildSideList(rows, [], 10);

		expect(list.recent).toHaveLength(10);
		// Most recent last_activity first (the id equals its last_activity number).
		expect(list.recent.map((r) => r.id)).toEqual(["14", "13", "12", "11", "10", "9", "8", "7", "6", "5"]);
	});

	it("archived and unnamed child sessions don't appear in recent", () => {
		const rows: Row[] = [
			row({ id: "1", name: "Named", archived: true, last_activity: 300 }),
			row({ id: "2", name: null, child: true, last_activity: 200 }),
			row({ id: "3", name: null, child: false, last_activity: 100 }),
		];
		const list = buildSideList(rows, [], 10);

		expect(list.recent.map((r) => r.id)).toEqual(["3"]);
	});
});

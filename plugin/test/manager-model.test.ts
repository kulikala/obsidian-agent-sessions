import { describe, expect, it } from "vitest";
import type { Row } from "../src/index";
import { OTHER_GROUP, type ManagerTree } from "../src/tree";
import type { StatsResult, StatsUsage, StatsWindow } from "../src/types";
import {
	ARCHIVED_GROUP,
	flattenTree,
	moveSelection,
	sessionCost,
	sortRows,
	windowSummary,
	type ManagerRow,
} from "../src/views/manager-model";

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
		pid: null,
		rc: false,
		daemon: false,
		exited: null,
		hasTab: false,
		archived: false,
		...overrides,
	};
}

function tree(overrides: Partial<ManagerTree> = {}): ManagerTree {
	return {
		groups: [],
		singles: [],
		others: { folded: false, rows: [] },
		archived: [],
		...overrides,
	};
}

describe("flattenTree（D-44）", () => {
	it("グループ→単独→その他の順に見出しと子を並べる", () => {
		const g1 = row({ id: "1", name: "RIM: 議事メモ" });
		const single = row({ id: "2", name: "単独" });
		const other = row({ id: "3", name: null });
		const t = tree({
			groups: [{ name: "RIM", folded: false, rows: [g1] }],
			singles: [single],
			others: { folded: false, rows: [other] },
		});
		const rows = flattenTree(t, false);
		expect(rows).toEqual<ManagerRow[]>([
			{ kind: "group", key: "RIM", label: "RIM", count: 1, folded: false },
			{ kind: "session", row: g1, indent: true },
			{ kind: "session", row: single, indent: false },
			{ kind: "group", key: OTHER_GROUP, label: OTHER_GROUP, count: 1, folded: false },
			{ kind: "session", row: other, indent: true },
		]);
	});

	it("畳まれたグループは子を出さない", () => {
		const child = row({ id: "1", name: "RIM: 議事メモ" });
		const t = tree({ groups: [{ name: "RIM", folded: true, rows: [child] }] });
		const rows = flattenTree(t, false);
		expect(rows).toEqual<ManagerRow[]>([{ kind: "group", key: "RIM", label: "RIM", count: 1, folded: true }]);
	});

	it("その他が空なら見出しを出さない", () => {
		const t = tree({ others: { folded: false, rows: [] } });
		expect(flattenTree(t, false)).toEqual([]);
	});

	it("showArchived が偽ならアーカイブを出さない", () => {
		const t = tree({ archived: [{ id: "1", name: "旧", agent: "claude", row: null }] });
		expect(flattenTree(t, false)).toEqual([]);
	});

	it("showArchived が真なら見出し＋子（畳まない）。row が無ければ archived-orphan", () => {
		const withRow = row({ id: "1", name: "残っている" });
		const t = tree({
			archived: [
				{ id: "1", name: "残っている", agent: "claude", row: withRow },
				{ id: "2", name: "もう無い", agent: "claude", row: null },
			],
		});
		const rows = flattenTree(t, true);
		expect(rows).toEqual<ManagerRow[]>([
			{ kind: "group", key: ARCHIVED_GROUP, label: "アーカイブ（2）", count: 2, folded: false },
			{ kind: "session", row: withRow, indent: true },
			{ kind: "archived-orphan", id: "2", name: "もう無い" },
		]);
	});

	it("アーカイブが空なら showArchived が真でも見出しを出さない", () => {
		expect(flattenTree(tree({ archived: [] }), true)).toEqual([]);
	});
});

describe("moveSelection（D-44）", () => {
	const rows: ManagerRow[] = [
		{ kind: "session", row: row({ id: "1" }), indent: false },
		{ kind: "session", row: row({ id: "2" }), indent: false },
		{ kind: "session", row: row({ id: "3" }), indent: false },
	];

	it("範囲内なら delta を足すだけ", () => {
		expect(moveSelection(rows, 1, 1)).toBe(2);
		expect(moveSelection(rows, 1, -1)).toBe(0);
	});

	it("下端・上端を超えない", () => {
		expect(moveSelection(rows, 2, 1)).toBe(2);
		expect(moveSelection(rows, 0, -1)).toBe(0);
	});

	it("delta: 0 は現在値をクランプするだけ（選択の再検証に使える）", () => {
		expect(moveSelection(rows, 5, 0)).toBe(2);
		expect(moveSelection(rows, -1, 0)).toBe(0);
	});

	it("行が無ければ -1", () => {
		expect(moveSelection([], 0, 1)).toBe(-1);
	});

	it("cur が -1（未選択）から下へ行くと先頭に入る", () => {
		expect(moveSelection(rows, -1, 1)).toBe(0);
	});
});

function usage(cost: number): StatsUsage {
	return { calls: 1, input: 0, output: 0, cache_read: 0, cache_create: 0, cost };
}

function statsWindow(overrides: Partial<StatsWindow> = {}): StatsWindow {
	return {
		start: 0,
		end: 100,
		used_percentage: null,
		total: { calls: 0, input: 0, output: 0, cache_read: 0, cache_create: 0, cost: 0 },
		sessions: {},
		...overrides,
	};
}

describe("sessionCost（D-54）", () => {
	it("枠が無ければ null", () => {
		expect(sessionCost(null, "1")).toBeNull();
	});

	it("枠内にそのセッションの使用が無ければ null", () => {
		const w = statsWindow({ sessions: { "1": usage(2.5) } });
		expect(sessionCost(w, "2")).toBeNull();
	});

	it("有ればそのコスト", () => {
		const w = statsWindow({ sessions: { "1": usage(2.5) } });
		expect(sessionCost(w, "1")).toBe(2.5);
	});
});

describe("sortRows（D-54）", () => {
	it("updated はそのまま（グループの木の並び）を返す", () => {
		const rows: ManagerRow[] = [{ kind: "session", row: row({ id: "1" }), indent: false }];
		expect(sortRows(rows, "updated", null)).toBe(rows);
	});

	it("5h／7d はグループを外し、枠内のコストの降順に並べる。使用の無い行は下", () => {
		const g1 = row({ id: "1" });
		const g2 = row({ id: "2" });
		const single = row({ id: "3" });
		const rows: ManagerRow[] = [
			{ kind: "group", key: "G", label: "G", count: 2, folded: false },
			{ kind: "session", row: g1, indent: true },
			{ kind: "session", row: g2, indent: true },
			{ kind: "session", row: single, indent: false },
			{ kind: "archived-orphan", id: "9", name: "旧" },
		];
		const stats: StatsResult = {
			windows: {
				five_hour: statsWindow({ sessions: { "1": usage(1), "3": usage(5) } }),
				seven_day: statsWindow(),
			},
		};
		const sorted = sortRows(rows, "5h", stats);
		expect(sorted.map((r) => (r.kind === "session" ? r.row.id : r.kind))).toEqual(["3", "1", "2"]);
		expect(sorted.every((r) => r.kind === "session" && r.indent === false)).toBe(true);
	});

	it("stats が無ければ全行が使用無し扱い（渡された順のまま）", () => {
		const rows: ManagerRow[] = [
			{ kind: "session", row: row({ id: "1" }), indent: true },
			{ kind: "session", row: row({ id: "2" }), indent: false },
		];
		const sorted = sortRows(rows, "7d", null);
		expect(sorted.map((r) => (r.kind === "session" ? r.row.id : null))).toEqual(["1", "2"]);
	});
});

describe("windowSummary（D-54）", () => {
	it("トークンは入力＋出力＋cache 読出＋cache 作成、セッション数は sessions のキー数", () => {
		const w = statsWindow({
			total: { calls: 3, input: 10, output: 20, cache_read: 5, cache_create: 1, cost: 1.23 },
			sessions: { a: usage(1), b: usage(2) },
		});
		expect(windowSummary(w)).toEqual({ tokens: 36, sessionCount: 2 });
	});

	it("sessions が空なら 0", () => {
		expect(windowSummary(statsWindow()).sessionCount).toBe(0);
	});
});

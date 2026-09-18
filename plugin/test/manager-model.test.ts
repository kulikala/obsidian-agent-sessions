import { describe, expect, it } from "vitest";
import type { Row } from "../src/index";
import { OTHER_GROUP, type ManagerTree } from "../src/tree";
import { ARCHIVED_GROUP, flattenTree, moveSelection, type ManagerRow } from "../src/views/manager-model";

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

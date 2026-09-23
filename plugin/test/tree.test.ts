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
	it("': ' で分ける", () => {
		expect(splitName("RIM: 議事メモ作成")).toEqual(["RIM", "議事メモ作成"]);
	});

	it("区切りが無ければグループ無し", () => {
		expect(splitName("酔い酒鮨庵")).toEqual([null, "酔い酒鮨庵"]);
	});

	it("片側が空なら区切らない", () => {
		expect(splitName(": 名前だけ")).toEqual([null, ": 名前だけ"]);
		expect(splitName("RIM: ")).toEqual([null, "RIM: "]);
	});
});

describe("buildManagerTree", () => {
	it("グループ→その他（カテゴリなし＋名前なしを統合、最終更新順）の順に組む", () => {
		const rows: Row[] = [
			row({ id: "1", name: "RIM: 議事メモ作成", last_activity: 300 }),
			row({ id: "2", name: "RIM: Fit&Gap進め方", last_activity: 400 }),
			row({ id: "3", name: "酔い酒鮨庵", last_activity: 200 }),
			row({ id: "4", name: null, child: false, last_activity: 100 }),
			row({ id: "5", name: "カテゴリなしだが新しい", last_activity: 500 }),
		];
		const tree = buildManagerTree(rows, store());

		expect(tree.groups).toHaveLength(1);
		expect(tree.groups[0].name).toBe("RIM");
		// グループ内は最終更新順（新しい順）。
		expect(tree.groups[0].rows.map((r) => r.id)).toEqual(["2", "1"]);

		// 「その他」はカテゴリの無い名前付き（3・5）と名前の無い（4）を 1 つにまとめ、
		// 最終更新順（T-74 追補）。
		expect(tree.others.rows.map((r) => r.id)).toEqual(["5", "3", "4"]);
	});

	it("無名の子はその他に出ない", () => {
		const rows: Row[] = [
			row({ id: "1", name: null, child: true, last_activity: 100 }),
			row({ id: "2", name: null, child: false, last_activity: 200 }),
		];
		const tree = buildManagerTree(rows, store());

		expect(tree.others.rows.map((r) => r.id)).toEqual(["2"]);
		expect(tree.groups).toHaveLength(0);
	});

	it("アーカイブは出ない（groups/others のどこにも）", () => {
		const rows: Row[] = [
			row({ id: "1", name: "RIM: 議事メモ作成", archived: true, last_activity: 300 }),
			row({ id: "2", name: "カテゴリなしセッション", archived: true, last_activity: 200 }),
			row({ id: "3", name: null, child: false, archived: true, last_activity: 100 }),
			row({ id: "4", name: "RIM: 生きてる方", archived: false, last_activity: 50 }),
		];
		const st = store({ archived: [{ id: "1", name: "議事メモ作成", agent: "claude" }] });
		const tree = buildManagerTree(rows, st);

		expect(tree.groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual(["4"]);
		expect(tree.others.rows).toHaveLength(0);
		expect(tree.archived.map((a) => a.id).sort()).toEqual(["1", "2", "3"]);
	});

	it("store.archived にあって走査に出てこないセッションも控えから出す", () => {
		const st = store({ archived: [{ id: "ghost", name: "消えたセッション", agent: "claude" }] });
		const tree = buildManagerTree([], st);

		expect(tree.archived).toEqual([{ id: "ghost", name: "消えたセッション", agent: "claude", row: null }]);
	});

	it("folded は store.folded の OTHER_GROUP から", () => {
		const rows: Row[] = [row({ id: "1", name: "RIM: x" }), row({ id: "2", name: "カテゴリなしの名前" })];
		const st = store({ folded: ["RIM", OTHER_GROUP] });
		const tree = buildManagerTree(rows, st);

		expect(tree.groups[0].folded).toBe(true);
		expect(tree.others.folded).toBe(true);
	});

	it("旧『カテゴリなし』の識別子（__no_category__）だけが畳んであっても、統合後の「その他」は畳んだ扱い（後方互換）", () => {
		const rows: Row[] = [row({ id: "1", name: "カテゴリなしの名前" })];
		const st = store({ folded: ["__no_category__"] });
		const tree = buildManagerTree(rows, st);

		expect(tree.others.folded).toBe(true);
	});
});

describe("buildSideList", () => {
	it("開いているタブはタブの順、起動中はタブが無いもの", () => {
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

	it("最近は N 件まで", () => {
		const rows: Row[] = Array.from({ length: 15 }, (_, i) => row({ id: String(i), last_activity: i }));
		const list = buildSideList(rows, [], 10);

		expect(list.recent).toHaveLength(10);
		// 最終更新の新しい順（id は last_activity と同じ数字）。
		expect(list.recent.map((r) => r.id)).toEqual(["14", "13", "12", "11", "10", "9", "8", "7", "6", "5"]);
	});

	it("アーカイブ済みと名前の無い子セッションは最近に出さない", () => {
		const rows: Row[] = [
			row({ id: "1", name: "名前あり", archived: true, last_activity: 300 }),
			row({ id: "2", name: null, child: true, last_activity: 200 }),
			row({ id: "3", name: null, child: false, last_activity: 100 }),
		];
		const list = buildSideList(rows, [], 10);

		expect(list.recent.map((r) => r.id)).toEqual(["3"]);
	});
});

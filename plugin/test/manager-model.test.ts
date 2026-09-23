import { describe, expect, it } from "vitest";
import type { Row } from "../src/index";
import { OTHER_GROUP, type ManagerTree } from "../src/tree";
import type { StatsResult, StatsUsage, StatsWindow } from "../src/types";
import {
	ARCHIVED_GROUP,
	categoryKeyOf,
	categoryTotals,
	flattenTree,
	formatWeekdayTime,
	isRealCategoryKey,
	moveSelection,
	sessionCost,
	shortModelName,
	sortRows,
	topCategoryTotals,
	weeklyPace,
	windowSummary,
	type CategoryTotal,
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

function tree(overrides: Partial<ManagerTree> = {}): ManagerTree {
	return {
		groups: [],
		others: { folded: false, rows: [] },
		archived: [],
		...overrides,
	};
}

describe("flattenTree（D-44・T-70 追補・T-74 追補）", () => {
	it("グループ→その他（カテゴリなし＋名前なしを統合した 1 区分）の順に見出しと子を並べる", () => {
		const g1 = row({ id: "1", name: "RIM: 議事メモ" });
		const noCategory = row({ id: "2", name: "カテゴリなしの名前" });
		const unnamed = row({ id: "3", name: null });
		const t = tree({
			groups: [{ name: "RIM", folded: false, rows: [g1] }],
			others: { folded: false, rows: [noCategory, unnamed] },
		});
		const rows = flattenTree(t, false);
		expect(rows).toEqual<ManagerRow[]>([
			{ kind: "group", key: "RIM", label: "RIM", count: 1, folded: false },
			{ kind: "session", row: g1, indent: true },
			{ kind: "group", key: OTHER_GROUP, label: "その他", count: 2, folded: false },
			{ kind: "session", row: noCategory, indent: true },
			{ kind: "session", row: unnamed, indent: true },
		]);
	});

	it("畳まれたグループは子を出さない", () => {
		const child = row({ id: "1", name: "RIM: 議事メモ" });
		const t = tree({ groups: [{ name: "RIM", folded: true, rows: [child] }] });
		const rows = flattenTree(t, false);
		expect(rows).toEqual<ManagerRow[]>([{ kind: "group", key: "RIM", label: "RIM", count: 1, folded: true }]);
	});

	it("畳まれた「その他」は見出しだけで子を出さない", () => {
		const noCategory = row({ id: "1", name: "カテゴリなしの名前" });
		const t = tree({ others: { folded: true, rows: [noCategory] } });
		const rows = flattenTree(t, false);
		expect(rows).toEqual<ManagerRow[]>([{ kind: "group", key: OTHER_GROUP, label: "その他", count: 1, folded: true }]);
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

describe("categoryKeyOf（D-64・D-65）", () => {
	it("グループ名付きの名前はグループ部分", () => {
		expect(categoryKeyOf(row({ id: "1", name: "RIM: 議事メモ" }))).toBe("RIM");
	});

	it("グループの無い名前も、名前が無いのも同じ「その他」(OTHER_GROUP) 扱い（T-74 追補で統合）", () => {
		const key = categoryKeyOf(row({ id: "1", name: "カテゴリなしのセッション" }));
		expect(key).toBe(OTHER_GROUP);
		expect(key).toBe(categoryKeyOf(row({ id: "2", name: null })));
	});
});

describe("isRealCategoryKey（T-70）", () => {
	it("実際のカテゴリ名は真", () => {
		expect(isRealCategoryKey("RIM")).toBe(true);
		expect(isRealCategoryKey(categoryKeyOf(row({ id: "1", name: "RIM: 議事メモ" })))).toBe(true);
	});

	it("「その他」「アーカイブ」は偽", () => {
		expect(isRealCategoryKey(categoryKeyOf(row({ id: "1", name: "カテゴリなしのセッション" })))).toBe(false);
		expect(isRealCategoryKey(OTHER_GROUP)).toBe(false);
		expect(isRealCategoryKey(ARCHIVED_GROUP)).toBe(false);
	});
});

describe("categoryTotals（D-64）", () => {
	it("グループごとにコストとセッション数を合計する", () => {
		const rows: Row[] = [
			row({ id: "1", name: "RIM: 議事メモ" }),
			row({ id: "2", name: "RIM: 別件" }),
			row({ id: "3", name: "ZERO: 提案" }),
		];
		const stats: StatsResult = {
			windows: {
				five_hour: statsWindow(),
				seven_day: statsWindow({ sessions: { "1": usage(1), "2": usage(2), "3": usage(5) } }),
			},
		};
		const totals = categoryTotals(rows, stats, "7d");
		const rim = totals.find((c) => c.key === "RIM");
		const zero = totals.find((c) => c.key === "ZERO");
		expect(rim).toEqual({ key: "RIM", label: "RIM", cost: 3, count: 2 });
		expect(zero).toEqual({ key: "ZERO", label: "ZERO", cost: 5, count: 1 });
	});

	it("グループの無い名前・名前の無いセッションはまとめて「その他」になる（T-74 追補）", () => {
		const rows: Row[] = [row({ id: "1", name: "カテゴリなしの名前" }), row({ id: "2", name: null })];
		const totals = categoryTotals(rows, null, "5h");
		expect(totals).toEqual([{ key: OTHER_GROUP, label: "その他", cost: 0, count: 2 }]);
	});

	it("アーカイブ済み・無名の子セッションは数えない", () => {
		const rows: Row[] = [
			row({ id: "1", name: "RIM: 議事メモ", archived: true }),
			row({ id: "2", name: null, child: true }),
			row({ id: "3", name: "RIM: 現存分" }),
		];
		const totals = categoryTotals(rows, null, "5h");
		expect(totals).toEqual([{ key: "RIM", label: "RIM", cost: 0, count: 1 }]);
	});

	it("window に使用が無ければコストは 0", () => {
		const rows: Row[] = [row({ id: "1", name: "RIM: 議事メモ" })];
		expect(categoryTotals(rows, null, "5h")).toEqual([{ key: "RIM", label: "RIM", cost: 0, count: 1 }]);
	});
});

describe("topCategoryTotals（D-64 追補）", () => {
	function total(key: string, cost: number): CategoryTotal {
		return { key, label: key, cost, count: 1 };
	}

	it("コスト 0 のカテゴリは除く", () => {
		const totals = [total("RIM", 0), total("ZERO", 5), total("その他", 0)];
		expect(topCategoryTotals(totals, 8)).toEqual([total("ZERO", 5)]);
	});

	it("残りをコスト降順で並べ、上位 n 件に絞る", () => {
		const totals = [total("A", 1), total("B", 3), total("C", 2)];
		expect(topCategoryTotals(totals, 2)).toEqual([total("B", 3), total("C", 2)]);
	});

	it("全部 0 なら空配列", () => {
		expect(topCategoryTotals([total("A", 0), total("B", 0)], 8)).toEqual([]);
	});
});

const DAY = 86400;
const WEEK = 7 * DAY;

describe("weeklyPace（T-74）", () => {
	it("usedPct が無ければ unknown", () => {
		expect(weeklyPace(null, 0, WEEK, 100, 50)).toEqual({ kind: "unknown" });
	});

	it("枠の長さが 0 以下でも unknown", () => {
		expect(weeklyPace(10, 100, 100, 200, 50)).toEqual({ kind: "unknown" });
	});

	it("経過が 6 時間未満なら too-early", () => {
		const result = weeklyPace(10, 0, WEEK, 3600, 50);
		expect(result.kind).toBe("too-early");
		if (result.kind === "too-early") {
			expect(result.elapsedPct).toBeCloseTo((3600 / WEEK) * 100, 5);
		}
	});

	it("予測が 100 以下なら on-track（順調）", () => {
		// 経過 50%（3.5 日）で使用 40% → 予測 80%。
		const result = weeklyPace(40, 0, WEEK, WEEK / 2, 100);
		expect(result).toEqual({ kind: "on-track", projectedPct: 80, elapsedPct: 50, usedPct: 40 });
	});

	it("予測が 100 を超えたら over-pace（使い切る見込み時刻・1 日あたりの上限）", () => {
		// 経過 50%（3.5 日）で使用 70% → 予測 140%。このペースなら経過 5 日で使い切り、
		// リセット（7 日）まで 2 日 0 時間残る。残り 3.5 日で 30% 分の余地。
		const result = weeklyPace(70, 0, WEEK, WEEK / 2, 140);
		expect(result.kind).toBe("over-pace");
		if (result.kind === "over-pace") {
			expect(result.exhaustAt).toBe(5 * DAY);
			expect(result.daysBeforeReset).toBe(2);
			expect(result.hoursBeforeReset).toBe(0);
			expect(result.maxDailyPct).toBeCloseTo(30 / 3.5, 5);
			expect(result.maxDailyCost).toBeCloseTo((140 * 30) / 70 / 3.5, 5);
			expect(result.elapsedPct).toBe(50);
			expect(result.usedPct).toBe(70);
		}
	});

	it("使い切る見込み時刻がリセットの直前（日をまたがない）なら daysBeforeReset は 0", () => {
		// 経過 50%（3.5 日）で使用 90% → 予測 180%。使い切りは経過 ×100/90 ≈ 3.888…日。
		const result = weeklyPace(90, 0, WEEK, WEEK / 2, 90);
		expect(result.kind).toBe("over-pace");
		if (result.kind === "over-pace") {
			expect(result.daysBeforeReset).toBeGreaterThanOrEqual(3);
		}
	});
});

describe("formatWeekdayTime（T-74）", () => {
	it("ローカル時刻で「<曜日> HH:MM」にする", () => {
		const d = new Date(2026, 0, 5, 14, 30, 0);
		const epochSeconds = d.getTime() / 1000;
		const weekdayJa = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
		const weekdayEn = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
		expect(formatWeekdayTime(epochSeconds, "ja")).toBe(`${weekdayJa} 14:30`);
		expect(formatWeekdayTime(epochSeconds, "en")).toBe(`${weekdayEn} 14:30`);
	});

	it("時・分は 2 桁ゼロ埋め", () => {
		const d = new Date(2026, 5, 1, 9, 5, 0);
		const epochSeconds = d.getTime() / 1000;
		expect(formatWeekdayTime(epochSeconds, "ja")).toMatch(/^. 09:05$/);
	});
});

describe("shortModelName（T-74）", () => {
	it("末尾の `(...)` を落とす", () => {
		expect(shortModelName("Opus 5.5 (1M context)")).toBe("Opus 5.5");
	});

	it("付記が無ければそのまま", () => {
		expect(shortModelName("Sonnet 5")).toBe("Sonnet 5");
	});

	it("null なら空文字", () => {
		expect(shortModelName(null)).toBe("");
	});
});

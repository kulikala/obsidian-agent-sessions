// セッションマネージャーの表（純関数。D-44）。`ManagerTree`（`tree.ts`）を、
// ↑↓ で辿れる 1 本の行の列に平らにする。`obsidian` には依存しない
// （テストは test/manager-model.test.ts）。

import type { Row } from "../index";
import { t } from "../i18n";
import { NO_CATEGORY_GROUP, OTHER_GROUP, splitName, type ManagerTree } from "../tree";
import type { StatsResult, StatsWindow } from "../types";

/** 折畳の対象にならない特別なグループ鍵（アーカイブの見出し）。 */
export const ARCHIVED_GROUP = "__archived__";

export type ManagerRow =
	| { kind: "group"; key: string; label: string; count: number; folded: boolean }
	| { kind: "session"; row: Row; indent: boolean }
	/** アーカイブの控えはあるが `json scan` に出てこない（もう存在しない）セッション。 */
	| { kind: "archived-orphan"; id: string; name: string };

/**
 * グループ（見出し→畳んでなければ子）→ カテゴリなし（見出し→子）→ その他のセッション
 * （見出し→子）→ `showArchived` なら アーカイブ（見出し→子。常に展開）、の順に 1 本へ
 * 平らにする。カテゴリなし・その他のセッションも他のグループと同じ見出し付きの区分にし、
 * 直前のグループの最後の行と続いて見えないようにする（T-70 追補）。
 */
export function flattenTree(tree: ManagerTree, showArchived: boolean): ManagerRow[] {
	const out: ManagerRow[] = [];

	for (const group of tree.groups) {
		out.push({ kind: "group", key: group.name, label: group.name, count: group.rows.length, folded: group.folded });
		if (!group.folded) {
			for (const row of group.rows) {
				out.push({ kind: "session", row, indent: true });
			}
		}
	}

	if (tree.singles.rows.length > 0) {
		out.push({
			// `key` は `store.folded` の識別子（`tree.ts` の `NO_CATEGORY_GROUP` と同じ値）。
			key: NO_CATEGORY_GROUP,
			kind: "group",
			label: t("category.single"),
			count: tree.singles.rows.length,
			folded: tree.singles.folded,
		});
		if (!tree.singles.folded) {
			for (const row of tree.singles.rows) {
				out.push({ kind: "session", row, indent: true });
			}
		}
	}

	if (tree.others.rows.length > 0) {
		out.push({
			kind: "group",
			// `key` は `store.folded` の識別子（`tree.ts` の `OTHER_GROUP` と同じ値）——表示言語を
			// 変えても畳んだ状態が保てるよう、キーとラベルは別に持つ（ラベルだけ `t()` で描く）。
			key: OTHER_GROUP,
			label: t("group.other"),
			count: tree.others.rows.length,
			folded: tree.others.folded,
		});
		if (!tree.others.folded) {
			for (const row of tree.others.rows) {
				out.push({ kind: "session", row, indent: true });
			}
		}
	}

	if (showArchived && tree.archived.length > 0) {
		out.push({
			kind: "group",
			key: ARCHIVED_GROUP,
			label: t("group.archived", { count: tree.archived.length }),
			count: tree.archived.length,
			folded: false,
		});
		for (const entry of tree.archived) {
			if (entry.row) {
				out.push({ kind: "session", row: entry.row, indent: true });
			} else {
				out.push({ kind: "archived-orphan", id: entry.id, name: entry.name });
			}
		}
	}

	return out;
}

/** `cur + delta` を `[0, rows.length - 1]` に収める。`rows` が空なら `-1`。`delta: 0` は現在値の再クランプに使える。 */
export function moveSelection(rows: ManagerRow[], cur: number, delta: number): number {
	if (rows.length === 0) {
		return -1;
	}
	return Math.max(0, Math.min(cur + delta, rows.length - 1));
}

/** 表の並べ替え鍵。`updated` は `flattenTree` の並び（グループの木）そのまま。 */
export type SortKey = "updated" | "5h" | "7d";

/** `window` の中の `id` のコスト。枠内に使用が無ければ `null`（D-54）。 */
export function sessionCost(window: StatsWindow | null | undefined, id: string): number | null {
	const entry = window?.sessions[id];
	return entry ? entry.cost : null;
}

function windowOf(stats: StatsResult | null, key: "5h" | "7d"): StatsWindow | null {
	if (!stats) {
		return null;
	}
	return key === "5h" ? stats.windows.five_hour : stats.windows.seven_day;
}

/**
 * `key` に応じて表の行を並べ替える（D-54）。`updated` は渡された順（グループの木）を
 * そのまま返す。`5h`／`7d` はグループ・アーカイブの控えを外し、セッション行だけを
 * 枠内のコストの降順に並べる（使用が無い行は下・グループには属さない一覧になる）。
 */
export function sortRows(rows: ManagerRow[], key: SortKey, stats: StatsResult | null): ManagerRow[] {
	if (key === "updated") {
		return rows;
	}
	const window = windowOf(stats, key);
	const sessions = rows.filter((r): r is Extract<ManagerRow, { kind: "session" }> => r.kind === "session");
	return sessions
		.map((r) => ({ row: r, cost: sessionCost(window, r.row.id) }))
		.sort((a, b) => {
			if (a.cost === null && b.cost === null) {
				return 0;
			}
			if (a.cost === null) {
				return 1;
			}
			if (b.cost === null) {
				return -1;
			}
			return b.cost - a.cost;
		})
		.map(({ row }): ManagerRow => ({ ...row, indent: false }));
}

/** 枠のカードに出すトークン数（入力＋出力＋cache 読出＋cache 作成）と、動いたセッション数（D-54）。 */
export interface WindowSummary {
	tokens: number;
	sessionCount: number;
}

export function windowSummary(w: StatsWindow): WindowSummary {
	return {
		tokens: w.total.input + w.total.output + w.total.cache_read + w.total.cache_create,
		sessionCount: Object.keys(w.sessions).length,
	};
}

/**
 * `row` のカテゴリ鍵（D-64・D-65）：名前があればグループ部分（無ければ `NO_CATEGORY_GROUP`
 * 「カテゴリなし」）、名前が無ければ `OTHER_GROUP`「その他のセッション」（表示は「名前なし」）。
 * `flattenTree` の分類（グループ／カテゴリなし／その他）と揃える。
 */
export function categoryKeyOf(row: Row): string {
	if (row.name) {
		const [group] = splitName(row.name);
		return group ?? NO_CATEGORY_GROUP;
	}
	return OTHER_GROUP;
}

/** `key` が実際のカテゴリ名か（「カテゴリなし」「その他のセッション（名前なし）」「アーカイブ」
 * の見出しではないか）。チップ（T-70）を出すかどうかの判定に使う——カテゴリの色を持たない
 * 区分にはチップを付けない。 */
export function isRealCategoryKey(key: string): boolean {
	return key !== NO_CATEGORY_GROUP && key !== OTHER_GROUP && key !== ARCHIVED_GROUP;
}

export interface CategoryTotal {
	/** グループ名、または `OTHER_GROUP`／`NO_CATEGORY_GROUP`（表のグループ行の `key` と同じ値で
	 * 引ければ揃う）。 */
	key: string;
	/** 画面に出す文字列（「カテゴリなし」「名前なし」はここで日本語化する）。 */
	label: string;
	cost: number;
	count: number;
}

/**
 * カテゴリ（グループ名。無ければ「カテゴリなし」、名前が無ければ「名前なし」）ごとの、
 * `window` 内のコスト合計とセッション数（D-64）。アーカイブ済みと無名の子セッションは
 * 数えない（`buildManagerTree` の `active`・`othersRows` と同じ絞り込み）。
 */
export function categoryTotals(rows: Row[], stats: StatsResult | null, window: "5h" | "7d"): CategoryTotal[] {
	const w = windowOf(stats, window);
	const buckets = new Map<string, CategoryTotal>();
	for (const row of rows) {
		if (row.archived || (!row.name && row.child)) {
			continue;
		}
		const key = categoryKeyOf(row);
		const label = key === NO_CATEGORY_GROUP ? t("category.single") : key === OTHER_GROUP ? t("category.other") : key;
		const bucket = buckets.get(key) ?? { key, label, cost: 0, count: 0 };
		bucket.cost += sessionCost(w, row.id) ?? 0;
		bucket.count += 1;
		buckets.set(key, bucket);
	}
	return [...buckets.values()];
}

/**
 * カテゴリ別バーに出す上位 `n` 件（D-64 追補）：コストが 0 のカテゴリ（その枠に使用が無い）
 * は除く——「7 日枠で動いていない」ことは帯では言わない。残りをコスト降順で並べる。
 */
export function topCategoryTotals(totals: CategoryTotal[], n: number): CategoryTotal[] {
	return totals
		.filter((c) => c.cost > 0)
		.sort((a, b) => b.cost - a.cost)
		.slice(0, n);
}

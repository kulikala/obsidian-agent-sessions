// JSON → グループ木（純関数）（D-7・D-8）。
// グループ＝名前の `': '` より前（`agentsessions/model.py` の `split_name` と同じ）。

import type { Row } from "./index";
import type { Store } from "./store";

/**
 * 「その他」区分の識別子（`store.folded` のキー）。カテゴリの無い名前付きセッションと、
 * 名前の無いセッションをまとめて 1 つの区分にする（T-74 追補：以前は「カテゴリなし」
 * 「名前なし」の 2 区分に分かれていたが、分ける意味が無いため統合した）。
 */
export const OTHER_GROUP = "その他のセッション";
/** 旧「カテゴリなし」区分の識別子（T-70 追補で導入、T-74 追補で `OTHER_GROUP` に統合）。
 * 以前のバージョンでこちらだけ畳んであった場合の後方互換のためだけに読む
 * （`buildManagerTree` の折畳判定）。新規に書き込むことはもう無い。 */
const LEGACY_NO_CATEGORY_GROUP = "__no_category__";

const GROUP_SEP = ": ";

/** `"RIM: 議事メモ作成"` → `["RIM", "議事メモ作成"]`。区切りが無ければ `[null, name]`。 */
export function splitName(name: string): [string | null, string] {
	const idx = name.indexOf(GROUP_SEP);
	if (idx > 0) {
		const group = name.slice(0, idx);
		const rest = name.slice(idx + GROUP_SEP.length);
		if (group && rest) {
			return [group, rest];
		}
	}
	return [null, name];
}

export interface GroupNode {
	name: string;
	folded: boolean;
	rows: Row[];
}

export interface ArchivedEntry {
	id: string;
	name: string;
	agent: string;
	row: Row | null;
}

export interface ManagerTree {
	groups: GroupNode[];
	/** 「その他」区分：カテゴリの無い名前付きセッション＋名前の無いセッション（T-74 追補で
	 * 統合。中は最終更新順）。 */
	others: { folded: boolean; rows: Row[] };
	archived: ArchivedEntry[];
}

interface Labeled {
	row: Row;
	label: string;
}

function byMtimeDesc(list: Labeled[]): Labeled[] {
	return [...list].sort((a, b) => b.row.last_activity - a.row.last_activity || a.label.localeCompare(b.label));
}

/**
 * グループ（見出し、折畳）→ その他（見出し、既定で折畳）→ アーカイブ。各区分の中は
 * 最終更新順（§6.2）。「その他」に載るのは、カテゴリの無い名前付きセッションと、名前が
 * 無く `child` が偽のセッション（無名の子セッションはどこにも出ない）。
 */
export function buildManagerTree(rows: Row[], store: Store): ManagerTree {
	const active = rows.filter((r) => !r.archived);
	const archivedRows = rows.filter((r) => r.archived);

	const named = active.filter((r) => !!r.name);
	const unnamed = active.filter((r) => !r.name);
	const unnamedOthers = unnamed.filter((r) => !r.child);

	const groupMap = new Map<string, Labeled[]>();
	const singleRows: Row[] = [];
	for (const row of named) {
		const [group, label] = splitName(row.name as string);
		if (group) {
			const list = groupMap.get(group);
			if (list) {
				list.push({ row, label });
			} else {
				groupMap.set(group, [{ row, label }]);
			}
		} else {
			singleRows.push(row);
		}
	}

	const groupNames = [...groupMap.keys()].sort((a, b) => {
		const newestA = Math.max(...groupMap.get(a)!.map((c) => c.row.last_activity));
		const newestB = Math.max(...groupMap.get(b)!.map((c) => c.row.last_activity));
		if (newestA !== newestB) {
			return newestB - newestA;
		}
		return a.localeCompare(b);
	});

	const groups: GroupNode[] = groupNames.map((name) => ({
		name,
		folded: store.folded.includes(name),
		rows: byMtimeDesc(groupMap.get(name)!).map((c) => c.row),
	}));

	// 「その他」：カテゴリの無い名前付きセッション＋名前の無いセッションを 1 つにまとめ、
	// 最終更新順に並べる（T-74 追補）。
	const otherRows = [...singleRows, ...unnamedOthers].sort((a, b) => b.last_activity - a.last_activity);

	const archived: ArchivedEntry[] = [];
	const seen = new Set<string>();
	for (const row of archivedRows) {
		const record = store.archived.find((a) => a.id === row.id);
		archived.push({ id: row.id, name: row.name || record?.name || "", agent: row.agent, row });
		seen.add(row.id);
	}
	for (const record of store.archived) {
		if (!seen.has(record.id)) {
			archived.push({ id: record.id, name: record.name, agent: record.agent, row: null });
		}
	}
	archived.sort((a, b) => (b.row?.last_activity ?? -Infinity) - (a.row?.last_activity ?? -Infinity));

	return {
		groups,
		// 旧「カテゴリなし」（`LEGACY_NO_CATEGORY_GROUP`）だけが畳んであった場合も、統合後の
		// 「その他」は畳んだ扱いにする（後方互換）。
		others: {
			folded: store.folded.includes(OTHER_GROUP) || store.folded.includes(LEGACY_NO_CATEGORY_GROUP),
			rows: otherRows,
		},
		archived,
	};
}

export interface SideList {
	openTabs: Row[];
	running: Row[];
	recent: Row[];
}

/**
 * 開いているタブ（タブの順）→ 起動中（タブが無い）→ 最近 N 件（§6.1）。
 * アーカイブ済みと名前の無い子セッションは「最近」に出さない。
 */
export function buildSideList(rows: Row[], leavesOrder: string[], recentCount: number): SideList {
	const byId = new Map(rows.map((r) => [r.id, r]));
	const openTabs = leavesOrder.map((id) => byId.get(id)).filter((r): r is Row => !!r);
	const openIds = new Set(openTabs.map((r) => r.id));

	const running = rows
		.filter((r) => r.daemon && !openIds.has(r.id))
		.sort((a, b) => b.last_activity - a.last_activity);
	const runningIds = new Set(running.map((r) => r.id));

	const recent = rows
		.filter(
			(r) =>
				!openIds.has(r.id) &&
				!runningIds.has(r.id) &&
				!r.archived &&
				!(!r.name && r.child)
		)
		.sort((a, b) => b.last_activity - a.last_activity)
		.slice(0, recentCount);

	return { openTabs, running, recent };
}

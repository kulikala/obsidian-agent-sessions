// セッションマネージャーの表（純関数。D-44）。`ManagerTree`（`tree.ts`）を、
// ↑↓ で辿れる 1 本の行の列に平らにする。`obsidian` には依存しない
// （テストは test/manager-model.test.ts）。

import type { Row } from "../index";
import { OTHER_GROUP, type ManagerTree } from "../tree";

/** 折畳の対象にならない特別なグループ鍵（アーカイブの見出し）。 */
export const ARCHIVED_GROUP = "__archived__";

export type ManagerRow =
	| { kind: "group"; key: string; label: string; count: number; folded: boolean }
	| { kind: "session"; row: Row; indent: boolean }
	/** アーカイブの控えはあるが `json scan` に出てこない（もう存在しない）セッション。 */
	| { kind: "archived-orphan"; id: string; name: string };

/**
 * グループ（見出し→畳んでなければ子）→ 単独 → その他のセッション（見出し→子）→
 * `showArchived` なら アーカイブ（見出し→子。常に展開）、の順に 1 本へ平らにする。
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

	for (const row of tree.singles) {
		out.push({ kind: "session", row, indent: false });
	}

	if (tree.others.rows.length > 0) {
		out.push({
			kind: "group",
			key: OTHER_GROUP,
			label: OTHER_GROUP,
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
			label: `アーカイブ（${tree.archived.length}）`,
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

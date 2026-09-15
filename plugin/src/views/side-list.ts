// サイドパネルの一覧の組み立て（純関数）。`obsidian` には依存しない。
// `side.ts` はここを通して `buildSideList` を呼ぶ（テストのため分離）。

import type { Row } from "../index";
import { buildSideList, type SideList } from "../tree";

export interface TerminalLeafLike {
	getViewState(): { state?: { id?: unknown } };
}

/** ターミナルタブの leaf 配列から、タブの順の id 列を作る。 */
export function leafIdsOf(leaves: TerminalLeafLike[]): string[] {
	return leaves.map((leaf) => leaf.getViewState().state?.id).filter((id): id is string => typeof id === "string");
}

/** `SessionIndex.sessions` とタブの並びから、サイドパネルの 3 区分を作る（§6.1）。 */
export function computeSideList(
	sessions: Map<string, Row>,
	leaves: TerminalLeafLike[],
	recentCount: number
): SideList {
	return buildSideList([...sessions.values()], leafIdsOf(leaves), recentCount);
}

// 「ユーザーのアテンションが要る」セッションの集計（純関数、T-78）。
// asking（AskUserQuestion・許可プロンプト等で Claude が答えを待っている）→ waiting
// （busy→idle の後、まだそのタブを前面にしていない＝未読）の順で優先度が高い
// （`terminal-status.ts` の `terminalStatus` の優先順と同じ）。
// `obsidian` には依存しない（テストは test/attention.test.ts）。

import type { Row } from "./index";
import { resolveRowStatus, type TerminalStatusSource } from "./terminal-status";

export interface AttentionCounts {
	asking: number;
	waiting: number;
	/** クリックで開くセッション：最初の asking、無ければ最初の waiting。どちらも無ければ `null`。 */
	jumpToId: string | null;
}

/** `rows` のうち asking／waiting の件数と、ジャンプ先（asking 優先）を数える（サイドパネルの
 * バッジ。T-78）。 */
export function attentionCounts(source: TerminalStatusSource, rows: Row[]): AttentionCounts {
	let asking = 0;
	let waiting = 0;
	let firstAskingId: string | null = null;
	let firstWaitingId: string | null = null;
	for (const row of rows) {
		const status = resolveRowStatus(source, row);
		if (status === "asking") {
			asking++;
			if (firstAskingId === null) {
				firstAskingId = row.id;
			}
		} else if (status === "waiting") {
			waiting++;
			if (firstWaitingId === null) {
				firstWaitingId = row.id;
			}
		}
	}
	return { asking, waiting, jumpToId: firstAskingId ?? firstWaitingId };
}

export type GroupUrgency = "asking" | "waiting";

/**
 * グループ鍵（`keyOf`）ごとの最優先状態（asking > waiting）。折畳の有無に関わらず、
 * `rows` 全体から数える——マネージャーの見出しは畳んでいても中の状態を示す必要がある
 * （T-78）。アーカイブ済みは数えない。該当が無いグループの鍵は含めない。
 */
export function urgencyByGroupKey(
	source: TerminalStatusSource,
	rows: Row[],
	keyOf: (row: Row) => string
): Map<string, GroupUrgency> {
	const result = new Map<string, GroupUrgency>();
	for (const row of rows) {
		if (row.archived) {
			continue;
		}
		const status = resolveRowStatus(source, row);
		if (status !== "asking" && status !== "waiting") {
			continue;
		}
		const key = keyOf(row);
		if (result.get(key) === "asking") {
			continue;
		}
		result.set(key, status);
	}
	return result;
}

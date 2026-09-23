import { describe, expect, it } from "vitest";
import { attentionCounts, urgencyByGroupKey } from "../src/attention";
import type { Row } from "../src/index";
import type { TerminalStatus } from "../src/terminal-status";

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
		pid: null,
		rc: false,
		daemon: false,
		exited: null,
		hasTab: false,
		archived: false,
		...overrides,
	};
}

/** `resolveRowStatus` は `source.terminalStatuses` を見るだけなので、id→状態の Map で
 * 直接組み立てられる（`asking` はまだ `TerminalStatus` に無いので文字列のまま渡す）。 */
function source(statuses: Record<string, string>): { terminalStatuses: Map<string, TerminalStatus> } {
	return { terminalStatuses: new Map(Object.entries(statuses)) as Map<string, TerminalStatus> };
}

describe("attentionCounts（T-78）", () => {
	it("asking・waiting をそれぞれ数える", () => {
		const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" }), row({ id: "d" })];
		const counts = attentionCounts(source({ a: "asking", b: "waiting", c: "waiting", d: "idle" }), rows);
		expect(counts.asking).toBe(1);
		expect(counts.waiting).toBe(2);
	});

	it("どちらも無ければ 0・jumpToId は null", () => {
		const rows = [row({ id: "a" }), row({ id: "b" })];
		const counts = attentionCounts(source({ a: "idle", b: "working" }), rows);
		expect(counts).toEqual({ asking: 0, waiting: 0, jumpToId: null });
	});

	it("jumpToId は asking を優先する（並びで waiting が先でも）", () => {
		const rows = [row({ id: "a" }), row({ id: "b" })];
		const counts = attentionCounts(source({ a: "waiting", b: "asking" }), rows);
		expect(counts.jumpToId).toBe("b");
	});

	it("asking が無ければ最初の waiting", () => {
		const rows = [row({ id: "a" }), row({ id: "b" })];
		const counts = attentionCounts(source({ a: "idle", b: "waiting" }), rows);
		expect(counts.jumpToId).toBe("b");
	});

	it("同じ状態が複数あれば最初の 1 件だけを jumpToId にする", () => {
		const rows = [row({ id: "a" }), row({ id: "b" })];
		const counts = attentionCounts(source({ a: "asking", b: "asking" }), rows);
		expect(counts.jumpToId).toBe("a");
	});
});

describe("urgencyByGroupKey（T-78）", () => {
	const keyOf = (r: Row): string => r.folder;

	it("グループごとに最優先の状態（asking > waiting）を持つ", () => {
		const rows = [
			row({ id: "a", folder: "g1" }),
			row({ id: "b", folder: "g1" }),
			row({ id: "c", folder: "g2" }),
		];
		const map = urgencyByGroupKey(source({ a: "waiting", b: "asking", c: "waiting" }), rows, keyOf);
		expect(map.get("g1")).toBe("asking"); // waiting と asking が混在 → asking が勝つ
		expect(map.get("g2")).toBe("waiting");
	});

	it("該当が無いグループは鍵を持たない", () => {
		const rows = [row({ id: "a", folder: "g1" })];
		const map = urgencyByGroupKey(source({ a: "idle" }), rows, keyOf);
		expect(map.has("g1")).toBe(false);
		expect(map.size).toBe(0);
	});

	it("折畳（rows に子が含まれない状態）とは無関係に、渡された rows 全体から数える", () => {
		// マネージャーが畳んだグループの子も渡せば拾える、という契約を確認するだけ
		// （折畳の判定自体は呼出側の責務）。
		const rows = [row({ id: "a", folder: "g1" })];
		const map = urgencyByGroupKey(source({ a: "asking" }), rows, keyOf);
		expect(map.get("g1")).toBe("asking");
	});

	it("アーカイブ済みは数えない", () => {
		const rows = [row({ id: "a", folder: "g1", archived: true })];
		const map = urgencyByGroupKey(source({ a: "asking" }), rows, keyOf);
		expect(map.has("g1")).toBe(false);
	});
});

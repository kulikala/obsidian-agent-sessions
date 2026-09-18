// トークン集計（D-30・D-40・D-45）。`json usage ID` の結果を、選んだ区間（ターンの `index`、
// 両端含む）で合計し直し、表示・コピー用の Markdown にする。純関数のみ——`obsidian`・
// `@xterm/xterm` には依存しない（テストは test/usage.test.ts）。

import type { UsageTotal, UsageTurn } from "./types";

const TOTAL_KEYS = ["calls", "input", "cache_create", "cache_read", "output", "thinking"] as const;

function emptyTotal(): UsageTotal {
	return {
		calls: 0,
		input: 0,
		cache_create: 0,
		cache_read: 0,
		output: 0,
		thinking: 0,
		cost: 0,
		tools: {},
		estimated: false,
		duration: null,
		first_ts: null,
		last_ts: null,
		context_last: 0,
	};
}

/**
 * `from`〜`to`（ターンの `index`、両端含む。順不同で渡してよい）に入るターンの合計。
 * `cost`・`tools`（名前ごとの合計）に加え、区間内のターンの `ts`（開始）〜`last_ts`
 * （最後に数えた assistant 行）の幅を `duration` にする（両方揃わなければ `null`）。
 */
export function sumRange(turns: UsageTurn[], from: number, to: number): UsageTotal {
	const lo = Math.min(from, to);
	const hi = Math.max(from, to);
	const total = emptyTotal();
	for (const turn of turns) {
		if (turn.index < lo || turn.index > hi) {
			continue;
		}
		for (const key of TOTAL_KEYS) {
			total[key] += turn[key];
		}
		total.cost += turn.cost;
		for (const [name, count] of Object.entries(turn.tools)) {
			total.tools[name] = (total.tools[name] ?? 0) + count;
		}
		if (turn.estimated) {
			total.estimated = true;
		}
		if (turn.ts !== null && (total.first_ts === null || turn.ts < total.first_ts)) {
			total.first_ts = turn.ts;
		}
		if (turn.last_ts !== null && (total.last_ts === null || turn.last_ts >= total.last_ts)) {
			total.last_ts = turn.last_ts;
			total.context_last = turn.context_last;
		}
	}
	total.duration = total.first_ts !== null && total.last_ts !== null ? total.last_ts - total.first_ts : null;
	return total;
}

/** 3 桁区切り。 */
export function formatNumber(n: number): string {
	return n.toLocaleString("en-US");
}

/** `999`→`999`、`1,234`→`1.2k`、`1,234,567`→`1.2M`。カードとターン表の入出力に使う。 */
export function formatK(n: number): string {
	const abs = Math.abs(n);
	if (abs < 1000) {
		return String(n);
	}
	if (abs < 1_000_000) {
		// 丸めで桁が繰り上がる場合（例: 999,950 → 1.0M）は M 側の表記に回す。
		const rounded = Math.round(n / 100) * 100;
		if (Math.abs(rounded) >= 1_000_000) {
			return formatK(rounded);
		}
		return `${(n / 1000).toFixed(1)}k`;
	}
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/** `$0.005` 未満は `<$0.01`、それ以外は小数 2 桁。 */
export function formatCost(n: number): string {
	if (n > 0 && n < 0.005) {
		return "<$0.01";
	}
	return `$${n.toFixed(2)}`;
}

/** `duration`（秒）を `h m` にする。`null` は「—」。 */
export function formatDuration(seconds: number | null): string {
	if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
		return "—";
	}
	const totalMinutes = Math.round(seconds / 60);
	const h = Math.floor(totalMinutes / 60);
	const m = totalMinutes % 60;
	return `${h}h ${m}m`;
}

/** `MM-DD HH:MM`（ローカル）。`null` は「—」（「（開始前）」ターンなど ts が無い場合）。 */
export function formatEpoch(ts: number | null): string {
	if (ts === null) {
		return "—";
	}
	const d = new Date(ts * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 区間選択の状態。`null`＝全体。`end === null`＝開始行だけ選んで終了行待ち。 */
export interface TurnSelection {
	anchor: number;
	end: number | null;
}
export type Selection = TurnSelection | null;

/**
 * ターン表の行クリック 1 回分を状態に適用する（D-45）。
 * - 全体、または確定済みの区間の最中にクリック → そのターンを新しい開始行にする。
 * - 開始行だけ選んでいる最中に同じ行をクリック → 解除（全体に戻る）。
 * - 開始行だけ選んでいる最中に別の行をクリック → その行を終了行にして確定する。
 */
export function nextSelection(cur: Selection, clickedIndex: number): Selection {
	if (cur === null || cur.end !== null) {
		return { anchor: clickedIndex, end: null };
	}
	if (clickedIndex === cur.anchor) {
		return null;
	}
	return { anchor: cur.anchor, end: clickedIndex };
}

/** 選択状態を、ターン表に効かせる実際の区間にする（開始行だけの間は、その 1 行だけの区間）。 */
export function effectiveRange(sel: Selection, turns: UsageTurn[]): { from: number; to: number; pending: boolean } {
	const first = turns[0]?.index ?? 0;
	const last = turns[turns.length - 1]?.index ?? 0;
	if (sel === null) {
		return { from: first, to: last, pending: false };
	}
	if (sel.end === null) {
		return { from: sel.anchor, to: sel.anchor, pending: true };
	}
	return { from: Math.min(sel.anchor, sel.end), to: Math.max(sel.anchor, sel.end), pending: false };
}

/** 改行を詰め、Markdown の表を壊す `|` を逃がす。 */
function escapeCell(text: string): string {
	return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

/**
 * カードの値（コスト・トークン・ターン数・期間）と、選んだ区間のターン表を Markdown にする
 * （コピー用）。「入力」は非キャッシュ＋cache 読出＋cache 作成の合計（カードと同じ定義）。
 */
export function toMarkdown(turns: UsageTurn[], from: number, to: number, total: UsageTotal): string {
	const lo = Math.min(from, to);
	const hi = Math.max(from, to);
	const rows = [...turns].filter((t) => t.index >= lo && t.index <= hi).sort((a, b) => a.index - b.index);
	const inputTotal = total.input + total.cache_read + total.cache_create;

	const lines: string[] = [];
	lines.push(`# セッション解析結果（#${lo}〜#${hi}）`);
	lines.push("");
	lines.push(`- コスト: ${formatCost(total.cost)}${total.estimated ? "（概算）" : ""}`);
	lines.push(`- トークン: 入力 ${formatK(inputTotal)}・出力 ${formatK(total.output)}`);
	lines.push(`- ターン数: ${rows.length}`);
	lines.push(`- 期間: ${formatDuration(total.duration)}`);
	lines.push("");
	lines.push("| # | 時刻 | 指示 | 入力 | 出力 | コスト |");
	lines.push("|---|---|---|---|---|---|");
	for (const t of rows) {
		const input = t.input + t.cache_read + t.cache_create;
		lines.push(
			`| ${t.index} | ${formatEpoch(t.ts)} | ${escapeCell(t.prompt)} | ${formatK(input)} | ` +
				`${formatK(t.output)} | ${formatCost(t.cost)} |`
		);
	}
	return lines.join("\n");
}

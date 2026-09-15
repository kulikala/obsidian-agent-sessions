// トークン集計（D-30・D-31）。`json usage ID` の結果を、選んだ区間（ターンの `index`、
// 両端含む）で合計し直し、表示・コピー用の Markdown にする。純関数のみ——`obsidian`・
// `@xterm/xterm` には依存しない（テストは test/usage.test.ts）。

import type { UsageTotal, UsageTurn } from "./types";

const TOTAL_KEYS = ["calls", "input", "cache_create", "cache_read", "output", "thinking"] as const;

function emptyTotal(): UsageTotal {
	return { calls: 0, input: 0, cache_create: 0, cache_read: 0, output: 0, thinking: 0 };
}

/** `from`〜`to`（ターンの `index`、両端含む。順不同で渡してよい）に入るターンの合計。 */
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
	}
	return total;
}

/** 3 桁区切り。 */
export function formatNumber(n: number): string {
	return n.toLocaleString("en-US");
}

/** `MM-DD HH:MM`（ローカル）。 */
export function formatEpoch(ts: number): string {
	const d = new Date(ts * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 改行を詰め、Markdown の表を壊す `|` を逃がす。 */
function escapeCell(text: string): string {
	return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

/**
 * ターン表（常に全ターン）と、選んだ区間の合計を Markdown にする（コピー用）。
 * モーダルの表と同じく、区間は合計だけに効く——`from`／`to` は合計の見出しに使う。
 */
export function toMarkdown(turns: UsageTurn[], from: number, to: number, total: UsageTotal): string {
	const lo = Math.min(from, to);
	const hi = Math.max(from, to);
	const rows = [...turns].sort((a, b) => a.index - b.index);

	const lines: string[] = [];
	lines.push(
		`合計（#${lo}〜#${hi}）：呼出 ${formatNumber(total.calls)}・入力 ${formatNumber(total.input)}・` +
			`出力 ${formatNumber(total.output)}・cache 作成 ${formatNumber(total.cache_create)}・` +
			`cache 読出 ${formatNumber(total.cache_read)}・thinking ${formatNumber(total.thinking)}`
	);
	lines.push("");
	lines.push("| # | 時刻 | 指示 | 入力 | 出力 | cache 作成 | cache 読出 |");
	lines.push("|---|---|---|---|---|---|---|");
	for (const t of rows) {
		lines.push(
			`| ${t.index} | ${formatEpoch(t.ts)} | ${escapeCell(t.prompt)} | ${formatNumber(t.input)} | ` +
				`${formatNumber(t.output)} | ${formatNumber(t.cache_create)} | ${formatNumber(t.cache_read)} |`
		);
	}
	return lines.join("\n");
}

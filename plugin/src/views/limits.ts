// セッション制限ビュー（D-43・I-61・I-68 事実）。
// `~/.agents/sessions/status/*.json` はアカウント共通の `rate_limits` を持つ。ファイルごとに
// 前回書いた時刻（mtime）が違うので、`rate_limits` を持つファイルのうち最新のものを使う
// （前提：アカウントを切り替えて並行使用しない）。5h・7d のバー・使用率・リセットまでの
// カウントダウン（`resets_at` が無ければ「—」）を 1 秒毎に更新する。

import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "../i18n";

export interface RateLimitWindow {
	/** `null` は「リセットを過ぎたばかりで、まだ新しい rate_limits が届いていない」
	 * （`rollForwardWindow` が先送りした直後。T-74 追補）。 */
	usedPercentage: number | null;
	resetsAt: number | null;
}

/** 5 時間枠・7 日枠の長さ（秒）。`agentsessions/stats.py` の `FIVE_HOUR_SECONDS`・
 * `SEVEN_DAY_SECONDS` と同じ値（Python 側と共有はできないので、ここでも持つ）。 */
export const FIVE_HOUR_SECONDS = 5 * 60 * 60;
export const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;

export interface LimitsInfo {
	fiveHour: RateLimitWindow | null;
	sevenDay: RateLimitWindow | null;
}

/** `readLimitsFiles` が集める 1 ファイル分。純関数のテスト（`pickLatestLimits`）から使う形。 */
export interface RawLimitsFile {
	mtimeMs: number;
	rate_limits?: {
		five_hour?: { used_percentage?: unknown; resets_at?: unknown };
		seven_day?: { used_percentage?: unknown; resets_at?: unknown };
	};
}

function num(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}

function windowOf(raw: { used_percentage?: unknown; resets_at?: unknown } | undefined): RateLimitWindow | null {
	const used = num(raw?.used_percentage);
	if (used == null) {
		return null;
	}
	return { usedPercentage: used, resetsAt: num(raw?.resets_at) };
}

/**
 * `rate_limits` を持つファイルのうち最新 mtime のものから `five_hour`／`seven_day` を取る。
 * 該当ファイルが無ければ `null`。
 */
export function pickLatestLimits(files: RawLimitsFile[]): LimitsInfo | null {
	const candidates = files.filter((f) => f.rate_limits);
	if (candidates.length === 0) {
		return null;
	}
	const latest = candidates.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
	return {
		fiveHour: windowOf(latest.rate_limits?.five_hour),
		sevenDay: windowOf(latest.rate_limits?.seven_day),
	};
}

/**
 * `w.resetsAt` が `now` より過去なら、`durationSeconds`（5 時間枠／7 日枠の長さ）ずつ
 * 先へ送って「今の窓」の `resetsAt` にする（T-74 追補：`agentsessions/stats.py` の
 * `_roll_forward` と同じ規則）。リセットを過ぎた直後、まだ新しい `rate_limits` が
 * 届いていない間は `usedPercentage` を `null`（不明）にする。`w` が `null`、または
 * `resetsAt` が無ければそのまま返す（先送りできないため）。
 */
export function rollForwardWindow(w: RateLimitWindow | null, durationSeconds: number, now: number): RateLimitWindow | null {
	if (!w || w.resetsAt == null || w.resetsAt >= now) {
		return w;
	}
	const periods = Math.ceil((now - w.resetsAt) / durationSeconds);
	return { usedPercentage: null, resetsAt: w.resetsAt + periods * durationSeconds };
}

/** `h:mm:ss`（0 未満は 0 に丸める）。24 時間以上は秒を落として `N 日 h:mm` にする（D-54）。 */
export function formatCountdown(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	const pad = (n: number) => String(n).padStart(2, "0");
	const totalHours = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (totalHours >= 24) {
		const days = Math.floor(totalHours / 24);
		const h = totalHours % 24;
		return t("limits.countdownDays", { days, h, mm: pad(m) });
	}
	const sec = s % 60;
	return `${totalHours}:${pad(m)}:${pad(sec)}`;
}

// ---- ファイル読み込み（node:fs）。DOM 側は `LimitsView` に閉じ込める。 -----------------------

function readLimitsFiles(statusDir: string): RawLimitsFile[] {
	let names: string[];
	try {
		names = fs.readdirSync(statusDir).filter((n: string) => n.endsWith(".json"));
	} catch {
		return [];
	}
	const out: RawLimitsFile[] = [];
	for (const name of names) {
		const full = path.join(statusDir, name);
		try {
			const stat = fs.statSync(full);
			const raw = JSON.parse(fs.readFileSync(full, "utf8"));
			out.push({ mtimeMs: stat.mtimeMs, rate_limits: raw?.rate_limits });
		} catch {
			// 壊れた・読めないファイルは無視。
		}
	}
	return out;
}

/** バー＋`NN%`＋「リセットまで h:mm:ss」を 5h・7d の 2 行で描く。 */
export class LimitsView {
	private fiveHourEl!: HTMLElement;
	private sevenDayEl!: HTMLElement;
	private info: LimitsInfo | null = null;
	private tickTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		container: HTMLElement,
		private statusDir: string
	) {
		const el = container.createDiv({ cls: "agent-sessions-limits" });
		this.fiveHourEl = el.createDiv({ cls: "agent-sessions-limits-row" });
		this.sevenDayEl = el.createDiv({ cls: "agent-sessions-limits-row" });
		this.reload();
		this.tickTimer = setInterval(() => this.render(), 1000);
	}

	/** `status/` の内容を読み直す（`StatusLine` の変化・再走査のたびに呼ぶ）。 */
	reload(): void {
		this.info = pickLatestLimits(readLimitsFiles(this.statusDir));
		this.render();
	}

	dispose(): void {
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
	}

	private render(): void {
		// 1 秒毎に呼ばれるたび、`now` を最新にして先送りを判定し直す（T-74 追補）——
		// `reload()` の間隔に関わらず、リセットを過ぎた瞬間から常に「今の窓」を出す。
		const now = Date.now() / 1000;
		this.renderWindow(this.fiveHourEl, "5h", rollForwardWindow(this.info?.fiveHour ?? null, FIVE_HOUR_SECONDS, now));
		this.renderWindow(this.sevenDayEl, "7d", rollForwardWindow(this.info?.sevenDay ?? null, SEVEN_DAY_SECONDS, now));
	}

	private renderWindow(el: HTMLElement, label: string, w: RateLimitWindow | null): void {
		el.empty();
		el.createSpan({ cls: "agent-sessions-limits-label", text: label });
		const barWrap = el.createDiv({ cls: "agent-sessions-limits-bar" });
		const pct = w?.usedPercentage != null ? Math.min(100, Math.max(0, w.usedPercentage)) : 0;
		const bar = barWrap.createDiv({ cls: "agent-sessions-limits-bar-fill" });
		bar.style.width = `${pct}%`;
		el.createSpan({ cls: "agent-sessions-limits-pct", text: w?.usedPercentage != null ? `${Math.round(w.usedPercentage)}%` : "—" });
		const countdown = w?.resetsAt != null ? formatCountdown(w.resetsAt - Date.now() / 1000) : null;
		el.createSpan({
			cls: "agent-sessions-limits-countdown",
			text: countdown != null ? t("stats.resetsIn", { countdown }) : "—",
		});
	}
}

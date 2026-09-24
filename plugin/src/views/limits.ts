// The rate-limit view.
// `~/.agents/sessions/status/*.json` files each carry the account-wide `rate_limits`. Since
// each file's last-written time (mtime) differs, this uses whichever file with `rate_limits`
// was written most recently (assumes the account isn't being used from multiple places at
// once). Updates the 5h/7d bars, usage percentage, and countdown to reset (shown as "—" when
// `resets_at` is absent) once per second, and re-reads the source files immediately on click.

import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "../i18n";

/** How long the "is-refreshing" visual state stays on after a click (the read itself is near-instant). */
const REFRESH_FLASH_MS = 200;

export interface RateLimitWindow {
	/** `null` means "just past reset, with no fresh `rate_limits` yet" (right after
	 * `rollForwardWindow` has rolled it forward). */
	usedPercentage: number | null;
	resetsAt: number | null;
}

/** Lengths of the 5-hour and 7-day windows, in seconds. Matches `agentsessions/stats.py`'s
 * `FIVE_HOUR_SECONDS`/`SEVEN_DAY_SECONDS` (can't be shared with the Python side, so it's duplicated here). */
export const FIVE_HOUR_SECONDS = 5 * 60 * 60;
export const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;

export interface LimitsInfo {
	fiveHour: RateLimitWindow | null;
	sevenDay: RateLimitWindow | null;
}

/** One file's worth of what `readLimitsFiles` collects. Shaped for use by the pure-function test (`pickLatestLimits`). */
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
 * Takes `five_hour`/`seven_day` from whichever file with `rate_limits` has the newest mtime.
 * `null` if there's no such file.
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
 * If `w.resetsAt` is in the past relative to `now`, rolls it forward in steps of
 * `durationSeconds` (the 5-hour/7-day window length) to get the current window's `resetsAt`
 * (same rule as `agentsessions/stats.py`'s `_roll_forward`). Right after a reset, while no fresh
 * `rate_limits` has arrived yet, sets `usedPercentage` to `null` (unknown). Returns `w` as-is if
 * it's `null` or has no `resetsAt` (nothing to roll forward).
 */
export function rollForwardWindow(w: RateLimitWindow | null, durationSeconds: number, now: number): RateLimitWindow | null {
	if (!w || w.resetsAt == null || w.resetsAt >= now) {
		return w;
	}
	const periods = Math.ceil((now - w.resetsAt) / durationSeconds);
	return { usedPercentage: null, resetsAt: w.resetsAt + periods * durationSeconds };
}

/** `h:mm:ss` (clamped to 0 if negative). 24 hours or more drops the seconds and switches to "Nd h:mm". */
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

// ---- File reading (node:fs). DOM handling is kept inside `LimitsView`. -----------------------

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
			// Ignore files that are corrupt or unreadable.
		}
	}
	return out;
}

/** Draws two rows (5h and 7d), each a bar plus `NN%` plus the countdown to reset. Clicking re-reads the source files right away. */
export class LimitsView {
	private hostEl: HTMLElement;
	private fiveHourEl!: HTMLElement;
	private sevenDayEl!: HTMLElement;
	private info: LimitsInfo | null = null;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private refreshing = false;
	private refreshFlashTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		container: HTMLElement,
		private statusDir: string
	) {
		this.hostEl = container.createDiv({ cls: "agent-sessions-limits" });
		this.fiveHourEl = this.hostEl.createDiv({ cls: "agent-sessions-limits-row" });
		this.sevenDayEl = this.hostEl.createDiv({ cls: "agent-sessions-limits-row" });
		this.hostEl.addEventListener("click", () => this.refreshFromClick());
		// `obsidian`'s `setTooltip` is required lazily (same reason as `views/detail.ts`'s
		// `makeIconButton`: so importing just the pure functions in tests doesn't fail trying to
		// resolve `obsidian`).
		const { setTooltip } = require("obsidian") as typeof import("obsidian");
		setTooltip(this.hostEl, t("action.clickToRefresh"));
		this.reload();
		this.tickTimer = setInterval(() => this.render(), 1000);
	}

	/** Re-reads `status/`'s contents (called whenever the statusLine changes or on every rescan). */
	reload(): void {
		this.info = pickLatestLimits(readLimitsFiles(this.statusDir));
		this.render();
	}

	/**
	 * Clicking re-reads `status/*.json` right away, rather than waiting for the next automatic
	 * refresh — note that the `rate_limits` values themselves only change when claude's own
	 * statusLine hook next writes them, so this just re-reads whatever is currently on disk.
	 * Rapid clicks collapse into one (ignored while a refresh is already in progress); the brief
	 * `is-refreshing` class gives visible feedback even though the read itself is effectively instant.
	 */
	private refreshFromClick(): void {
		if (this.refreshing) {
			return;
		}
		this.refreshing = true;
		this.hostEl.addClass("is-refreshing");
		this.reload();
		this.refreshFlashTimer = setTimeout(() => {
			this.refreshing = false;
			this.hostEl.removeClass("is-refreshing");
			this.refreshFlashTimer = null;
		}, REFRESH_FLASH_MS);
	}

	dispose(): void {
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		if (this.refreshFlashTimer) {
			clearTimeout(this.refreshFlashTimer);
			this.refreshFlashTimer = null;
		}
	}

	private render(): void {
		// Refreshes `now` and re-evaluates roll-forward every time this is called (once a
		// second) — so the window shown is always the current one from the moment it resets,
		// independent of how often `reload()` runs.
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
		el.createSpan({ cls: "agent-sessions-limits-countdown", text: countdown ?? "—" });
	}
}

// The rate-limit view.
// Claude: `~/.agents/sessions/status/*.json` files each carry the account-wide `rate_limits`,
// written in real time by Claude Code's own statusLine hook. Since each file's last-written time
// (mtime) differs, this uses whichever file with `rate_limits` was written most recently (assumes
// the account isn't being used from multiple places at once).
// Codex (T-104): no statusLine-equivalent mechanism exists, so there's no live file to read —
// instead this polls `json stats`'s `agents.codex.windows` (the same shape the manager's
// per-agent analysis uses) every `STATS_FETCH_INTERVAL_MS`, converting each `StatsWindow` into
// the same `RateLimitWindow` shape via `fromStatsWindow` so both agents render through the
// identical `renderWindow`.
// Either way: updates the 5h/7d bars, usage percentage, and countdown to reset (shown as "—" when
// `resetsAt` is absent, or when `usedPercentage` is — a Codex account on a plan with no 5h/7d
// tracking at all is a confirmed real case, not just "no data yet") once per second, and
// re-reads/re-fetches immediately on click.

import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "../i18n";
import { stats } from "../backend/backend";
import { AGENT_IDS, type AgentId } from "../settings";
import type { StatsWindow } from "../types";
import type AgentSessionsPlugin from "../main";
import { AGENT_ICON_ID } from "../ui/icons";

/** How long the "is-refreshing" visual state stays on after a click (the read itself is near-instant). */
const REFRESH_FLASH_MS = 200;
/** How often Codex's `json stats`-sourced windows are re-fetched (matches the manager's own interval). */
const STATS_FETCH_INTERVAL_MS = 60000;

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

/**
 * Converts a `json stats` `StatsWindow` (T-103/T-104 — `agents.<agent>.windows`) into the same
 * `RateLimitWindow` shape the file-based (Claude) path produces, so both render through the
 * identical `renderWindow`. `w.end` stands in for `resetsAt` (the window's own boundary — Codex's
 * own more precise `rate_limits.resets_in_seconds` isn't part of this shape). `usedPercentage`
 * carries through `null` as-is (rather than treating it the same as "no data") — a Codex account
 * on a plan with no 5h/7d tracking at all is a confirmed real case, and the countdown (from
 * `end`) is still worth showing even when the percentage itself is unknown. `null` only when `w`
 * itself is (nothing fetched yet, or the fetch failed).
 */
export function fromStatsWindow(w: StatsWindow | null): RateLimitWindow | null {
	if (!w) {
		return null;
	}
	return { usedPercentage: w.used_percentage, resetsAt: w.end };
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

/** One agent's pair of rows (5h and 7d) plus the elements to redraw them. */
interface AgentRows {
	fiveHourEl: HTMLElement;
	sevenDayEl: HTMLElement;
}

/**
 * Draws two rows (5h and 7d) per enabled agent (T-104 — a small agent icon at the head of each
 * row), each a bar plus `NN%` plus the countdown to reset. Clicking re-reads/re-fetches every
 * agent's source right away.
 */
export class LimitsView {
	private hostEl: HTMLElement;
	/** Claude's rows read `status/*.json` synchronously; every other enabled agent's rows poll
	 * `json stats` — both end up in this same map, keyed by agent id. */
	private rows: Partial<Record<AgentId, AgentRows>> = {};
	/** The agents currently shown (`rebuildRows`'s snapshot of the enabled set) — falls back to
	 * `["claude"]` alone if somehow none is, so there's always at least one pair of rows. */
	private agents: AgentId[] = [];
	private claudeInfo: LimitsInfo | null = null;
	/** Every non-Claude enabled agent's windows, fetched via `json stats` (T-103/T-104). */
	private statsWindows: Partial<Record<AgentId, { five_hour: StatsWindow; seven_day: StatsWindow }>> = {};
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private statsFetchTimer: ReturnType<typeof setInterval> | null = null;
	private refreshing = false;
	private refreshFlashTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		container: HTMLElement,
		private plugin: AgentSessionsPlugin
	) {
		this.hostEl = container.createDiv({ cls: "agent-sessions-limits" });
		this.hostEl.addEventListener("click", () => this.refreshFromClick());
		// `obsidian`'s `setTooltip`/`setIcon` are required lazily (same reason as `views/detail.ts`'s
		// `makeIconButton`: so importing just the pure functions in tests doesn't fail trying to
		// resolve `obsidian`).
		const { setTooltip } = require("obsidian") as typeof import("obsidian");
		setTooltip(this.hostEl, t("action.clickToRefresh"));
		this.rebuildRows();
		this.reload();
		this.tickTimer = setInterval(() => this.render(), 1000);
		this.statsFetchTimer = setInterval(() => void this.reloadStatsAgents(), STATS_FETCH_INTERVAL_MS);
	}

	/** Rebuilds the row elements for the currently-enabled agent set — call whenever that set
	 * might have changed (`side.ts` calls this alongside its own settings-changed handling). A
	 * no-op (keeps existing rows and data) if the set is unchanged. */
	refreshAgents(): void {
		const enabled = AGENT_IDS.filter((id) => this.plugin.settings.agents[id].enabled);
		const next = enabled.length > 0 ? enabled : (["claude"] as AgentId[]);
		if (next.length === this.agents.length && next.every((id, i) => id === this.agents[i])) {
			return;
		}
		this.rebuildRows();
		this.reload();
	}

	private rebuildRows(): void {
		const enabled = AGENT_IDS.filter((id) => this.plugin.settings.agents[id].enabled);
		this.agents = enabled.length > 0 ? enabled : (["claude"] as AgentId[]);
		this.hostEl.empty();
		this.rows = {};
		const { setIcon } = require("obsidian") as typeof import("obsidian");
		for (const agent of this.agents) {
			const fiveHourEl = this.hostEl.createDiv({ cls: "agent-sessions-limits-row" });
			const sevenDayEl = this.hostEl.createDiv({ cls: "agent-sessions-limits-row" });
			const icon = AGENT_ICON_ID[agent];
			if (icon) {
				setIcon(fiveHourEl.createSpan({ cls: "agent-sessions-limits-agent-icon" }), icon);
				setIcon(sevenDayEl.createSpan({ cls: "agent-sessions-limits-agent-icon" }), icon);
			}
			this.rows[agent] = { fiveHourEl, sevenDayEl };
		}
	}

	/** Re-reads/re-fetches every currently-shown agent's source (called whenever the statusLine
	 * changes or on every rescan, and by `refreshAgents` after a rebuild). */
	reload(): void {
		if (this.agents.includes("claude")) {
			this.claudeInfo = pickLatestLimits(readLimitsFiles(this.plugin.index.statusline.dir));
		}
		void this.reloadStatsAgents();
		this.render();
	}

	/** Fetches `json stats` once and updates every non-Claude enabled agent's windows from it —
	 * one call covers all of them, rather than a separate `json stats` per agent. */
	private async reloadStatsAgents(): Promise<void> {
		const statsAgents = this.agents.filter((id) => id !== "claude");
		if (statsAgents.length === 0) {
			return;
		}
		let result: Awaited<ReturnType<typeof stats>> | null;
		try {
			result = await stats(this.plugin.agentSessionsPath(), this.plugin.vaultPath());
		} catch {
			result = null;
		}
		for (const agent of statsAgents) {
			this.statsWindows[agent] = result?.agents?.[agent]?.windows;
		}
		this.render();
	}

	/**
	 * Clicking re-reads/re-fetches every agent's source right away, rather than waiting for the
	 * next automatic refresh — note that Claude's `rate_limits` values themselves only change
	 * when its own statusLine hook next writes them (so that part just re-reads whatever is
	 * currently on disk), while a non-Claude agent's really does re-fetch fresh `json stats`.
	 * Rapid clicks collapse into one (ignored while a refresh is already in progress); the brief
	 * `is-refreshing` class gives visible feedback even though Claude's own read is effectively instant.
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
		if (this.statsFetchTimer) {
			clearInterval(this.statsFetchTimer);
			this.statsFetchTimer = null;
		}
		if (this.refreshFlashTimer) {
			clearTimeout(this.refreshFlashTimer);
			this.refreshFlashTimer = null;
		}
	}

	private render(): void {
		// Refreshes `now` and re-evaluates roll-forward every time this is called (once a
		// second) — so the window shown is always the current one from the moment it resets,
		// independent of how often `reload()`/`reloadStatsAgents()` runs.
		const now = Date.now() / 1000;
		for (const agent of this.agents) {
			const els = this.rows[agent];
			if (!els) {
				continue;
			}
			if (agent === "claude") {
				this.renderWindow(els.fiveHourEl, "5h", rollForwardWindow(this.claudeInfo?.fiveHour ?? null, FIVE_HOUR_SECONDS, now));
				this.renderWindow(els.sevenDayEl, "7d", rollForwardWindow(this.claudeInfo?.sevenDay ?? null, SEVEN_DAY_SECONDS, now));
				continue;
			}
			const windows = this.statsWindows[agent];
			this.renderWindow(
				els.fiveHourEl,
				"5h",
				rollForwardWindow(fromStatsWindow(windows?.five_hour ?? null), FIVE_HOUR_SECONDS, now)
			);
			this.renderWindow(
				els.sevenDayEl,
				"7d",
				rollForwardWindow(fromStatsWindow(windows?.seven_day ?? null), SEVEN_DAY_SECONDS, now)
			);
		}
	}

	private renderWindow(el: HTMLElement, label: string, w: RateLimitWindow | null): void {
		// The agent icon (if any) is the first child, added once in `rebuildRows` — everything
		// else is redrawn every tick, so only that icon is left alone here.
		const iconEl = el.querySelector(".agent-sessions-limits-agent-icon");
		el.empty();
		if (iconEl) {
			el.appendChild(iconEl);
		}
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

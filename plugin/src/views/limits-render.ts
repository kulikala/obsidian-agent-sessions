// The rate-limit view's DOM rendering (`LimitsView`) and its `node:fs` file reading. Split out
// from `limits.ts` (which keeps the pure window-math/parsing helpers tests import directly)
// because this needs real `obsidian` exports (`setIcon`/`setTooltip`), and `obsidian`'s npm
// package has no runtime (its `main` is empty) outside the real app.

import * as fs from "node:fs";
import * as path from "node:path";
import { setIcon, setTooltip } from "obsidian";
import { t } from "../i18n";
import { stats } from "../backend/backend";
import { agentsWithLimits, type AgentId } from "../settings";
import type { StatsWindows } from "../types";
import type AgentSessionsPlugin from "../main";
import { AGENT_ICON_ID } from "../ui/icons";
import { exhaustedText, windowLabel, windowShortLabel } from "./manager-model";
import {
	claudeNearLimit,
	FIVE_HOUR_SECONDS,
	formatCountdown,
	fromStatsWindow,
	isGroupStartRow,
	pickLatestLimits,
	realWindows,
	rollForwardWindow,
	SEVEN_DAY_SECONDS,
	withExhaustion,
	type LimitsInfo,
	type RateLimitWindow,
	type RawLimitsFile,
} from "./limits";

/** How long the "is-refreshing" visual state stays on after a click (the read itself is near-instant). */
const REFRESH_FLASH_MS = 200;
/** How often the `json stats`-sourced windows are re-fetched (matches the manager's own interval). */
const STATS_FETCH_INTERVAL_MS = 60000;

/** Narrows a `JSON.parse` result (`unknown`) to `RawLimitsFile["rate_limits"]`, without trusting
 * its shape beyond "an object, or absent" — the fields inside it are read via `RawLimitsFile`'s
 * own `unknown`-typed `used_percentage`/`resets_at` (narrowed by `limits.ts`'s `num`), not here. */
function rateLimitsOf(parsed: unknown): RawLimitsFile["rate_limits"] {
	if (!parsed || typeof parsed !== "object") {
		return undefined;
	}
	const rateLimits = (parsed as { rate_limits?: unknown }).rate_limits;
	return rateLimits && typeof rateLimits === "object" ? rateLimits : undefined;
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
			const parsed: unknown = JSON.parse(fs.readFileSync(full, "utf8"));
			out.push({ mtimeMs: stat.mtimeMs, rate_limits: rateLimitsOf(parsed) });
		} catch {
			// Ignore files that are corrupt or unreadable.
		}
	}
	return out;
}

/**
 * Draws rows — a small agent icon at the head of each, a bar plus `NN%` plus the countdown to
 * reset — grouped per enabled agent. Claude always gets exactly two (5h/7d). Every other agent's row *count* is dynamic: one row per window
 * it actually has a tracked percentage for, which can be the usual 5h/7d pair, a single
 * non-standard window (e.g. a 30-day-only plan), more than two, or none. Clicking re-reads/
 * re-fetches every agent's source right away.
 */
export class LimitsView {
	private hostEl: HTMLElement;
	/** One wrapper per shown agent — its rows are rebuilt fresh on every `render()` tick (the row
	 * count itself can change for a non-Claude agent as fresh `json stats` data arrives), so no
	 * per-row element needs tracking here, just the per-agent container. */
	private agentWrapEls: Partial<Record<AgentId, HTMLElement>> = {};
	/** The agents currently shown (`rebuildRows`'s snapshot of the enabled set) — falls back to
	 * `["claude"]` alone if somehow none is, so there's always at least one agent's rows. */
	private agents: AgentId[] = [];
	private claudeInfo: LimitsInfo | null = null;
	/** Every non-Claude enabled agent's windows, fetched via `json stats` — plus Claude's, only while
	 * one of its live readings is near the limit (`claudeNearLimit`), to tell whether it's used up. */
	private statsWindows: Partial<Record<AgentId, StatsWindows>> = {};
	private tickTimer: number | null = null;
	private statsFetchTimer: number | null = null;
	private refreshing = false;
	private refreshFlashTimer: number | null = null;

	constructor(
		container: HTMLElement,
		private plugin: AgentSessionsPlugin
	) {
		this.hostEl = container.createDiv({ cls: "agent-sessions-limits" });
		this.hostEl.addEventListener("click", () => this.refreshFromClick());
		setTooltip(this.hostEl, t("action.clickToRefresh"));
		this.rebuildRows();
		this.reload();
		this.tickTimer = window.setInterval(() => this.render(), 1000);
		this.statsFetchTimer = window.setInterval(() => void this.reloadStatsAgents(), STATS_FETCH_INTERVAL_MS);
	}

	/** Rebuilds the per-agent containers for the currently-enabled agent set — call whenever that
	 * set might have changed (`side.ts` calls this alongside its own settings-changed handling).
	 * A no-op (keeps existing containers and data) if the set is unchanged. */
	refreshAgents(): void {
		const next = agentsWithLimits(this.plugin.settings.agents);
		if (next.length === this.agents.length && next.every((id, i) => id === this.agents[i])) {
			return;
		}
		this.rebuildRows();
		this.reload();
	}

	private rebuildRows(): void {
		this.agents = agentsWithLimits(this.plugin.settings.agents);
		// Only OpenCode enabled: nothing to show, and no empty box either.
		this.hostEl.toggleClass("is-empty", this.agents.length === 0);
		this.hostEl.empty();
		this.agentWrapEls = {};
		for (const agent of this.agents) {
			this.agentWrapEls[agent] = this.hostEl.createDiv({ cls: "agent-sessions-limits-agent" });
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
	 * one call covers all of them, rather than a separate `json stats` per agent. Claude is
	 * included only while `claudeNearLimit`; otherwise its stale windows are dropped. */
	private async reloadStatsAgents(): Promise<void> {
		const claudeNear = this.agents.includes("claude") && claudeNearLimit(this.claudeInfo);
		if (!claudeNear) {
			delete this.statsWindows.claude;
		}
		const statsAgents = this.agents.filter((id) => id !== "claude" || claudeNear);
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
		this.refreshFlashTimer = window.setTimeout(() => {
			this.refreshing = false;
			this.hostEl.removeClass("is-refreshing");
			this.refreshFlashTimer = null;
		}, REFRESH_FLASH_MS);
	}

	dispose(): void {
		if (this.tickTimer) {
			window.clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		if (this.statsFetchTimer) {
			window.clearInterval(this.statsFetchTimer);
			this.statsFetchTimer = null;
		}
		if (this.refreshFlashTimer) {
			window.clearTimeout(this.refreshFlashTimer);
			this.refreshFlashTimer = null;
		}
	}

	private render(): void {
		// Refreshes `now` and re-evaluates roll-forward every time this is called (once a
		// second) — so the window shown is always the current one from the moment it resets,
		// independent of how often `reload()`/`reloadStatsAgents()` runs.
		const now = Date.now() / 1000;
		this.agents.forEach((agent, agentIndex) => {
			const wrapEl = this.agentWrapEls[agent];
			if (!wrapEl) {
				return;
			}
			wrapEl.empty();
			// a little extra space above the first row of a second-or-later agent group —
			// applied to the row itself (`agentWrapEls[agent]`, i.e. this whole `.agent-sessions-
			// limits-agent`, is `display: contents` now, so it has no box of its own to put a
			// margin on; see styles.css).
			let rowIndexWithinAgent = 0;
			const renderRow = (label: string, shortLabel: string, w: RateLimitWindow | null) => {
				this.renderAgentWindow(wrapEl, agent, label, shortLabel, w, isGroupStartRow(agentIndex, rowIndexWithinAgent));
				rowIndexWithinAgent++;
			};
			if (agent === "claude") {
				const claudeStats = this.statsWindows.claude;
				renderRow(
					t("stats.fiveHour"),
					t("stats.fiveHour.short"),
					withExhaustion(rollForwardWindow(this.claudeInfo?.fiveHour ?? null, FIVE_HOUR_SECONDS, now), claudeStats?.five_hour)
				);
				renderRow(
					t("stats.sevenDay"),
					t("stats.sevenDay.short"),
					withExhaustion(rollForwardWindow(this.claudeInfo?.sevenDay ?? null, SEVEN_DAY_SECONDS, now), claudeStats?.seven_day)
				);
				return;
			}
			// Only windows this agent actually has a tracked percentage for —
			// skips e.g. a null five_hour/seven_day pair entirely for an account whose only real
			// window is a non-standard length, rather than showing a permanently dashed-out row.
			for (const w of realWindows(this.statsWindows[agent] ?? null)) {
				const durationSeconds = w.minutes * 60;
				renderRow(windowLabel(w.minutes), windowShortLabel(w.minutes), rollForwardWindow(fromStatsWindow(w), durationSeconds, now));
			}
		});
	}

	private renderAgentWindow(
		container: HTMLElement,
		agent: AgentId,
		label: string,
		shortLabel: string,
		w: RateLimitWindow | null,
		isGroupStart: boolean
	): void {
		// every row is a `display: grid; grid-template-columns: subgrid` item spanning the
		// host's own column tracks (`.agent-sessions-limits`), so the icon/label/bar/%/countdown
		// columns line up across every row regardless of which agent it belongs to or how many
		// other rows are above/below it — see styles.css for the full mechanism.
		const el = container.createDiv({ cls: "agent-sessions-limits-row" });
		el.toggleClass("is-group-start", isGroupStart);
		const icon = AGENT_ICON_ID[agent];
		if (icon) {
			setIcon(el.createSpan({ cls: "agent-sessions-limits-agent-icon" }), icon);
		}
		// always the short form here ("5h"/"7d"/"30d") — the side panel is too narrow for
		// the long one ("5-hour window") at any width worth switching at, unlike the manager's own
		// wider stat cards, which still use the long form. The long form is still available, in
		// the tooltip.
		const labelEl = el.createSpan({ cls: "agent-sessions-limits-label", text: shortLabel });
		setTooltip(labelEl, label);
		const barWrap = el.createDiv({ cls: "agent-sessions-limits-bar" });
		barWrap.toggleClass("is-exhausted", !!w?.exhausted);
		const pct = w?.usedPercentage != null ? Math.min(100, Math.max(0, w.usedPercentage)) : 0;
		const bar = barWrap.createDiv({ cls: "agent-sessions-limits-bar-fill" });
		bar.style.width = `${pct}%`;
		const pctEl = el.createSpan({ cls: "agent-sessions-limits-pct", text: w?.usedPercentage != null ? `${Math.round(w.usedPercentage)}%` : "—" });
		// a used-up window says when it ran out, in the tooltip (the row has no room for it)
		const exhausted = w?.resetsAt != null ? exhaustedText({ end: w.resetsAt, exhausted: w.exhausted, exhausted_at: w.exhaustedAt }, Date.now() / 1000) : null;
		if (exhausted != null) {
			setTooltip(pctEl, exhausted);
		}
		const countdown = w?.resetsAt != null ? formatCountdown(w.resetsAt - Date.now() / 1000) : null;
		el.createSpan({ cls: "agent-sessions-limits-countdown", text: countdown ?? "—" });
	}
}

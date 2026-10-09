// The last token efficiency result of each pane: `<runtime>/efficiency/last-<pane>.json`, with
// the one before it moved to `prev-<pane>.json` on every save. Kept until the user deletes it, to
// show again next time and, later, to compare against. A file that can't be read or has another
// shape (including a result saved in an earlier format) is ignored. Holds no conversation text
// beyond the masked quotes the findings cite.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import type { EffHit, EffRange, EffTotals, Finding } from "./efficiency";
import type { HeadlessUsage } from "./organize-agent";

export const RESULT_VERSION = 2;

/** One check's result: no issues, an issue (its finding), or not applicable. */
export type CheckResultState = "ok" | "issue" | "na";

export interface SavedCheck {
	check: string;
	state: CheckResultState;
	finding: Finding | null;
}

export interface SavedResult {
	version: number;
	agent: string;
	savedAt: number;
	/** The model the analysis ran on, as shown. */
	model: string;
	range: EffRange;
	totals: EffTotals;
	/** Sessions in the range. */
	sessions: number;
	/** Their ids, to count the sessions started since. */
	sessionIds: string[];
	checks: SavedCheck[];
	/** The hits the findings cite (for their evidence). */
	hits: EffHit[];
	/** What the analysis itself used, all its requests added up. */
	selfCost: HeadlessUsage | null;
	/** What was sent: estimated tokens, and how many sessions' excerpts. */
	sent: { tokens: number; sessions: number };
	/** Per detector: hits and their impact, the numbers a later analysis compares with. */
	metrics: Record<string, { hits: number; impact_w: number }>;
}

export function detectorMetrics(hits: EffHit[]): SavedResult["metrics"] {
	const out: SavedResult["metrics"] = {};
	for (const h of hits) {
		const m = (out[h.detector] ??= { hits: 0, impact_w: 0 });
		m.hits += 1;
		m.impact_w += h.impact_w;
	}
	return out;
}

function lastPath(dir: string, agent: string): string {
	return join(dir, `last-${agent}.json`);
}

function prevPath(dir: string, agent: string): string {
	return join(dir, `prev-${agent}.json`);
}

/** Writes `result` as the pane's last result, moving the previous last one to `prev-`. */
export function saveResult(dir: string, result: SavedResult): void {
	mkdirSync(dir, { recursive: true });
	const last = lastPath(dir, result.agent);
	if (existsSync(last)) {
		renameSync(last, prevPath(dir, result.agent));
	}
	const tmp = `${last}.tmp`;
	writeFileSync(tmp, JSON.stringify(result), "utf8");
	renameSync(tmp, last);
}

function read(path: string, agent: string): SavedResult | null {
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as Partial<SavedResult>;
		if (
			data?.version !== RESULT_VERSION ||
			data.agent !== agent ||
			typeof data.savedAt !== "number" ||
			!data.range ||
			!data.totals ||
			!Array.isArray(data.checks) ||
			!data.checks.every((c) => c && typeof c.check === "string" && (c.state === "ok" || c.state === "issue" || c.state === "na")) ||
			!Array.isArray(data.hits) ||
			!Array.isArray(data.sessionIds)
		) {
			return null;
		}
		return data as SavedResult;
	} catch {
		return null;
	}
}

/** The pane's last saved result, or `null` (none, unreadable, another shape). */
export function loadResult(dir: string, agent: string): SavedResult | null {
	return read(lastPath(dir, agent), agent);
}

/** The result saved before the last one, or `null`. */
export function loadPrevious(dir: string, agent: string): SavedResult | null {
	return read(prevPath(dir, agent), agent);
}

/** Whether a saved result is worth showing for `range`: their time spans overlap. */
export function overlaps(saved: Pick<SavedResult, "range">, range: Pick<EffRange, "start" | "end">): boolean {
	return saved.range.start <= range.end && range.start <= saved.range.end;
}

// The last token efficiency result of each agent: `<runtime>/efficiency/last-<agent>.json`, with
// the one before it moved to `prev-<agent>.json` on every save. Kept until the user deletes it, to
// show again next time and, later, to compare against. A file that can't be read or has another
// shape is ignored. Holds no conversation text beyond the masked quotes the findings cite.

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import type { Dismissed, EffHit, EffRange, EffTotals, Finding } from "./efficiency";
import type { HeadlessUsage } from "./organize-agent";

export const RESULT_VERSION = 1;

export interface SavedResult {
	version: number;
	agent: string;
	savedAt: number;
	model: string;
	range: EffRange;
	totals: EffTotals;
	hits: EffHit[];
	findings: Finding[];
	dismissed: Dismissed[];
	selfCost: HeadlessUsage | null;
	/** sha1 of what was sent, to tell "the same content as last time". */
	payloadHash: string;
	/** Per detector: hits and their impact, the numbers a later analysis compares with. */
	metrics: Record<string, { hits: number; impact_w: number }>;
}

export function payloadHash(payload: string): string {
	return createHash("sha1").update(payload, "utf8").digest("hex");
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

/** Writes `result` as the agent's last result, moving the previous last one to `prev-`. */
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
			!Array.isArray(data.findings) ||
			!Array.isArray(data.hits)
		) {
			return null;
		}
		return data as SavedResult;
	} catch {
		return null;
	}
}

/** The agent's last saved result, or `null` (none, unreadable, another shape). */
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

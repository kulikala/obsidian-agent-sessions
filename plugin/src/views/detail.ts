// The detail view's pure data helpers — `DetailContext` and the bits of it tests exercise
// directly (`totalTokens`, `categoryAndLabel`, the re-exported `formatCost`). Kept free of any
// `obsidian` import since tests import this module directly, and the `obsidian` npm package has
// no runtime (its `main` is empty) outside the real app. The actual DOM rendering (badges, the
// context donut, the card layout, `renderDetail` itself) lives in `detail-render.ts`.

import type { Row } from "../sessions/index";
import { sessionDisplayName } from "../sessions/name";
import type { StatusInfo } from "../sessions/statusline";
import type { TerminalStatus } from "../sessions/terminal-status";
import { splitName } from "../sessions/tree";
import type { Detail, UsageResult, UsageTotal } from "../types";
import { formatCost } from "../usage/usage";

export interface DetailContext {
	row: Row;
	detail: Detail | null;
	statusInfo: StatusInfo | null;
	/** The session's state as the row mark shows it (`resolveRowStatus`). */
	status: TerminalStatus;
	/** `registry.get(id)?.rc ?? null`. `null` when there's no ledger entry. */
	rc: boolean | null;
	/** Calls `json usage`. The caller (`side.ts`/`manager.ts`) holds `agentSessionsPath`. */
	fetchUsage: () => Promise<UsageResult>;
	/** The category chip's color (a palette index). The caller passes `SessionIndex.categoryColorIndex`
	 * — a small chip goes above the name, and the name itself is shown with the category
	 * stripped out, so it uses the same color as the list/bar and the text isn't duplicated. */
	categoryColorIndex: (category: string) => number;
}

/** `input + output + cache read + cache create`. */
export function totalTokens(total: Pick<UsageTotal, "input" | "output" | "cache_read" | "cache_create">): number {
	return total.input + total.output + total.cache_read + total.cache_create;
}

/** `usage.ts`'s own `formatCost` (comma-grouped, `<$0.01` for a near-zero cost) — this
 * module used to have its own separate, slightly different implementation (no comma grouping, no
 * `<$0.01` case); re-exported from here instead of duplicated, since `manager.ts` and this
 * module's own tests already import it from here. */
export { formatCost };

/** The (category if any, name with category stripped) pair shown in the name field. */
export function categoryAndLabel(row: Row): { category: string | null; label: string } {
	if (row.name) {
		const [category, rest] = splitName(row.name);
		return { category, label: rest };
	}
	return { category: null, label: sessionDisplayName(row) };
}

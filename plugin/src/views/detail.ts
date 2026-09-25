// The detail view — a component shared by the side panel and the manager. Renders the name,
// badges (agent/model/effort/rc), a context-usage donut, total tokens/cost, the last instruction
// and response (click to expand), tools, folder, and ID.

import { renderCategoryChip } from "../ui/chip";
import type { Row } from "../sessions/index";
import { t } from "../i18n";
import { sessionDisplayName } from "../sessions/name";
import type { StatusInfo } from "../sessions/statusline";
import { splitName } from "../sessions/tree";
import type { Detail, UsageResult, UsageTotal } from "../types";
import { formatCost, formatK } from "../usage/usage";
import { shortModelName } from "./manager-model";
import { AGENT_NAME_KEY } from "./rows";
import { AGENT_ICON_ID } from "../ui/icons";

export interface DetailContext {
	row: Row;
	detail: Detail | null;
	statusInfo: StatusInfo | null;
	/** `registry.get(id)?.rc ?? null`. `null` when there's no ledger entry. */
	rc: boolean | null;
	/** Calls `json usage`. The caller (`side.ts`/`manager.ts`) holds `agentSessionsPath`. */
	fetchUsage: () => Promise<UsageResult>;
	/** The category chip's color (a palette index). The caller passes `SessionIndex.categoryColorIndex`
	 * — a small chip goes above the name, and the name itself is shown with the category
	 * stripped out, so it uses the same color as the list/bar and the text isn't duplicated. */
	categoryColorIndex: (category: string) => number;
}

const USAGE_TTL_MS = 60000;
const usageCache = new Map<string, { at: number; total: UsageTotal | null }>();

/** `input + output + cache read + cache create`. */
export function totalTokens(total: Pick<UsageTotal, "input" | "output" | "cache_read" | "cache_create">): number {
	return total.input + total.output + total.cache_read + total.cache_create;
}

/** `usage.ts`'s own `formatCost` (T-113: comma-grouped, `<$0.01` for a near-zero cost) — this
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

/** `obsidian`'s `setIcon`/`setTooltip` are required lazily (same reason as `rows.ts`'s
 * `require("electron")`: so importing just the pure functions — `totalTokens`, `formatCost` —
 * in tests doesn't fail trying to resolve `obsidian`). */
function makeIconButton(container: HTMLElement, icon: string, tooltip: string, onClick: () => void): HTMLElement {
	const { setIcon, setTooltip } = require("obsidian") as typeof import("obsidian");
	const btn = container.createSpan({ cls: "agent-sessions-detail-icon-btn" });
	setIcon(btn, icon);
	setTooltip(btn, tooltip);
	btn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		onClick();
	});
	return btn;
}

/** A small (28px) SVG donut for context usage. Just a faint ring if `percent` is absent. */
function renderDonut(container: HTMLElement, percent: number | null): void {
	const size = 28;
	const stroke = 4;
	const r = (size - stroke) / 2;
	const c = 2 * Math.PI * r;
	const pct = percent != null ? Math.min(100, Math.max(0, percent)) : 0;
	const offset = c * (1 - pct / 100);

	const wrap = container.createDiv({ cls: "agent-sessions-donut" });
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", `0 0 ${size} ${size}`);

	const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
	bg.setAttribute("cx", String(size / 2));
	bg.setAttribute("cy", String(size / 2));
	bg.setAttribute("r", String(r));
	bg.setAttribute("class", "agent-sessions-donut-bg");
	bg.setAttribute("stroke-width", String(stroke));
	svg.appendChild(bg);

	if (percent != null) {
		const fg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		fg.setAttribute("cx", String(size / 2));
		fg.setAttribute("cy", String(size / 2));
		fg.setAttribute("r", String(r));
		fg.setAttribute("class", "agent-sessions-donut-fg");
		fg.setAttribute("stroke-width", String(stroke));
		fg.setAttribute("stroke-dasharray", String(c));
		fg.setAttribute("stroke-dashoffset", String(offset));
		fg.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
		svg.appendChild(fg);
	}

	const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
	text.setAttribute("x", String(size / 2));
	text.setAttribute("y", String(size / 2));
	text.setAttribute("class", "agent-sessions-donut-text");
	text.setAttribute("text-anchor", "middle");
	text.setAttribute("dominant-baseline", "central");
	text.textContent = percent != null ? String(Math.round(percent)) : "—";
	svg.appendChild(text);

	wrap.appendChild(svg);
}

function renderBadges(
	container: HTMLElement,
	sessionRow: Row,
	statusInfo: StatusInfo | null,
	detail: Detail | null,
	rc: boolean | null
): void {
	const agent = sessionRow.agent;
	const row = container.createDiv({ cls: "agent-sessions-detail-badges" });
	const agentNameKey = AGENT_NAME_KEY[agent];
	const agentBadge = row.createSpan({ cls: "agent-sessions-badge agent-sessions-badge-agent" });
	const agentIcon = AGENT_ICON_ID[agent];
	if (agentIcon) {
		const { setIcon } = require("obsidian") as typeof import("obsidian");
		setIcon(agentBadge.createSpan({ cls: "agent-sessions-badge-agent-icon" }), agentIcon);
	}
	agentBadge.createSpan({ text: agentNameKey ? t(agentNameKey) : agent });
	// `statusInfo` (Claude's own live statusLine data) wins when present. Otherwise, for an agent
	// with no statusLine at all (Codex): `sessionRow.model`/`.effort` (T-107, `json scan`'s
	// Codex-only fields — already loaded, no extra fetch) first, then `detail`'s most-recent-turn
	// model/effort (`json detail`, per-session, may not have resolved yet) as a last resort.
	const model = statusInfo?.model ?? sessionRow.model ?? detail?.model ?? null;
	const modelBadge = row.createSpan({ cls: "agent-sessions-badge" });
	if (statusInfo?.model) {
		// Claude's own display name, shown as-is (unchanged from before T-107).
		modelBadge.setText(statusInfo.model);
	} else if (model) {
		// Codex's raw model id (e.g. "gpt-5.6-luna") needs an actual short-name transform, not
		// just a parenthetical-stripping one — the full raw value goes in the tooltip.
		const { setTooltip } = require("obsidian") as typeof import("obsidian");
		modelBadge.setText(shortModelName(model, agent));
		setTooltip(modelBadge, model);
	} else {
		modelBadge.setText(t("common.default"));
	}
	row.createSpan({
		cls: "agent-sessions-badge",
		text: statusInfo?.effort ?? sessionRow.effort ?? detail?.effort ?? t("common.default"),
	});
	const rcBadge = row.createSpan({ cls: "agent-sessions-badge" });
	rcBadge.appendText("rc ");
	// ○ both when there's no ledger entry (`null`) and when disconnected; only ● when connected (`true`).
	const dot = rcBadge.createSpan({
		cls: "agent-sessions-badge-rc-dot",
		text: rc ? "●" : "○",
	});
	dot.toggleClass("is-connected", !!rc);
}

/** A card that collapses/expands on click (`-webkit-line-clamp: 6`). */
function renderCard(container: HTMLElement, label: string, value: string | null | undefined): void {
	const card = container.createDiv({ cls: "agent-sessions-detail-card" });
	card.createDiv({ cls: "agent-sessions-detail-card-label", text: label });
	const body = card.createDiv({ cls: "agent-sessions-detail-card-body is-clamped", text: value || t("common.none") });
	let expanded = false;
	card.addEventListener("click", () => {
		expanded = !expanded;
		body.toggleClass("is-clamped", !expanded);
	});
}

/** A label+value row. Returns the value's `span` so it can be updated later. */
function field(container: HTMLElement, label: string, value: string): { el: HTMLElement; valueEl: HTMLElement } {
	const el = container.createDiv({ cls: "agent-sessions-detail-field" });
	el.createSpan({ cls: "agent-sessions-detail-label", text: label });
	const valueEl = el.createSpan({ cls: "agent-sessions-detail-value", text: value });
	return { el, valueEl };
}

/** Returns `id`'s cached `total`. `undefined` if there's none (not fetched yet, or stale). */
function cachedTotal(id: string): UsageTotal | null | undefined {
	const entry = usageCache.get(id);
	if (!entry || Date.now() - entry.at > USAGE_TTL_MS) {
		return undefined;
	}
	return entry.total;
}

/** The detail view's body. Empties the container when `ctx` is `null`. */
export function renderDetail(container: HTMLElement, ctx: DetailContext | null): void {
	container.empty();
	if (!ctx) {
		return;
	}
	const { row, detail, statusInfo, rc } = ctx;
	container.dataset.rowId = row.id;

	const { category, label } = categoryAndLabel(row);
	if (category) {
		const catEl = container.createDiv({ cls: "agent-sessions-detail-category" });
		renderCategoryChip(catEl, category, ctx.categoryColorIndex(category));
	}
	container.createEl("h4", { cls: "agent-sessions-detail-name", text: label });
	renderBadges(container, row, statusInfo, detail, rc);

	const statsRow = container.createDiv({ cls: "agent-sessions-detail-stats" });
	renderDonut(statsRow, statusInfo?.ctxPercent ?? null);
	// Right after a compact (SessionStart source=compact until the next UserPromptSubmit), ctx
	// is near 0 and easy to mistake for other states, so show a small marker next to it.
	// `row.compacted` comes from the marker file, so this works even for rows without a tab.
	if (row.compacted) {
		statsRow.createSpan({ cls: "agent-sessions-detail-compacted", text: t("detail.compacted") });
	}
	const statsText = statsRow.createDiv({ cls: "agent-sessions-detail-stats-text" });
	const tokens = field(statsText, t("detail.totalTokens"), "…");
	const cost = field(statsText, t("detail.totalCost"), "…");

	const cards = container.createDiv({ cls: "agent-sessions-detail-cards" });
	renderCard(cards, t("detail.lastUser"), detail?.last_user);
	renderCard(cards, t("detail.lastAssistant"), detail?.last_assistant);

	if (detail?.tools.length) {
		field(container, t("detail.tools"), detail.tools.join(t("common.listSep")));
	}
	field(container, t("detail.folder"), row.folder);
	const idField = field(container, "ID", row.id);
	makeIconButton(idField.el, "copy", t("action.copyId"), () => void navigator.clipboard.writeText(row.id));

	const applyTotal = (total: UsageTotal | null) => {
		if (container.dataset.rowId !== row.id) {
			return;
		}
		tokens.valueEl.setText(total ? formatK(totalTokens(total)) : "—");
		cost.valueEl.setText(total ? formatCost(total.cost) : "—");
	};

	const cached = cachedTotal(row.id);
	if (cached !== undefined) {
		applyTotal(cached);
		return;
	}
	void ctx
		.fetchUsage()
		.then((result) => {
			usageCache.set(row.id, { at: Date.now(), total: result.total });
			applyTotal(result.total);
		})
		.catch(() => {
			usageCache.set(row.id, { at: Date.now(), total: null });
			applyTotal(null);
		});
}

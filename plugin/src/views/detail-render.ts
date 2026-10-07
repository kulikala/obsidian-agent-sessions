// The detail view's DOM rendering — a component shared by the side panel and the manager. Renders
// the name, badges (agent/model/effort/rc), a context-usage donut, total tokens/cost, the last
// instruction and response (click to expand), tools, folder, and ID. Split out from `detail.ts`
// (which keeps the pure data helpers tests import directly) because this needs real `obsidian`
// exports (`setIcon`/`setTooltip`), and `obsidian`'s npm package has no runtime (its `main` is
// empty) outside the real app.

import { setIcon, setTooltip } from "obsidian";
import { renderCategoryChip } from "../ui/chip";
import type { StatusInfo } from "../sessions/statusline";
import type { Detail } from "../types";
import { costView, formatK } from "../usage/usage";
import { shortModelName } from "./manager-model";
import { AGENT_NAME_KEY } from "./rows";
import { AGENT_ICON_ID } from "../ui/icons";
import { t } from "../i18n";
import type { Row } from "../sessions/index";
import type { UsageTotal } from "../types";
import { categoryAndLabel, totalTokens, type DetailContext } from "./detail";
import { goalLabelKey, goalState } from "../sessions/goal";
import type { SessionGoal } from "../types";
import { renderGoalMark } from "./goal-render";
import { formatTime } from "./rows";

const USAGE_TTL_MS = 60000;
const usageCache = new Map<string, { at: number; total: UsageTotal | null }>();

function makeIconButton(container: HTMLElement, icon: string, tooltip: string, onClick: () => void): HTMLElement {
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
	const svg = wrap.createSvg("svg", { attr: { width: size, height: size, viewBox: `0 0 ${size} ${size}` } });

	svg.createSvg("circle", {
		cls: "agent-sessions-donut-bg",
		attr: { cx: size / 2, cy: size / 2, r, "stroke-width": stroke },
	});

	if (percent != null) {
		svg.createSvg("circle", {
			cls: "agent-sessions-donut-fg",
			attr: {
				cx: size / 2,
				cy: size / 2,
				r,
				"stroke-width": stroke,
				"stroke-dasharray": c,
				"stroke-dashoffset": offset,
				transform: `rotate(-90 ${size / 2} ${size / 2})`,
			},
		});
	}

	const text = svg.createSvg("text", {
		cls: "agent-sessions-donut-text",
		attr: { x: size / 2, y: size / 2, "text-anchor": "middle", "dominant-baseline": "central" },
	});
	text.textContent = percent != null ? String(Math.round(percent)) : "—";
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
		setIcon(agentBadge.createSpan({ cls: "agent-sessions-badge-agent-icon" }), agentIcon);
	}
	agentBadge.createSpan({ text: agentNameKey ? t(agentNameKey) : agent });
	// `statusInfo` (Claude's own live statusLine data) wins when present. Otherwise, for an agent
	// with no statusLine at all (Codex): `sessionRow.model`/`.effort` (`json scan`'s
	// Codex-only fields — already loaded, no extra fetch) first, then `detail`'s most-recent-turn
	// model/effort (`json detail`, per-session, may not have resolved yet) as a last resort.
	const model = statusInfo?.model ?? sessionRow.model ?? detail?.model ?? null;
	const modelBadge = row.createSpan({ cls: "agent-sessions-badge" });
	if (statusInfo?.model) {
		// Claude's own display name, shown as-is.
		modelBadge.setText(statusInfo.model);
	} else if (model) {
		// Codex's raw model id (e.g. "gpt-5.6-luna") needs an actual short-name transform, not
		// just a parenthetical-stripping one — the full raw value goes in the tooltip.
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

/**
 * The session's `/goal`: its state with the goal mark, when it was set, the condition, and the
 * evaluator's latest reason (both clamped like the cards below; click to expand).
 */
function renderGoal(container: HTMLElement, goal: SessionGoal | null | undefined): void {
	const state = goalState(goal);
	if (!goal || !state) {
		return;
	}
	const card = container.createDiv({ cls: `agent-sessions-detail-card agent-sessions-detail-goal is-${state}` });
	const head = card.createDiv({ cls: "agent-sessions-detail-card-label agent-sessions-detail-goal-head" });
	renderGoalMark(head, goal, null);
	head.createSpan({ text: t(goalLabelKey(goal, state)) });
	if (goal.since) {
		head.createSpan({ cls: "agent-sessions-detail-goal-since", text: t("goal.since", { time: formatTime(goal.since) }) });
	}
	const body = card.createDiv({ cls: "agent-sessions-detail-card-body is-clamped", text: goal.condition });
	const reason = goal.reason
		? card.createDiv({ cls: "agent-sessions-detail-goal-reason is-clamped", text: `${t("goal.reason")}: ${goal.reason}` })
		: null;
	let expanded = false;
	card.addEventListener("click", () => {
		expanded = !expanded;
		body.toggleClass("is-clamped", !expanded);
		reason?.toggleClass("is-clamped", !expanded);
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
	// Right after a compact (until a prompt the model answers), ctx is near 0 and easy to mistake
	// for other states, so show a small marker next to it. `row.compacted` comes from the marker
	// file and the scan, so this works even for rows without a tab.
	if (row.compacted) {
		statsRow.createSpan({ cls: "agent-sessions-detail-compacted", text: t("detail.compacted") });
	}
	const statsText = statsRow.createDiv({ cls: "agent-sessions-detail-stats-text" });
	const tokens = field(statsText, t("detail.totalTokens"), "…");
	const cost = field(statsText, t("detail.totalCost"), "…");

	const cards = container.createDiv({ cls: "agent-sessions-detail-cards" });
	renderGoal(cards, row.goal);
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
		const view = total ? costView(total) : null;
		cost.valueEl.setText(view ? view.text : "—");
		if (view?.note) {
			setTooltip(cost.valueEl, view.note);
		}
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

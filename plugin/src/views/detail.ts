// 詳細ビュー（サイドパネル・マネージャー共用の部品。D-43・§6.1・§6.2）。
// 名前・バッジ（モデル／エフォート／rc）・コンテキスト使用率のドーナツ・総トークン／
// 総コスト・直近の指示／応答（クリックで展開）・ツール・フォルダ・ID を描く。

import type { Row } from "../index";
import type { StatusInfo } from "../statusline";
import type { Detail, UsageResult, UsageTotal } from "../types";
import { formatK } from "../usage";

export interface DetailContext {
	row: Row;
	detail: Detail | null;
	statusInfo: StatusInfo | null;
	/** `registry.get(id)?.rc ?? null`。台帳が無ければ `null`。 */
	rc: boolean | null;
	/** `json usage` を呼ぶ関数。呼出側（`side.ts`・`manager.ts`）が `agentSessionsPath` を持つ。 */
	fetchUsage: () => Promise<UsageResult>;
}

const USAGE_TTL_MS = 60000;
const usageCache = new Map<string, { at: number; total: UsageTotal | null }>();

/** `入力 + 出力 + cache 読出 + cache 作成`。 */
export function totalTokens(total: Pick<UsageTotal, "input" | "output" | "cache_read" | "cache_create">): number {
	return total.input + total.output + total.cache_read + total.cache_create;
}

/** `$x.xx`。 */
export function formatCost(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

function displayName(row: Row): string {
	return row.name || row.label || `無題 ${row.id.slice(0, 8)}`;
}

/** `obsidian` の `setIcon`／`setTooltip` は遅延 require（`rows.ts` の `require("electron")` と同じ理由：
 * 純関数（`totalTokens`・`formatCost`）だけをテストで import するとき、`obsidian` の
 * 解決に失敗させないため）。 */
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

/** コンテキスト使用率の小さな SVG ドーナツ（28px）。`percent` が無ければ薄いリングだけ。 */
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

function renderBadges(container: HTMLElement, statusInfo: StatusInfo | null, rc: boolean | null): void {
	const row = container.createDiv({ cls: "agent-sessions-detail-badges" });
	row.createSpan({ cls: "agent-sessions-badge", text: statusInfo?.model ?? "デフォルト" });
	row.createSpan({ cls: "agent-sessions-badge", text: statusInfo?.effort ?? "デフォルト" });
	const rcBadge = row.createSpan({ cls: "agent-sessions-badge" });
	rcBadge.appendText("rc ");
	const dot = rcBadge.createSpan({
		cls: "agent-sessions-badge-rc-dot",
		text: rc === null ? "—" : rc ? "●" : "○",
	});
	dot.toggleClass("is-connected", !!rc);
}

/** クリックで折畳／展開する 1 枚のカード（`-webkit-line-clamp: 6`）。 */
function renderCard(container: HTMLElement, label: string, value: string | null | undefined): void {
	const card = container.createDiv({ cls: "agent-sessions-detail-card" });
	card.createDiv({ cls: "agent-sessions-detail-card-label", text: label });
	const body = card.createDiv({ cls: "agent-sessions-detail-card-body is-clamped", text: value || "（無し）" });
	let expanded = false;
	card.addEventListener("click", () => {
		expanded = !expanded;
		body.toggleClass("is-clamped", !expanded);
	});
}

/** ラベル＋値の 1 行。値の `span` を返す（あとから書き換えられるように）。 */
function field(container: HTMLElement, label: string, value: string): { el: HTMLElement; valueEl: HTMLElement } {
	const el = container.createDiv({ cls: "agent-sessions-detail-field" });
	el.createSpan({ cls: "agent-sessions-detail-label", text: label });
	const valueEl = el.createSpan({ cls: "agent-sessions-detail-value", text: value });
	return { el, valueEl };
}

/** `id` のキャッシュ済み `total` を返す。無ければ `null`（未取得か古い）。 */
function cachedTotal(id: string): UsageTotal | null | undefined {
	const entry = usageCache.get(id);
	if (!entry || Date.now() - entry.at > USAGE_TTL_MS) {
		return undefined;
	}
	return entry.total;
}

/** 詳細ビュー本体。`ctx` が `null` なら空にする。 */
export function renderDetail(container: HTMLElement, ctx: DetailContext | null): void {
	container.empty();
	if (!ctx) {
		return;
	}
	const { row, detail, statusInfo, rc } = ctx;
	container.dataset.rowId = row.id;

	container.createEl("h4", { cls: "agent-sessions-detail-name", text: displayName(row) });
	renderBadges(container, statusInfo, rc);

	const statsRow = container.createDiv({ cls: "agent-sessions-detail-stats" });
	renderDonut(statsRow, statusInfo?.ctxPercent ?? null);
	const statsText = statsRow.createDiv({ cls: "agent-sessions-detail-stats-text" });
	const tokens = field(statsText, "総トークン", "…");
	const cost = field(statsText, "総コスト", "…");

	const cards = container.createDiv({ cls: "agent-sessions-detail-cards" });
	renderCard(cards, "直近の指示", detail?.last_user);
	renderCard(cards, "直近の応答", detail?.last_assistant);

	if (detail?.tools.length) {
		field(container, "ツール", detail.tools.join("、"));
	}
	field(container, "フォルダ", row.folder);
	const idField = field(container, "ID", row.id);
	makeIconButton(idField.el, "copy", "ID をコピー", () => void navigator.clipboard.writeText(row.id));

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

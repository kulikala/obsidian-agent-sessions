// 行の描画・選択・行メニュー（サイドパネルとマネージャーで共用。§6.1・§6.2）。詳細欄は views/detail.ts。

import { Menu, setTooltip, type App } from "obsidian";
import { categoryHueDeg } from "../category";
import type { Row } from "../index";
import { t } from "../i18n";
import type AgentSessionsPlugin from "../main";
import { RenameSessionModal } from "../modals";
import { resolveRowStatus, STATUS_LABEL_KEY, terminalStatusClass } from "../terminal-status";
import { splitName } from "../tree";

export interface RowActions {
	openSession(id: string): void;
	rename(id: string, currentName: string): void;
	compact(id: string): void;
	toggleArchive(row: Row): void;
	endSession(id: string): void;
	copyId(id: string): void;
	/** 300 ms ホバーで呼ばれる。 */
	showDetail(id: string): void;
	/** ホバーが外れたら呼ばれる（既定の表示に戻すため。D-43 実機修正）。 */
	hideDetail?(): void;
	/** セッション解析結果のモーダルを開く（D-31・D-45）。 */
	showUsage(id: string): void;
	/**
	 * 直近のスラッシュコマンド（`json detail` の `last_command`。例 `/compact`。引数は
	 * 含めない）。取得済みなら同期で返す——新たに `json detail` を呼ばない
	 * （`index.getCachedDetail`）。無ければ `undefined`（「セッションを圧縮」を非活性に
	 * しない）。
	 */
	lastUserPrompt?(id: string): string | undefined;
}

export interface RenderRowOptions {
	/** 前面のターミナルタブの行を強調する（サイドパネルの「開いているタブ」）。 */
	front?: boolean;
	/** マネージャーの子行のようにインデントする。 */
	indent?: boolean;
	selection: RowSelection;
	actions: RowActions;
	/** 状態の印（`rowStatusMark`）が `terminalStatuses` を読むのに使う（D-66 追補）。 */
	plugin: AgentSessionsPlugin;
}

const HOVER_DELAY_MS = 300;

/** 選択中の行を 1 つだけ持つ（強調のみ。`⋯` は常時表示——選択とは独立）。 */
export class RowSelection {
	private current: HTMLElement | null = null;

	select(el: HTMLElement, _menuBtn?: HTMLElement): void {
		this.clear();
		el.addClass("is-selected");
		this.current = el;
	}

	clear(): void {
		if (this.current) {
			this.current.removeClass("is-selected");
			this.current = null;
		}
	}
}

/**
 * 状態の印（小さな点）を 1 つ作って積む：タブが開いていれば `plugin.terminalStatuses`
 * の実際の状態、無ければ `Row` だけから分かる範囲（`resolveRowStatus`）。タブのアイコンと
 * 同じ色・動きの CSS クラス、tooltip も状態名で揃える（D-66 追補）。
 */
export function rowStatusMark(container: HTMLElement, plugin: AgentSessionsPlugin, row: Row): HTMLElement {
	const status = resolveRowStatus(plugin, row);
	const mark = container.createSpan({ cls: `agent-sessions-row-mark ${terminalStatusClass(status)}` });
	setTooltip(mark, t(STATUS_LABEL_KEY[status]));
	return mark;
}

export function displayName(row: Row): string {
	return row.name || row.label || t("common.untitled", { id: row.id.slice(0, 8) });
}

/** `row` のカテゴリ（名前の `': '` より前。`tree.ts` の `splitName` と同じ）。無ければ `null`。 */
export function categoryOf(row: Row): string | null {
	if (!row.name) {
		return null;
	}
	return splitName(row.name)[0];
}

/**
 * 表・一覧に出す名前：カテゴリが有ればそれを除いた分（`splitName` の 2 要素目）、
 * 無ければ `displayName`（`label`／無題）に落ちる（D-65。マネージャーの表と一覧で共用）。
 */
export function rowLabel(row: Row): string {
	if (row.name) {
		return splitName(row.name)[1];
	}
	return displayName(row);
}

export function formatTime(epochSeconds: number): string {
	if (!epochSeconds) {
		return "";
	}
	const d = new Date(epochSeconds * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 行メニュー（名前を変更・セッションを圧縮・アーカイブ・終了・セッション解析結果・ID をコピー）。
 * `manager.ts` の表からも同じものを開く（D-44：⋯・右クリック共通）。 */
export function showRowMenu(evt: MouseEvent, row: Row, actions: RowActions): void {
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle(t("action.rename"))
			.setIcon("pencil")
			.onClick(() => actions.rename(row.id, row.name ?? ""))
	);
	const lastPrompt = actions.lastUserPrompt?.(row.id);
	const alreadyCompacted = lastPrompt != null && lastPrompt.trim() === "/compact";
	menu.addItem((item) => {
		item
			.setTitle(t("action.compact"))
			.setIcon("scissors")
			.onClick(() => actions.compact(row.id));
		if (alreadyCompacted) {
			item.setDisabled(true);
		}
	});
	menu.addItem((item) =>
		item
			.setTitle(row.archived ? t("action.unarchive") : t("action.archive"))
			.setIcon(row.archived ? "archive-restore" : "archive")
			.onClick(() => actions.toggleArchive(row))
	);
	if (row.daemon) {
		menu.addItem((item) =>
			item
				.setTitle(t("action.endSession"))
				.setIcon("square-x")
				.onClick(() => actions.endSession(row.id))
		);
	}
	menu.addItem((item) =>
		item
			.setTitle(t("action.usage"))
			.setIcon("bar-chart-2")
			.onClick(() => actions.showUsage(row.id))
	);
	menu.addItem((item) =>
		item
			.setTitle(t("action.copyId"))
			.setIcon("copy")
			.onClick(() => actions.copyId(row.id))
	);
	menu.showAtMouseEvent(evt);
}

/** 1 行を描く：`状態の印  名前  時刻  ▣  ⋯`。`⋯` は常時表示（D-43）。 */
export function renderRow(container: HTMLElement, row: Row, opts: RenderRowOptions): HTMLElement {
	const el = container.createDiv({ cls: "agent-sessions-row" });
	if (opts.front) {
		el.addClass("is-front");
	}
	if (opts.indent) {
		el.addClass("is-indented");
	}
	if (row.archived) {
		el.addClass("is-archived");
	}

	rowStatusMark(el, opts.plugin, row);
	const category = categoryOf(row);
	if (category) {
		const chip = el.createSpan({ cls: "agent-sessions-row-chip", text: category });
		chip.style.setProperty("--as-chip-hue", String(categoryHueDeg(category)));
	}
	el.createSpan({ cls: "agent-sessions-row-name", text: rowLabel(row) });
	const time = formatTime(row.last_activity);
	if (time) {
		el.createSpan({ cls: "agent-sessions-row-time", text: time });
	}
	if (row.hasTab) {
		el.createSpan({ cls: "agent-sessions-row-tab-mark", text: "▣" });
	}

	const menuBtn = el.createSpan({ cls: "agent-sessions-row-menu-btn", text: "⋯" });
	menuBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		opts.selection.select(el, menuBtn);
		showRowMenu(evt, row, opts.actions);
	});

	el.addEventListener("click", () => {
		opts.selection.select(el, menuBtn);
		opts.actions.openSession(row.id);
	});
	el.addEventListener("contextmenu", (evt) => {
		evt.preventDefault();
		opts.selection.select(el, menuBtn);
		showRowMenu(evt, row, opts.actions);
	});

	let hoverTimer: ReturnType<typeof setTimeout> | null = null;
	el.addEventListener("pointerenter", () => {
		hoverTimer = setTimeout(() => opts.actions.showDetail(row.id), HOVER_DELAY_MS);
	});
	el.addEventListener("pointerleave", () => {
		if (hoverTimer) {
			clearTimeout(hoverTimer);
			hoverTimer = null;
		}
		opts.actions.hideDetail?.();
	});

	return el;
}

/** グループの見出し行（折畳の三角と件数）。クリックで `onToggle`。 */
export function renderGroupHeader(
	container: HTMLElement,
	name: string,
	count: number,
	folded: boolean,
	onToggle: () => void
): HTMLElement {
	const el = container.createDiv({ cls: "agent-sessions-group-header" });
	if (folded) {
		el.addClass("is-folded");
	}
	el.createSpan({ cls: "agent-sessions-group-caret", text: folded ? "▶" : "▼" });
	el.createSpan({ cls: "agent-sessions-group-name", text: name });
	el.createSpan({ cls: "agent-sessions-group-count", text: String(count) });
	el.addEventListener("click", () => onToggle());
	return el;
}

/**
 * サイドパネル・マネージャー共通の行アクション。`openSession`・`rename`・`compact`・
 * `toggleArchive`・`endSession`・`copyId` は両ビューで同じ振る舞い（§6.6）。
 * `onShowDetail` だけビューごと（詳細欄の描画先が違う）。
 */
export function createRowActions(
	app: App,
	plugin: AgentSessionsPlugin,
	onShowDetail: (id: string) => void,
	onHideDetail?: () => void
): RowActions {
	return {
		openSession: (id) => {
			const row = plugin.index.sessions.get(id);
			void plugin.openSession(id, { agent: row?.agent ?? "claude", cwd: row?.cwd ?? "" });
		},
		rename: (id, currentName) => {
			new RenameSessionModal(app, plugin.index.categories(), currentName, (name) => void plugin.renameSession(id, name)).open();
		},
		compact: (id) => void plugin.compactSession(id),
		toggleArchive: (row) => {
			if (row.archived) {
				plugin.unarchive(row.id);
			} else {
				plugin.archive(row.id, row.name || row.label || row.id, row.agent);
			}
		},
		endSession: (id) => plugin.endSession(id),
		copyId: (id) => {
			void navigator.clipboard.writeText(id);
		},
		showDetail: onShowDetail,
		hideDetail: onHideDetail,
		showUsage: (id) => plugin.showUsage(id),
		lastUserPrompt: (id) => plugin.index.getCachedDetail(id)?.last_command ?? undefined,
	};
}

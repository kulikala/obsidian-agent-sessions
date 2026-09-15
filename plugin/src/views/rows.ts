// 行の描画・選択・行メニュー・詳細欄（サイドパネルとマネージャーで共用。§6.1・§6.2）。

import { Menu, type App } from "obsidian";
import type { Row } from "../index";
import type AgentSessionsPlugin from "../main";
import { RenameSessionModal } from "../modals";
import type { Detail } from "../types";

export interface RowActions {
	openSession(id: string): void;
	rename(id: string, currentName: string): void;
	compact(id: string): void;
	toggleArchive(row: Row): void;
	endSession(id: string): void;
	openFolder(cwd: string): void;
	copyId(id: string): void;
	/** 300 ms ホバーで呼ばれる。 */
	showDetail(id: string): void;
}

export interface RenderRowOptions {
	/** 前面のターミナルタブの行を強調する（サイドパネルの「開いているタブ」）。 */
	front?: boolean;
	/** マネージャーの子行のようにインデントする。 */
	indent?: boolean;
	selection: RowSelection;
	actions: RowActions;
}

const HOVER_DELAY_MS = 300;

/** 選択中の行を 1 つだけ持つ（クリック／右クリックで `⋯` を出す）。 */
export class RowSelection {
	private current: { el: HTMLElement; menuBtn: HTMLElement } | null = null;

	select(el: HTMLElement, menuBtn: HTMLElement): void {
		this.clear();
		el.addClass("is-selected");
		menuBtn.show();
		this.current = { el, menuBtn };
	}

	clear(): void {
		if (this.current) {
			this.current.el.removeClass("is-selected");
			this.current.menuBtn.hide();
			this.current = null;
		}
	}
}

function statusMark(row: Row): string {
	if (row.exited != null) {
		return "circle-off";
	}
	if (row.status === "busy" || row.status === "shell") {
		return "agent-sessions-mark-busy";
	}
	if (row.status === "idle") {
		return "agent-sessions-mark-waiting";
	}
	return "agent-sessions-mark-none";
}

function displayName(row: Row): string {
	return row.pendingRename || row.name || row.label || `無題 ${row.id.slice(0, 8)}`;
}

function formatTime(epochSeconds: number): string {
	if (!epochSeconds) {
		return "";
	}
	const d = new Date(epochSeconds * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function showRowMenu(evt: MouseEvent, row: Row, actions: RowActions): void {
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle("名前を変更")
			.setIcon("pencil")
			.onClick(() => actions.rename(row.id, row.name ?? ""))
	);
	menu.addItem((item) =>
		item
			.setTitle("圧縮")
			.setIcon("scissors")
			.onClick(() => actions.compact(row.id))
	);
	menu.addItem((item) =>
		item
			.setTitle(row.archived ? "アーカイブ解除" : "アーカイブ")
			.setIcon(row.archived ? "archive-restore" : "archive")
			.onClick(() => actions.toggleArchive(row))
	);
	if (row.daemon) {
		menu.addItem((item) =>
			item
				.setTitle("セッションを終了")
				.setIcon("square-x")
				.onClick(() => actions.endSession(row.id))
		);
	}
	menu.addItem((item) =>
		item
			.setTitle("フォルダを開く")
			.setIcon("folder-open")
			.onClick(() => actions.openFolder(row.cwd))
	);
	menu.addItem((item) =>
		item
			.setTitle("ID をコピー")
			.setIcon("copy")
			.onClick(() => actions.copyId(row.id))
	);
	menu.showAtMouseEvent(evt);
}

/** 1 行を描く：`状態の印  名前  時刻  ▣`。行の選択で `⋯` が現れる。 */
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

	el.createSpan({ cls: `agent-sessions-row-mark ${statusMark(row)}` });
	el.createSpan({ cls: "agent-sessions-row-name", text: displayName(row) });
	if (row.pendingRename) {
		el.createSpan({ cls: "agent-sessions-row-pending", text: "（未適用）" });
	}
	const time = formatTime(row.last_activity);
	if (time) {
		el.createSpan({ cls: "agent-sessions-row-time", text: time });
	}
	if (row.hasTab) {
		el.createSpan({ cls: "agent-sessions-row-tab-mark", text: "▣" });
	}

	const menuBtn = el.createSpan({ cls: "agent-sessions-row-menu-btn", text: "⋯" });
	menuBtn.hide();
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

function addDetailField(container: HTMLElement, label: string, value: string | null | undefined): void {
	if (!value) {
		return;
	}
	const field = container.createDiv({ cls: "agent-sessions-detail-field" });
	field.createSpan({ cls: "agent-sessions-detail-label", text: label });
	field.createSpan({ cls: "agent-sessions-detail-value", text: value });
}

/**
 * サイドパネル・マネージャー共通の行アクション。`openSession`・`rename`・`compact`・
 * `toggleArchive`・`endSession`・`openFolder`・`copyId` は両ビューで同じ振る舞い（§6.6）。
 * `onShowDetail` だけビューごと（詳細欄の描画先が違う）。
 */
export function createRowActions(app: App, plugin: AgentSessionsPlugin, onShowDetail: (id: string) => void): RowActions {
	return {
		openSession: (id) => {
			const row = plugin.index.sessions.get(id);
			void plugin.openSession(id, { agent: row?.agent ?? "claude", cwd: row?.cwd ?? "" });
		},
		rename: (id, currentName) => {
			new RenameSessionModal(app, currentName, (name) => void plugin.renameSession(id, name)).open();
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
		openFolder: (cwd) => {
			try {
				(require("electron").shell as { openPath(p: string): Promise<string> }).openPath(cwd);
			} catch (err) {
				console.warn("agent-sessions: フォルダを開けません", err);
			}
		},
		copyId: (id) => {
			void navigator.clipboard.writeText(id);
		},
		showDetail: onShowDetail,
	};
}

/** 詳細欄：直近の指示・直近のツール・直近の応答・フォルダ・ID（§6.1）。 */
export function renderDetailPane(container: HTMLElement, row: Row | undefined, detail: Detail | null): void {
	container.empty();
	if (!row) {
		return;
	}
	const lastTool = detail?.tools[detail.tools.length - 1] ?? null;
	addDetailField(container, "直近の指示", detail?.last_user);
	addDetailField(container, "直近のツール", lastTool);
	addDetailField(container, "直近の応答", detail?.last_assistant);
	addDetailField(container, "フォルダ", row.folder);
	addDetailField(container, "ID", row.id);
}

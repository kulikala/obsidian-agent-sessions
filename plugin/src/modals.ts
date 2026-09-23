// 新規セッション・名前を変更・確認のダイアログ（§6.6・§6.12・D-63・T-70）。

import { App, Modal, Setting } from "obsidian";
import type AgentSessionsPlugin from "./main";
import { renderCategoryChip } from "./chip";
import { t } from "./i18n";
import { composeName, filterCategories, tokenizeNameInput } from "./name";
import { splitName } from "./tree";

interface ComposedNameField {
	getValue(): { category: string; name: string };
	focus(): void;
}

/**
 * カテゴリと名前を「1 つの入力欄」に見せる（T-70）：見た目は input 風の枠（div）の中に
 * `[カテゴリのチップ（有れば）][<input>]` が繋がって並ぶ。`<input>` に「カテゴリ: 」と打つ
 * （`tokenizeNameInput`）とその前の部分がチップになり、入力は残り（名前）に続く。名前が
 * 空の状態で Backspace、またはチップのクリックで、チップはテキストへ戻って編集できる。
 * カテゴリを入力中（まだチップになる前）は既存カテゴリの候補を出す（上下キー＋Enter／Tab／
 * クリックで確定）。確定はダイアログのボタンだけ（この欄の Enter では確定しない——候補選択中の
 * Enter は候補の確定）。
 */
function buildComposedNameField(
	contentEl: HTMLElement,
	categories: string[],
	colorIndexFor: (category: string) => number,
	initial: { category: string; name: string }
): ComposedNameField {
	const setting = new Setting(contentEl).setName(t("modal.newSession.nameField"));
	const boxEl = setting.controlEl.createDiv({ cls: "agent-sessions-name-input" });
	const inputEl = boxEl.createEl("input", { type: "text", cls: "agent-sessions-name-input-field" });
	const suggestEl = boxEl.createDiv({ cls: "agent-sessions-name-suggest" });
	suggestEl.style.display = "none";

	let category = initial.category.trim();
	let chipEl: HTMLElement | null = null;
	let suggestItems: string[] = [];
	let suggestEls: HTMLElement[] = [];
	let highlighted = -1;

	function renderChip(): void {
		chipEl?.remove();
		chipEl = null;
		if (category) {
			chipEl = renderCategoryChip(boxEl, category, colorIndexFor(category));
			boxEl.insertBefore(chipEl, inputEl);
			chipEl.addEventListener("click", () => revertChip());
		}
	}

	/** チップをテキストへ戻し、また編集できるようにする（Backspace・クリック共通）。 */
	function revertChip(): void {
		if (!category) {
			return;
		}
		const restored = category;
		category = "";
		inputEl.value = restored;
		renderChip();
		inputEl.focus();
		inputEl.setSelectionRange(restored.length, restored.length);
		openSuggestFor(restored);
	}

	function closeSuggest(): void {
		suggestEl.empty();
		suggestEl.style.display = "none";
		suggestItems = [];
		suggestEls = [];
		highlighted = -1;
	}

	function applyHighlight(): void {
		suggestEls.forEach((el, i) => el.toggleClass("is-active", i === highlighted));
	}

	function moveHighlight(delta: number): void {
		if (suggestItems.length === 0) {
			return;
		}
		highlighted = (highlighted + delta + suggestItems.length) % suggestItems.length;
		applyHighlight();
	}

	function openSuggestFor(query: string): void {
		const items = filterCategories(categories, query);
		suggestItems = items;
		suggestEls = [];
		suggestEl.empty();
		if (items.length === 0) {
			suggestEl.style.display = "none";
			highlighted = -1;
			return;
		}
		suggestEl.style.display = "";
		for (const cat of items) {
			const itemEl = suggestEl.createDiv({ cls: "agent-sessions-name-suggest-item" });
			renderCategoryChip(itemEl, cat, colorIndexFor(cat));
			itemEl.createSpan({ cls: "agent-sessions-name-suggest-item-label", text: cat });
			// mousedown（click ではなく）: 先に効かせないと、input の blur が先に起きて
			// 候補が閉じてしまう（実機修正）。
			itemEl.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				confirmCategory(cat);
			});
			itemEl.addEventListener("mouseenter", () => {
				highlighted = suggestEls.indexOf(itemEl);
				applyHighlight();
			});
			suggestEls.push(itemEl);
		}
		highlighted = 0;
		applyHighlight();
	}

	/** 候補から確定（クリック・Enter／Tab）：認識したそのタイミングで入力欄は空にする
	 * （T-70 追補：入力した文字がそのまま残ると挙動が分かりにくい、との指摘）。 */
	function confirmCategory(cat: string): void {
		category = cat;
		inputEl.value = "";
		closeSuggest();
		renderChip();
		inputEl.focus();
	}

	inputEl.addEventListener("input", () => {
		if (category) {
			return;
		}
		const token = tokenizeNameInput(inputEl.value);
		if (token) {
			// `:` の確定・`：`＋空白のどちらも同じ規則（`tokenizeNameInput`）で判定する。
			// 貼り付けで「カテゴリ: 名前」が一括で入っても同じ `input` イベントを通るので、
			// 経路によらず認識した瞬間にカテゴリ・区切り文字を rest から取り除く
			// （T-70 追補：入力した文字がそのまま残ると挙動が分かりにくい、との指摘）。
			category = token.category;
			inputEl.value = token.rest;
			closeSuggest();
			renderChip();
			return;
		}
		openSuggestFor(inputEl.value);
	});

	inputEl.addEventListener("keydown", (evt) => {
		if (!category && suggestItems.length > 0) {
			if (evt.key === "ArrowDown") {
				evt.preventDefault();
				moveHighlight(1);
				return;
			}
			if (evt.key === "ArrowUp") {
				evt.preventDefault();
				moveHighlight(-1);
				return;
			}
			if ((evt.key === "Enter" || evt.key === "Tab") && highlighted >= 0) {
				evt.preventDefault();
				confirmCategory(suggestItems[highlighted]);
				return;
			}
			if (evt.key === "Escape") {
				evt.preventDefault();
				closeSuggest();
				return;
			}
		}
		if (
			evt.key === "Backspace" &&
			category &&
			inputEl.value === "" &&
			inputEl.selectionStart === 0 &&
			inputEl.selectionEnd === 0
		) {
			evt.preventDefault();
			revertChip();
			return;
		}
		if (evt.key === "Enter") {
			// 確定はダイアログのボタンだけ（候補選択中の Enter は候補の確定。上で処理済み）。
			evt.preventDefault();
		}
	});

	inputEl.addEventListener("blur", () => {
		window.setTimeout(() => closeSuggest(), 0);
	});

	inputEl.value = initial.name;
	renderChip();

	return {
		getValue: () => ({ category, name: inputEl.value }),
		focus: () => inputEl.focus(),
	};
}

/** 新規セッション：カテゴリ・名前を 1 つの入力欄で入れ、「開始」で確定する。 */
export class NewSessionModal extends Modal {
	private field!: ComposedNameField;

	constructor(
		private plugin: AgentSessionsPlugin,
		private onSubmit: (name: string) => void
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.setTitle(t("modal.newSession.title"));
		this.field = buildComposedNameField(
			this.contentEl,
			this.plugin.index.categories(),
			(category) => this.plugin.index.categoryColorIndex(category),
			{ category: "", name: "" }
		);
		new Setting(this.contentEl).addButton((button) =>
			button
				.setButtonText(t("action.start"))
				.setCta()
				.onClick(() => this.submit())
		);
		window.setTimeout(() => this.field.focus(), 0);
	}

	private submit(): void {
		const { category, name } = this.field.getValue();
		this.onSubmit(composeName(category, name));
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * 名前を変更（§6.6・D-42・D-63・T-70）：いまの名前を `splitName` でカテゴリ・名前に分け、
 * 1 つの入力欄へチップ＋テキストで入れる。「変更」「キャンセル」のボタンだけで確定する
 * （Enter では確定しない）。
 */
export class RenameSessionModal extends Modal {
	private field!: ComposedNameField;

	constructor(
		private plugin: AgentSessionsPlugin,
		private currentName: string,
		private onSubmit: (name: string) => void
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.setTitle(t("modal.renameSession.title"));
		this.modalEl.addClass("agent-sessions-rename-modal");
		const [category, name] = splitName(this.currentName);
		this.field = buildComposedNameField(
			this.contentEl,
			this.plugin.index.categories(),
			(c) => this.plugin.index.categoryColorIndex(c),
			{ category: category ?? "", name }
		);
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(t("action.cancel")).onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(t("action.change"))
					.setCta()
					.onClick(() => this.submit())
			);
		window.setTimeout(() => {
			this.field.focus();
		}, 0);
	}

	private submit(): void {
		const { category, name } = this.field.getValue();
		const value = composeName(category, name);
		if (value) {
			this.onSubmit(value);
		}
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 確認して実行する（セッションを終了、など）。 */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private message: string,
		private confirmLabel: string,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(t("action.cancel")).onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(this.confirmLabel)
					.setWarning()
					.onClick(() => {
						this.onConfirm();
						this.close();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

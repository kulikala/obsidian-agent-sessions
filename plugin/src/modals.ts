// 新規セッション・名前を変更・確認のダイアログ（§6.6・§6.12・D-63）。

import { AbstractInputSuggest, App, Modal, Setting, TextComponent } from "obsidian";
import { t } from "./i18n";
import { composeName } from "./name";
import { splitName } from "./tree";

/** カテゴリ欄の入力候補（既存カテゴリ＋自由入力。§6.6・D-63）。 */
class CategorySuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private categories: string[]
	) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): string[] {
		const q = query.trim().toLowerCase();
		if (!q) {
			return this.categories;
		}
		return this.categories.filter((c) => c.toLowerCase().includes(q));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}
}

/**
 * 「カテゴリ」「名前」2 欄＋プレビュー 1 行を組み立てる（新規セッション・名前を変更で共用）。
 * カテゴリ欄には既存カテゴリの候補を出す。確定はボタンだけ（Enter では確定しない）。
 */
function buildNameFields(
	app: App,
	contentEl: HTMLElement,
	categories: string[],
	initial: { category: string; name: string }
): { getCategory: () => string; getName: () => string; focus: () => void } {
	let categoryComponent!: TextComponent;
	let nameComponent!: TextComponent;
	let updatePreview: () => void = () => undefined;

	new Setting(contentEl).setName(t("dialog.category")).addText((text) => {
		categoryComponent = text;
		text.setValue(initial.category);
		text.inputEl.addEventListener("input", () => updatePreview());
		new CategorySuggest(app, text.inputEl, categories).onSelect(() => updatePreview());
	});
	new Setting(contentEl).setName(t("modal.newSession.nameField")).addText((text) => {
		nameComponent = text;
		text.setValue(initial.name);
		text.inputEl.addEventListener("input", () => updatePreview());
	});

	const previewEl = contentEl.createDiv({ cls: "agent-sessions-name-preview" });
	updatePreview = (): void => {
		const composed = composeName(categoryComponent.getValue(), nameComponent.getValue());
		previewEl.setText(t("dialog.preview", { name: composed || t("common.none") }));
	};
	updatePreview();

	return {
		getCategory: () => categoryComponent.getValue(),
		getName: () => nameComponent.getValue(),
		focus: () => nameComponent.inputEl.focus(),
	};
}

/** 新規セッション：「カテゴリ」「名前」の 2 欄＋プレビューと「開始」。確定はボタンだけ。 */
export class NewSessionModal extends Modal {
	private fields!: ReturnType<typeof buildNameFields>;

	constructor(
		app: App,
		private categories: string[],
		private onSubmit: (name: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("modal.newSession.title"));
		this.fields = buildNameFields(this.app, this.contentEl, this.categories, { category: "", name: "" });
		new Setting(this.contentEl).addButton((button) =>
			button
				.setButtonText(t("action.start"))
				.setCta()
				.onClick(() => this.submit())
		);
		window.setTimeout(() => this.fields.focus(), 0);
	}

	private submit(): void {
		this.onSubmit(composeName(this.fields.getCategory(), this.fields.getName()));
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * 名前を変更（§6.6・D-42・D-63）：いまの名前を `splitName` で「カテゴリ」「名前」2 欄に分けて入れる。
 * 「変更」「キャンセル」のボタンだけで確定する（Enter では確定しない）。
 */
export class RenameSessionModal extends Modal {
	private fields!: ReturnType<typeof buildNameFields>;

	constructor(
		app: App,
		private categories: string[],
		private currentName: string,
		private onSubmit: (name: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("modal.renameSession.title"));
		this.modalEl.addClass("agent-sessions-rename-modal");
		const [category, name] = splitName(this.currentName);
		this.fields = buildNameFields(this.app, this.contentEl, this.categories, { category: category ?? "", name });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(t("action.cancel")).onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(t("action.change"))
					.setCta()
					.onClick(() => this.submit())
			);
		window.setTimeout(() => {
			this.fields.focus();
		}, 0);
	}

	private submit(): void {
		const value = composeName(this.fields.getCategory(), this.fields.getName());
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

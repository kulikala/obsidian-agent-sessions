// The new-session, rename, and confirmation dialogs.

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
 * Presents category and name as a single input field: an input-styled box (a div) holds
 * `[category chip, if any][<input>]` side by side. Typing "Category: " into the `<input>`
 * (detected by `tokenizeNameInput`) turns the part before it into a chip, and typing continues
 * into what's left (the name). Backspace with an empty name, or clicking the chip, turns the
 * chip back into editable text. While typing a category (before it becomes a chip), shows
 * suggestions from existing categories (confirm with arrow keys + Enter/Tab, or a click).
 * Confirming the whole field only happens via the dialog's own button (Enter in this field
 * doesn't confirm it — Enter while a suggestion is highlighted confirms the suggestion instead).
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

	/** Turns the chip back into text so it can be edited again (shared by Backspace and click). */
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
			// mousedown rather than click: needs to fire first, otherwise the input's blur fires
			// first and closes the suggestions before the click registers.
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

	/** Confirming a suggestion (click, Enter, or Tab): clears the input field right when it's
	 * recognized, so leftover typed characters don't make the behavior confusing. */
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
			// A half-width `:` and a full-width `：` plus whitespace are both recognized by the
			// same rule (`tokenizeNameInput`). Pasting "Category: Name" in one go still goes
			// through this same `input` event, so regardless of how it arrived, the category and
			// separator are stripped out of `rest` the moment they're recognized — leaving typed
			// characters in place would make the behavior confusing.
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
			// Only the dialog's own button confirms the field (Enter while a suggestion is highlighted confirms the suggestion instead, handled above).
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

/** New session: enter category and name in one field, confirmed by "Start". */
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
 * Rename: splits the current name into category and name with `splitName`, and loads them into
 * one field as a chip plus text. Only the "Rename"/"Cancel" buttons confirm it (Enter doesn't).
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

/** Confirm-then-run (e.g. ending a session). */
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

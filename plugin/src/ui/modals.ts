// The new-session, rename, move-to-category, and confirmation dialogs.

import { App, Modal, Setting, setIcon } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { renderCategoryChip } from "./chip";
import { AGENT_ICON_ID } from "./icons";
import { t, type MessageKey } from "../i18n";
import { composeName, filterCategories, tokenizeNameInput } from "../sessions/name";
import { AGENT_IDS, type AgentId } from "../settings";
import { splitName } from "../sessions/tree";
import { computeSuggestPosition } from "./suggest-position";

const AGENT_NAME_KEY: Record<AgentId, MessageKey> = {
	claude: "settings.agents.claude.name",
	codex: "settings.agents.codex.name",
};

/** Gives a `Setting`'s control the dialog's full width instead of Obsidian's default
 * shrink-to-fit, right-aligned control column (`agent-sessions-wide-setting`, T-102) — every
 * text-input field in these dialogs uses this, not just the small controls (toggles, dropdowns)
 * `Setting` is normally used for. */
function makeWide(setting: Setting): Setting {
	setting.settingEl.addClass("agent-sessions-wide-setting");
	return setting;
}

interface CategorySuggest {
	/** Opens/refreshes the dropdown for `query` (`filterCategories`). Closes it if nothing matches. */
	openFor(query: string): void;
	close(): void;
	isOpen(): boolean;
	/** No-op when closed. */
	moveHighlight(delta: number): void;
	/** Confirms the highlighted item (calls `onConfirm`), if any. Returns whether it did. */
	confirmHighlighted(): boolean;
	/** Removes the dropdown element from `<body>` — required because it's portaled there rather
	 * than living under `anchorEl` (T-104(e)), so it isn't cleaned up automatically when the
	 * modal's own `contentEl` is emptied on close. Every caller's `onClose` must call this. */
	destroy(): void;
}

/**
 * The category-suggestion dropdown: positioned against `anchorEl`'s on-screen location (T-104(e)
 * — see `styles.css`'s `.agent-sessions-name-suggest` comment for why it's portaled to `<body>`
 * rather than rendered as a normal descendant) as chip + label rows from `filterCategories`,
 * arrow-key/mouse highlighting, and click-or-Enter confirmation via `onConfirm`. Shared by the
 * composed name field (`buildComposedNameField`) and `MoveToCategoryModal` — the two callers
 * differ only in what `onConfirm` does with the result (both now turn it into a chip).
 */
function buildCategorySuggest(
	anchorEl: HTMLElement,
	categories: string[],
	colorIndexFor: (category: string) => number,
	onConfirm: (category: string) => void
): CategorySuggest {
	const suggestEl = document.body.createDiv({ cls: "agent-sessions-name-suggest" });
	suggestEl.style.display = "none";
	let items: string[] = [];
	let itemEls: HTMLElement[] = [];
	let highlighted = -1;

	function applyHighlight(): void {
		itemEls.forEach((el, i) => el.toggleClass("is-active", i === highlighted));
	}

	function position(): void {
		const anchorRect = anchorEl.getBoundingClientRect();
		const maxHeight = parseFloat(getComputedStyle(suggestEl).maxHeight) || 0;
		const pos = computeSuggestPosition(anchorRect, window.innerHeight, maxHeight);
		suggestEl.style.left = `${pos.left}px`;
		suggestEl.style.width = `${pos.width}px`;
		suggestEl.style.top = pos.top != null ? `${pos.top}px` : "";
		suggestEl.style.bottom = pos.bottom != null ? `${pos.bottom}px` : "";
	}

	return {
		openFor(query) {
			items = filterCategories(categories, query);
			itemEls = [];
			suggestEl.empty();
			if (items.length === 0) {
				suggestEl.style.display = "none";
				highlighted = -1;
				return;
			}
			position();
			suggestEl.style.display = "";
			for (const cat of items) {
				const itemEl = suggestEl.createDiv({ cls: "agent-sessions-name-suggest-item" });
				renderCategoryChip(itemEl, cat, colorIndexFor(cat));
				itemEl.createSpan({ cls: "agent-sessions-name-suggest-item-label", text: cat });
				// mousedown rather than click: needs to fire first, otherwise the input's blur
				// fires first and closes the suggestions before the click registers.
				itemEl.addEventListener("mousedown", (evt) => {
					evt.preventDefault();
					onConfirm(cat);
				});
				itemEl.addEventListener("mouseenter", () => {
					highlighted = itemEls.indexOf(itemEl);
					applyHighlight();
				});
				itemEls.push(itemEl);
			}
			highlighted = 0;
			applyHighlight();
		},
		close() {
			suggestEl.empty();
			suggestEl.style.display = "none";
			items = [];
			itemEls = [];
			highlighted = -1;
		},
		isOpen: () => items.length > 0,
		moveHighlight(delta) {
			if (items.length === 0) {
				return;
			}
			highlighted = (highlighted + delta + items.length) % items.length;
			applyHighlight();
		},
		confirmHighlighted() {
			if (highlighted < 0 || highlighted >= items.length) {
				return false;
			}
			onConfirm(items[highlighted]);
			return true;
		},
		destroy() {
			suggestEl.remove();
		},
	};
}

/** A small "×" appended to a category chip (T-104(e)) — shared by the composed name field's chip
 * and `MoveToCategoryModal`'s, so both dialogs remove a chip the same way. Its own click handler
 * stops propagation so it doesn't also trigger the chip's own click-to-revert-to-text. */
function appendChipRemove(chip: HTMLElement, onRemove: () => void): void {
	const removeEl = chip.createSpan({ cls: "agent-sessions-name-chip-remove", text: "×" });
	removeEl.addEventListener("click", (evt) => {
		evt.stopPropagation();
		onRemove();
	});
}

interface ComposedNameField {
	getValue(): { category: string; name: string };
	focus(): void;
	/** Removes the (portaled — T-104(e)) suggestion dropdown. The caller's `onClose` must call this. */
	destroy(): void;
}

/**
 * Presents category and name as a single input field: an input-styled box (a div) holds
 * `[category chip, if any][<input>]` side by side. Typing "Category: " into the `<input>`
 * (detected by `tokenizeNameInput`) turns the part before it into a chip, and typing continues
 * into what's left (the name). Backspace with an empty name, or clicking the chip, turns the
 * chip back into editable text. While typing a category (before it becomes a chip), shows
 * suggestions from existing categories (`buildCategorySuggest` — confirm with arrow keys +
 * Enter/Tab, or a click). Confirming the whole field only happens via the dialog's own button
 * (Enter in this field doesn't confirm it — Enter while a suggestion is highlighted confirms the
 * suggestion instead).
 */
function buildComposedNameField(
	contentEl: HTMLElement,
	categories: string[],
	colorIndexFor: (category: string) => number,
	initial: { category: string; name: string }
): ComposedNameField {
	const setting = makeWide(new Setting(contentEl).setName(t("modal.newSession.nameField")));
	const boxEl = setting.controlEl.createDiv({ cls: "agent-sessions-name-input" });
	const inputEl = boxEl.createEl("input", { type: "text", cls: "agent-sessions-name-input-field" });

	let category = initial.category.trim();
	let chipEl: HTMLElement | null = null;

	function renderChip(): void {
		chipEl?.remove();
		chipEl = null;
		if (category) {
			chipEl = renderCategoryChip(boxEl, category, colorIndexFor(category));
			boxEl.insertBefore(chipEl, inputEl);
			chipEl.addEventListener("click", () => revertChip());
			appendChipRemove(chipEl, () => clearCategory());
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
		suggest.openFor(restored);
	}

	/** The chip's "×" (T-104(e)): clears the category outright, leaving the input empty — unlike
	 * `revertChip`, which puts the category's text back for editing. */
	function clearCategory(): void {
		category = "";
		renderChip();
		inputEl.focus();
	}

	/** Confirming a suggestion (click, Enter, or Tab): clears the input field right when it's
	 * recognized, so leftover typed characters don't make the behavior confusing. */
	function confirmCategory(cat: string): void {
		category = cat;
		inputEl.value = "";
		suggest.close();
		renderChip();
		inputEl.focus();
	}

	const suggest = buildCategorySuggest(boxEl, categories, colorIndexFor, confirmCategory);

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
			suggest.close();
			renderChip();
			return;
		}
		suggest.openFor(inputEl.value);
	});

	inputEl.addEventListener("keydown", (evt) => {
		if (!category && suggest.isOpen()) {
			if (evt.key === "ArrowDown") {
				evt.preventDefault();
				suggest.moveHighlight(1);
				return;
			}
			if (evt.key === "ArrowUp") {
				evt.preventDefault();
				suggest.moveHighlight(-1);
				return;
			}
			if (evt.key === "Enter" || evt.key === "Tab") {
				evt.preventDefault();
				suggest.confirmHighlighted();
				return;
			}
			if (evt.key === "Escape") {
				evt.preventDefault();
				suggest.close();
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
		window.setTimeout(() => suggest.close(), 0);
	});

	inputEl.value = initial.name;
	renderChip();

	return {
		getValue: () => ({ category, name: inputEl.value }),
		focus: () => inputEl.focus(),
		destroy: () => suggest.destroy(),
	};
}

/**
 * New session: enter category and name in one field, confirmed by "Start". If more than one
 * agent is enabled, also picks which one to launch (defaulting to `settings.lastNewSessionAgent`
 * — the choice remembered from last time); with only one enabled, the picker is skipped entirely
 * and that one is used, matching it being the only meaningful choice.
 */
export class NewSessionModal extends Modal {
	private field!: ComposedNameField;
	private agent: AgentId;
	private readonly enabledAgents: AgentId[];

	constructor(
		private plugin: AgentSessionsPlugin,
		private onSubmit: (name: string, agent: AgentId) => void
	) {
		super(plugin.app);
		this.enabledAgents = AGENT_IDS.filter((id) => plugin.settings.agents[id].enabled);
		const last = plugin.settings.lastNewSessionAgent;
		this.agent = this.enabledAgents.includes(last) ? last : (this.enabledAgents[0] ?? "claude");
	}

	onOpen(): void {
		this.setTitle(t("modal.newSession.title"));
		if (this.enabledAgents.length > 1) {
			const setting = new Setting(this.contentEl).setName(t("modal.newSession.agentField"));
			const pickerEl = setting.controlEl.createDiv({ cls: "agent-sessions-agent-picker" });
			const buttons = new Map<AgentId, HTMLElement>();
			const select = (id: AgentId) => {
				this.agent = id;
				for (const [otherId, el] of buttons) {
					el.toggleClass("is-active", otherId === id);
				}
			};
			for (const id of this.enabledAgents) {
				const btn = pickerEl.createEl("button", { cls: "agent-sessions-agent-picker-btn", type: "button" });
				const icon = AGENT_ICON_ID[id];
				if (icon) {
					setIcon(btn.createSpan({ cls: "agent-sessions-agent-picker-icon" }), icon);
				}
				btn.createSpan({ text: t(AGENT_NAME_KEY[id]) });
				btn.addEventListener("click", () => select(id));
				buttons.set(id, btn);
			}
			select(this.agent);
		}
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
		this.onSubmit(composeName(category, name), this.agent);
		this.close();
	}

	onClose(): void {
		this.field.destroy();
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
		this.field.destroy();
		this.contentEl.empty();
	}
}

/**
 * Move to category: a single input for the category only — the session's own label (the part
 * after "Category: ", or the row's auto-derived label if it hasn't been named yet —
 * `categorizableLabel`) is kept as-is and never shown for editing here (use "Rename" for that).
 * Confirming with an empty category removes it, leaving just the label. Same suggestion dropdown
 * as the composed name field (`buildCategorySuggest`), opened on focus or click (not only while
 * typing, since there's no chip-vs-typing state to gate it on here) and narrowed as you type.
 * Enter with nothing highlighted just confirms the field's current, possibly freehand, text as a
 * new category. The caller (`rows.ts`'s `RowActions.moveToCategory`) is expected not to open this
 * at all when `categorizableLabel(row)` is empty — there's nothing to attach a category to yet.
 */
export class MoveToCategoryModal extends Modal {
	private inputEl!: HTMLInputElement;
	private suggest!: CategorySuggest;
	/** The confirmed category, shown as a chip (T-104(e) — same pattern as the composed name
	 * field's, including the removable "×"). Starts already chipped from `currentCategory` if
	 * there is one, since an existing category is itself already "confirmed". While this is set,
	 * the input holds nothing meaningful (mirrors `buildComposedNameField`'s chip/text split). */
	private category: string;
	private chipEl: HTMLElement | null = null;
	private boxEl!: HTMLElement;

	constructor(
		private plugin: AgentSessionsPlugin,
		private currentCategory: string,
		private label: string,
		private onSubmit: (name: string) => void
	) {
		super(plugin.app);
		this.category = currentCategory.trim();
	}

	onOpen(): void {
		this.setTitle(t("modal.moveToCategory.title"));
		const setting = makeWide(new Setting(this.contentEl).setName(t("modal.moveToCategory.categoryField")));
		const boxEl = setting.controlEl.createDiv({ cls: "agent-sessions-name-input" });
		this.boxEl = boxEl;
		const inputEl = boxEl.createEl("input", { type: "text", cls: "agent-sessions-name-input-field" });
		this.inputEl = inputEl;

		const categories = this.plugin.index.categories();
		const colorIndexFor = (c: string) => this.plugin.index.categoryColorIndex(c);
		const suggest = buildCategorySuggest(boxEl, categories, colorIndexFor, (cat) => this.confirmCategory(cat));
		this.suggest = suggest;
		this.renderChip();

		inputEl.addEventListener("focus", () => suggest.openFor(inputEl.value));
		inputEl.addEventListener("click", () => suggest.openFor(inputEl.value));
		inputEl.addEventListener("input", () => suggest.openFor(inputEl.value));
		inputEl.addEventListener("keydown", (evt) => {
			if (suggest.isOpen()) {
				if (evt.key === "ArrowDown") {
					evt.preventDefault();
					suggest.moveHighlight(1);
					return;
				}
				if (evt.key === "ArrowUp") {
					evt.preventDefault();
					suggest.moveHighlight(-1);
					return;
				}
				if (evt.key === "Escape") {
					evt.preventDefault();
					suggest.close();
					return;
				}
			}
			if (
				evt.key === "Backspace" &&
				this.category &&
				inputEl.value === "" &&
				inputEl.selectionStart === 0 &&
				inputEl.selectionEnd === 0
			) {
				evt.preventDefault();
				this.revertChip();
				return;
			}
			if (evt.key === "Enter") {
				evt.preventDefault();
				if (suggest.isOpen() && suggest.confirmHighlighted()) {
					return;
				}
				this.submit();
			}
		});
		inputEl.addEventListener("blur", () => {
			window.setTimeout(() => suggest.close(), 0);
		});

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(t("action.cancel")).onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(t("action.move"))
					.setCta()
					.onClick(() => this.submit())
			);
		window.setTimeout(() => inputEl.focus(), 0);
	}

	private renderChip(): void {
		this.chipEl?.remove();
		this.chipEl = null;
		if (this.category) {
			const chip = renderCategoryChip(this.boxEl, this.category, this.plugin.index.categoryColorIndex(this.category));
			this.boxEl.insertBefore(chip, this.inputEl);
			chip.addEventListener("click", () => this.revertChip());
			appendChipRemove(chip, () => this.clearCategory());
			this.chipEl = chip;
		}
	}

	/** Turns the chip back into text so it can be edited again (shared by Backspace and click). */
	private revertChip(): void {
		if (!this.category) {
			return;
		}
		const restored = this.category;
		this.category = "";
		this.inputEl.value = restored;
		this.renderChip();
		this.inputEl.focus();
		this.inputEl.setSelectionRange(restored.length, restored.length);
		this.suggest.openFor(restored);
	}

	/** The chip's "×": clears the category outright rather than restoring it for editing. */
	private clearCategory(): void {
		this.category = "";
		this.renderChip();
		this.inputEl.focus();
	}

	private confirmCategory(cat: string): void {
		this.category = cat;
		this.inputEl.value = "";
		this.suggest.close();
		this.renderChip();
		this.inputEl.focus();
	}

	/** The category to submit: whatever's currently typed, if anything (freehand text the user
	 * hasn't turned into a chip yet — including new text typed after a chip already exists, so
	 * typing over an existing category and hitting "Move" directly still works) — otherwise the
	 * confirmed chip. */
	private resolvedCategory(): string {
		const typed = this.inputEl.value.trim();
		return typed || this.category;
	}

	private submit(): void {
		const value = composeName(this.resolvedCategory(), this.label);
		if (value) {
			this.onSubmit(value);
		}
		this.close();
	}

	onClose(): void {
		this.suggest.destroy();
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

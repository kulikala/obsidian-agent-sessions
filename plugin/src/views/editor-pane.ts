// The editor pane: a `<textarea>` plus a one-line bar and `@` suggestions, placed below the
// terminal view. Relies on native paste, IME, and undo; does no Markdown handling of its own.
//
// Writes to the temp file go tmp→rename. Send = writes the final content (submitting the
// prompt is continued by main.ts). Back to prompt (Esc) = writes the current content. Cancel
// (the tab closed) = writes the original content back. Abort (claude's side disconnected) =
// closes without writing.

import * as fs from "node:fs";
import * as path from "node:path";
import { prepareFuzzySearch, type App, type TFile } from "obsidian";
import { applyCompletion, findAtQuery, relPathFor, type AtQuery } from "../terminal/at-complete";
import { SaveDebouncer } from "../terminal/autosave";
import { t } from "../i18n";
import { classifyEnter, submitKeyButtonLabel } from "../terminal/keys";
import type { SubmitKey } from "../settings";

export type EditResult = "send" | "return" | "cancel";

export interface EditorPaneDeps {
	app: App;
	vaultPath: string;
	fontFamily: string;
	fontSize: number;
	/** The submit key. Pressing it sends; any other Enter combination inserts a newline. */
	submitKey: SubmitKey;
	/** How to label "send": macOS gets a symbol, non-macOS gets spelled-out text. */
	isMac: boolean;
}

/** How long to wait after input settles before writing to the temp file. Held by `SaveDebouncer`. */
const AUTOSAVE_MS = 800;
const MAX_CANDIDATES = 8;

/** Writes to tmp, then renames. The tmp file is placed in the same directory as `file`. */
function writeAtomic(file: string, text: string): void {
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
	fs.writeFileSync(tmp, text, "utf8");
	try {
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// no-op
		}
		throw err;
	}
}

export class EditorPane {
	private textarea: HTMLTextAreaElement | null = null;
	private listEl: HTMLElement | null = null;
	/** Autosave debounce (`schedule` extends it on every keystroke, `flush` writes immediately on commit). */
	private saveDebouncer = new SaveDebouncer(AUTOSAVE_MS, () => this.writeCurrent());
	private resolve: ((result: EditResult) => void) | null = null;
	private file = "";
	private cwd = "";
	private original = "";
	private lastSaved = "";
	private at: AtQuery | null = null;
	private candidates: TFile[] = [];
	private selected = 0;
	/** Key handling captured on `window` (runs before Obsidian's own keydown handling). */
	private captureKeyDown = (ev: KeyboardEvent): void => {
		if (ev.target === this.textarea) {
			this.onKeyDown(ev);
		}
	};

	constructor(
		private containerEl: HTMLElement,
		private deps: EditorPaneDeps
	) {}

	get isOpen(): boolean {
		return this.resolve !== null;
	}

	/**
	 * Keeps the open editor's font in step with settings changes. The `deps.fontFamily`/
	 * `fontSize` passed to `open()` are frozen at that point in time, so `terminal.ts`'s
	 * `applySettings()` calls this (on every `settings-changed`) to keep them current.
	 */
	applySettings(fontFamily: string, fontSize: number): void {
		this.deps.fontFamily = fontFamily;
		this.deps.fontSize = fontSize;
		if (this.textarea) {
			this.textarea.style.fontFamily = fontFamily;
			this.textarea.style.fontSize = `${fontSize}px`;
		}
	}

	/** Builds the pane, fills in `initial`, and focuses it. Resolves on send/back to prompt/cancel/abort. */
	open(file: string, cwd: string, initial: string): Promise<EditResult> {
		this.file = file;
		this.cwd = cwd;
		this.original = initial;
		this.lastSaved = initial;
		this.build();
		const textarea = this.textarea as HTMLTextAreaElement;
		textarea.value = initial;
		textarea.focus();
		textarea.setSelectionRange(initial.length, initial.length);
		textarea.scrollTop = textarea.scrollHeight;
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	/** Send: cancels any pending autosave and writes the final content right away, then closes. */
	send(): void {
		if (!this.resolve) {
			return;
		}
		this.saveDebouncer.flush();
		this.finish("send");
	}

	/** Back to prompt: cancels any pending autosave and writes the current content right away, then closes (doesn't submit). */
	returnToInput(): void {
		if (!this.resolve) {
			return;
		}
		this.saveDebouncer.flush();
		this.finish("return");
	}

	/** Cancel (the tab closed): drops any pending autosave, writes the original content back, then closes. */
	cancel(): void {
		if (!this.resolve) {
			return;
		}
		this.saveDebouncer.cancel();
		this.write(this.original);
		this.finish("cancel");
	}

	/** Abort (the other side disconnected): drops any pending autosave and closes without writing. */
	abort(): void {
		if (!this.resolve) {
			return;
		}
		this.saveDebouncer.cancel();
		this.finish("cancel");
	}

	private finish(result: EditResult): void {
		const resolve = this.resolve;
		this.resolve = null;
		this.teardown();
		resolve?.(result);
	}

	// ---- DOM ---------------------------------------------------------------------

	private build(): void {
		const root = this.containerEl;
		root.empty();
		root.addClass("agent-sessions-editor");

		const bar = root.createDiv({ cls: "agent-sessions-editor-bar" });
		bar.createSpan({ cls: "agent-sessions-editor-file", text: path.basename(this.file) });
		const send = bar.createEl("button", {
			text: t("action.send", { key: submitKeyButtonLabel(this.deps.submitKey, this.deps.isMac) }),
			cls: "mod-cta",
		});
		const back = bar.createEl("button", { text: t("action.backToInput") });
		send.addEventListener("click", () => this.send());
		back.addEventListener("click", () => this.returnToInput());

		const textarea = root.createEl("textarea", { cls: "agent-sessions-editor-text" });
		textarea.spellcheck = false;
		textarea.style.fontFamily = this.deps.fontFamily;
		textarea.style.fontSize = `${this.deps.fontSize}px`;
		window.addEventListener("keydown", this.captureKeyDown, true);
		textarea.addEventListener("keyup", (ev) => {
			if (ev.key === "Escape") {
				ev.stopPropagation();
			}
		});
		textarea.addEventListener("input", (ev) => {
			if ((ev as InputEvent).isComposing) {
				return;
			}
			this.onChanged();
		});
		textarea.addEventListener("compositionend", () => this.onChanged());
		textarea.addEventListener("blur", () => this.closeSuggestions());
		this.textarea = textarea;

		this.listEl = root.createDiv({ cls: "agent-sessions-suggest" });
		this.listEl.hide();
	}

	private teardown(): void {
		window.removeEventListener("keydown", this.captureKeyDown, true);
		this.closeSuggestions();
		this.textarea = null;
		this.listEl = null;
		this.containerEl.empty();
		this.containerEl.removeClass("agent-sessions-editor");
	}

	// ---- Saving -------------------------------------------------------------------

	private onChanged(): void {
		this.saveDebouncer.schedule();
		this.updateSuggestions();
	}

	private writeCurrent(): void {
		if (!this.textarea) {
			return;
		}
		this.write(this.textarea.value);
	}

	/**
	 * Write failures (read-only disk, no permission, etc.) are logged rather than shown as a
	 * `Notice` (keeps the pre-existing behavior). Autosave can run as often as every 800ms, so
	 * popping a notice on every failure could interrupt typing repeatedly. `send`/
	 * `returnToInput`'s final writes go through this same `write()`, so they too can fail
	 * silently — that's pre-existing behavior from before autosave was added and out of scope
	 * here; surfacing it would need a separate design decision to treat the final write's
	 * failure differently.
	 */
	private write(text: string): void {
		if (text === this.lastSaved) {
			return;
		}
		try {
			writeAtomic(this.file, text);
			this.lastSaved = text;
		} catch (err) {
			console.warn("agent-sessions: couldn't write the temp file", err);
		}
	}

	// ---- Keys -------------------------------------------------------------------

	/**
	 * The submit key sends; any other Enter combination inserts a newline; `Esc` goes back to
	 * the prompt (closing suggestions first if they're open). While suggestions are open,
	 * unmodified Enter/Tab confirms the selection and ↑/↓ moves it. Does nothing during an IME
	 * composition (`isComposing`/`keyCode 229`). Every other key is left to the textarea's
	 * native behavior, with only propagation stopped so it doesn't reach Obsidian's hotkeys
	 * (Cmd+V/C/X/Z/A keep their default behavior).
	 */
	private onKeyDown(ev: KeyboardEvent): void {
		ev.stopImmediatePropagation();
		if (ev.isComposing || ev.keyCode === 229) {
			return;
		}
		if (this.candidates.length > 0) {
			if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
				ev.preventDefault();
				const delta = ev.key === "ArrowDown" ? 1 : -1;
				this.selected = (this.selected + delta + this.candidates.length) % this.candidates.length;
				this.renderSuggestions();
				return;
			}
			if ((ev.key === "Enter" || ev.key === "Tab") && !ev.shiftKey && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
				ev.preventDefault();
				this.confirmSuggestion(this.candidates[this.selected]);
				return;
			}
			if (ev.key === "Escape") {
				ev.preventDefault();
				this.closeSuggestions();
				return;
			}
		}
		const cls = classifyEnter(ev);
		if (cls === this.deps.submitKey) {
			ev.preventDefault();
			this.send();
			return;
		}
		if (cls !== "passthrough" && cls !== "enter") {
			// Some modified Enter combinations don't natively insert a newline, so do it ourselves.
			ev.preventDefault();
			this.insertNewline();
			return;
		}
		if (ev.key === "Escape") {
			ev.preventDefault();
			this.returnToInput();
		}
	}

	/** Inserts a newline at the cursor. Using `insertText` keeps it in the undo history. */
	private insertNewline(): void {
		const textarea = this.textarea;
		if (!textarea) {
			return;
		}
		if (!document.execCommand("insertText", false, "\n")) {
			textarea.setRangeText("\n", textarea.selectionStart, textarea.selectionEnd, "end");
			this.onChanged();
		}
	}

	// ---- `@` completion -----------------------------------------------------------------

	private updateSuggestions(): void {
		const textarea = this.textarea;
		if (!textarea) {
			return;
		}
		const at = findAtQuery(textarea.value, textarea.selectionStart);
		if (!at) {
			this.closeSuggestions();
			return;
		}
		this.at = at;
		this.candidates = this.search(at.query);
		this.selected = 0;
		this.renderSuggestions();
	}

	private search(query: string): TFile[] {
		const files = this.deps.app.vault.getFiles();
		if (!query) {
			return [...files].sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, MAX_CANDIDATES);
		}
		const match = prepareFuzzySearch(query);
		const q = query.toLowerCase();
		const scored: { file: TFile; score: number; exact: number }[] = [];
		for (const file of files) {
			const result = match(file.path);
			if (result) {
				const base = file.name.toLowerCase();
				const stem = file.basename.toLowerCase();
				scored.push({ file, score: result.score, exact: base === q || stem === q ? 1 : 0 });
			}
		}
		// Sort: score descending → basename matches the query → shorter path → alphabetical.
		scored.sort(
			(a, b) =>
				b.score - a.score ||
				b.exact - a.exact ||
				a.file.path.length - b.file.path.length ||
				a.file.path.localeCompare(b.file.path)
		);
		return scored.slice(0, MAX_CANDIDATES).map((s) => s.file);
	}

	private renderSuggestions(): void {
		const listEl = this.listEl;
		if (!listEl) {
			return;
		}
		listEl.empty();
		if (this.candidates.length === 0) {
			listEl.hide();
			return;
		}
		this.candidates.forEach((file, i) => {
			const item = listEl.createDiv({ cls: "agent-sessions-suggest-item", text: file.path });
			item.toggleClass("is-selected", i === this.selected);
			item.addEventListener("mousedown", (ev) => {
				ev.preventDefault();
				this.confirmSuggestion(file);
			});
		});
		listEl.show();
	}

	private closeSuggestions(): void {
		this.at = null;
		this.candidates = [];
		this.selected = 0;
		if (this.listEl) {
			this.listEl.empty();
			this.listEl.hide();
		}
	}

	private confirmSuggestion(file: TFile | undefined): void {
		const textarea = this.textarea;
		const at = this.at;
		if (!textarea || !at || !file) {
			this.closeSuggestions();
			return;
		}
		const rel = relPathFor(this.deps.vaultPath, file.path, this.cwd);
		const out = applyCompletion(textarea.value, at.start, textarea.selectionStart, rel);
		textarea.value = out.text;
		textarea.setSelectionRange(out.cursor, out.cursor);
		this.closeSuggestions();
		this.saveDebouncer.schedule();
		textarea.focus();
	}
}

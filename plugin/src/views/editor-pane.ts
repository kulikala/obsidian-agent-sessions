// 編集領域（D-22）。ターミナルビューの下に置く `<textarea>` と 1 行のバー、`@` 候補。
// ネイティブのペースト・IME・Undo に任せ、Markdown の扱いは持たない。
//
// 一時ファイルへの書き込みは tmp→rename。送る＝最終内容を書く（送信は main.ts が続ける）。
// 入力欄に戻る（Esc）＝今の内容を書く。取消（タブを閉じた）＝元の内容を書き戻す。
// 中断（claude 側の切断）＝書かずに閉じる（D-51）。

import * as fs from "node:fs";
import * as path from "node:path";
import { prepareFuzzySearch, type App, type TFile } from "obsidian";
import { applyCompletion, findAtQuery, relPathFor, type AtQuery } from "../at-complete";
import { classifyEnter, SUBMIT_KEY_SYMBOLS } from "../keys";
import type { SubmitKey } from "../settings";

export type EditResult = "send" | "return" | "cancel";

export interface EditorPaneDeps {
	app: App;
	vaultPath: string;
	fontFamily: string;
	fontSize: number;
	/** 送信キー（D-50）。これを押すと送る、他の Enter の組合せは改行。 */
	submitKey: SubmitKey;
}

const AUTOSAVE_MS = 300;
const MAX_CANDIDATES = 8;

/** tmp に書いて rename。`file` と同じディレクトリに tmp を置く。 */
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
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private resolve: ((result: EditResult) => void) | null = null;
	private file = "";
	private cwd = "";
	private original = "";
	private lastSaved = "";
	private at: AtQuery | null = null;
	private candidates: TFile[] = [];
	private selected = 0;
	/** window の capture で受けるキー処理（Obsidian の keydown より先に取る）。 */
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

	/** 領域を組み立て、`initial` を入れてフォーカス。送る／入力欄に戻る／取消／中断で解決する。 */
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

	/** 送る：最後の内容を書いてから閉じる。 */
	send(): void {
		if (!this.resolve) {
			return;
		}
		this.clearSaveTimer();
		this.writeCurrent();
		this.finish("send");
	}

	/** 入力欄に戻る：今の内容を書いてから閉じる（送信はしない）。 */
	returnToInput(): void {
		if (!this.resolve) {
			return;
		}
		this.clearSaveTimer();
		this.writeCurrent();
		this.finish("return");
	}

	/** 取消（タブを閉じた）：元の内容を書き戻してから閉じる。 */
	cancel(): void {
		if (!this.resolve) {
			return;
		}
		this.clearSaveTimer();
		this.write(this.original);
		this.finish("cancel");
	}

	/** 中断（相手が消えた）：書かずに閉じる。 */
	abort(): void {
		if (!this.resolve) {
			return;
		}
		this.clearSaveTimer();
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
		const send = bar.createEl("button", { text: `送る（${SUBMIT_KEY_SYMBOLS[this.deps.submitKey]}）`, cls: "mod-cta" });
		const back = bar.createEl("button", { text: "入力欄に戻る（Esc）" });
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

	// ---- 保存 -------------------------------------------------------------------

	private onChanged(): void {
		this.scheduleSave();
		this.updateSuggestions();
	}

	private scheduleSave(): void {
		this.clearSaveTimer();
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.writeCurrent();
		}, AUTOSAVE_MS);
	}

	private clearSaveTimer(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
	}

	private writeCurrent(): void {
		if (!this.textarea) {
			return;
		}
		this.write(this.textarea.value);
	}

	private write(text: string): void {
		if (text === this.lastSaved) {
			return;
		}
		try {
			writeAtomic(this.file, text);
			this.lastSaved = text;
		} catch (err) {
			console.warn("agent-sessions: 一時ファイルに書けない", err);
		}
	}

	// ---- キー -------------------------------------------------------------------

	/**
	 * 送信キー＝送る、他の Enter の組合せ＝改行、`Esc`＝入力欄に戻る（候補が開いていれば候補を閉じる）。
	 * 候補が開いている間の修飾なし Enter／Tab は確定、↑↓は選択。IME 変換中（`isComposing`／
	 * `keyCode 229`）は何もしない。他のキーは textarea のネイティブ動作に任せ、伝播だけ止めて
	 * Obsidian のホットキーに渡さない（Cmd+V／C／X／Z／A は既定動作のまま）。
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
			// 修飾つき Enter はネイティブでは改行にならないものがあるので、自分で入れる。
			ev.preventDefault();
			this.insertNewline();
			return;
		}
		if (ev.key === "Escape") {
			ev.preventDefault();
			this.returnToInput();
		}
	}

	/** カーソル位置に改行を入れる。`insertText` なら Undo の履歴に残る。 */
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

	// ---- `@` 補完 -----------------------------------------------------------------

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
		// スコア降順 → basename が検索語と一致 → パスが短い → 辞書順。
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
		this.scheduleSave();
		textarea.focus();
	}
}

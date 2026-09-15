// リンクと `@` 挿入（§6.3 ヘッダの操作・§6.7 D-13）。
//
// `findPathCandidates`・`resolveToVault`・`buildAtToken`・`selectionLineRange` は純関数
// （テストは test/links.test.ts）。`obsidian`・`@xterm/xterm` は型だけを使い、実行時の値は
// 呼出側（`views/terminal.ts`・`main.ts`）から受け取る——`obsidian` パッケージは型定義だけで
// 実体を持たず、値として import すると vitest から読み込めない。

import * as path from "node:path";
import type { App } from "obsidian";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

/** 行から拾うパスらしき文字列。`\w./~-` の並びに拡張子、任意で `:行[:桁]`。 */
const CANDIDATE_RE = /([\w./~-]+\.[A-Za-z0-9]+)(?::(\d+)(?::(\d+))?)?/g;
/** 候補から URL を除くための当たり判定。 */
const URL_RE = /\w+:\/\/\S+/g;

export interface PathCandidate {
	/** 行の中の文字列そのもの（`:行` を含む）。 */
	text: string;
	/** 行内の開始位置（0 始まり、文字単位）。 */
	start: number;
	/** 終了位置（exclusive）。 */
	end: number;
	/** `:行[:桁]` を除いたパス部分。 */
	path: string;
	/** 行番号（1 始まり）。無ければ `undefined`。 */
	line?: number;
}

/** 行文字列からパスらしき候補を拾う。URL は除く（§6.7）。 */
export function findPathCandidates(line: string): PathCandidate[] {
	const urlRanges: Array<[number, number]> = [];
	for (const m of line.matchAll(URL_RE)) {
		const start = m.index ?? 0;
		urlRanges.push([start, start + m[0].length]);
	}
	const out: PathCandidate[] = [];
	for (const m of line.matchAll(CANDIDATE_RE)) {
		const start = m.index ?? 0;
		const end = start + m[0].length;
		if (urlRanges.some(([s, e]) => start < e && end > s)) {
			continue;
		}
		out.push({
			text: m[0],
			start,
			end,
			path: m[1],
			line: m[2] !== undefined ? Number(m[2]) : undefined,
		});
	}
	return out;
}

/**
 * 候補パスを vault 相対に直す。絶対パスは vault 配下なら相対に、相対パスは `cwd` からの
 * 相対を vault 相対に直す（`..` は正規化する）。vault の外なら `null`。
 */
export function resolveToVault(candidate: string, cwd: string, vaultPath: string): string | null {
	const abs = path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate);
	const rel = path.relative(vaultPath, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return null;
	}
	return rel.split(path.sep).join("/");
}

/**
 * `@` 挿入のトークン。絶対パス `absPath` をセッションの `cwd` からの相対にする（`cwd` の外なら
 * 絶対のまま）。複数行選択なら `#L{from}-{to}`（1 始まり）を付け、空白を含めば引用符で囲む。
 */
export function buildAtToken(absPath: string, cwd: string, range?: { from: number; to: number }): string {
	const rel = path.relative(cwd, absPath);
	const chosen = rel.startsWith("..") ? absPath : rel;
	let p = chosen.split(path.sep).join("/");
	if (range && range.to > range.from) {
		p += `#L${range.from + 1}-${range.to + 1}`;
	}
	return /\s/.test(p) ? `"${p}"` : p;
}

/** `Editor` の必要な部分だけ（`obsidian` の値を import しないための最小形）。 */
export interface EditorLike {
	getCursor(side: "from" | "to"): { line: number };
}

/** 選択が複数行にまたがるときだけ `{from, to}`（0 始まりの行）。 */
export function selectionLineRange(editor: EditorLike): { from: number; to: number } | undefined {
	const from = editor.getCursor("from").line;
	const to = editor.getCursor("to").line;
	return to > from ? { from, to } : undefined;
}

export interface VaultLinkProviderDeps {
	app: App;
	terminal: Terminal;
	/** 呼出のたびに取る（セッションの `cwd` は起動後変わらないが、関数で受けておく）。 */
	cwd: () => string;
	vaultPath: string;
}

/** `Terminal.registerLinkProvider` に載せる（§6.7）。実在確認とクリック時の遷移を担う。 */
export class VaultLinkProvider implements ILinkProvider {
	constructor(private deps: VaultLinkProviderDeps) {}

	provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
		const { app, terminal, cwd, vaultPath } = this.deps;
		const bufferLine = terminal.buffer.active.getLine(bufferLineNumber - 1);
		const text = bufferLine?.translateToString(true);
		if (!text) {
			callback(undefined);
			return;
		}
		const links: ILink[] = [];
		for (const candidate of findPathCandidates(text)) {
			const relPath = resolveToVault(candidate.path, cwd(), vaultPath);
			if (relPath === null || !app.vault.getAbstractFileByPath(relPath)) {
				continue;
			}
			links.push({
				range: {
					start: { x: candidate.start + 1, y: bufferLineNumber },
					end: { x: candidate.end + 1, y: bufferLineNumber },
				},
				text: candidate.text,
				decorations: { underline: true, pointerCursor: true },
				activate: () => void this.open(relPath, candidate.line),
			});
		}
		callback(links.length > 0 ? links : undefined);
	}

	/** `openLinkText` でメイン領域に開き、行番号があればそこへカーソルを移す。 */
	private async open(relPath: string, line: number | undefined): Promise<void> {
		const { app } = this.deps;
		await app.workspace.openLinkText(relPath, "", "tab");
		if (line === undefined) {
			return;
		}
		app.workspace.activeEditor?.editor?.setCursor({ line: line - 1, ch: 0 });
	}
}

// 編集領域の `@` 補完（D-22）。純関数。`obsidian` は import しない
// （候補の絞り込みは呼出側が `prepareFuzzySearch` で行う）。

import * as path from "node:path";

export interface AtQuery {
	/** `@` の位置（0 始まり）。 */
	start: number;
	/** `@` の直後からカーソルまで。 */
	query: string;
}

/**
 * カーソルの直前にある `@検索語` を切り出す。`@` は行頭か空白の直後にあり、`@` から
 * カーソルまでに空白が無いときだけ補完の対象にする。無ければ `null`。
 */
export function findAtQuery(text: string, cursor: number): AtQuery | null {
	const end = Math.max(0, Math.min(cursor, text.length));
	let i = end - 1;
	while (i >= 0) {
		const ch = text[i];
		if (/\s/.test(ch)) {
			return null;
		}
		if (ch === "@") {
			if (i === 0 || /\s/.test(text[i - 1])) {
				return { start: i, query: text.slice(i + 1, end) };
			}
			return null;
		}
		i--;
	}
	return null;
}

export interface Completion {
	text: string;
	cursor: number;
}

/** `text[start, end)` を `@relPath ` に置き換え、その直後にカーソルを置く。 */
export function applyCompletion(text: string, start: number, end: number, relPath: string): Completion {
	const replacement = `@${relPath} `;
	return {
		text: text.slice(0, start) + replacement + text.slice(end),
		cursor: start + replacement.length,
	};
}

function isInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * vault 相対パス `vaultRel` を、セッションの `cwd` から見た相対パスにする。`cwd` が vault の
 * 中なら `../` で辿る相対、`cwd` が vault の外なら絶対のまま。区切りは `/`、空白を含めば
 * 引用符で囲む。
 */
export function relPathFor(vaultPath: string, vaultRel: string, cwd: string): string {
	const abs = path.join(vaultPath, vaultRel);
	const rel = path.relative(cwd, abs);
	const chosen = isInside(cwd, abs) || isInside(vaultPath, cwd) ? rel : abs;
	const p = chosen.split(path.sep).join("/");
	return /\s/.test(p) ? `"${p}"` : p;
}

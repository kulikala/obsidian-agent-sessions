// `@` completion for the editor pane. Pure functions — `obsidian` is never imported here
// (narrowing candidates with `prepareFuzzySearch` is left to the caller).

import * as path from "node:path";

export interface AtQuery {
	/** Where `@` is (0-based). */
	start: number;
	/** Everything from right after `@` up to the cursor. */
	query: string;
}

/**
 * Extracts an `@query` sitting right before the cursor. Only treated as completable when `@`
 * is at the start of the line or right after whitespace, and there's no whitespace between `@`
 * and the cursor. Returns `null` if there isn't one.
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

/** Replaces `text[start, end)` with `@relPath ` and places the cursor right after it. */
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
 * Turns a vault-relative path `vaultRel` into one relative to the session's `cwd`. If `cwd` is
 * inside the vault, this walks back up with `../` as needed; if `cwd` is outside the vault, it
 * stays absolute. Uses `/` as the separator, and quotes the result if it contains whitespace.
 */
export function relPathFor(vaultPath: string, vaultRel: string, cwd: string): string {
	const abs = path.join(vaultPath, vaultRel);
	const rel = path.relative(cwd, abs);
	const chosen = isInside(cwd, abs) || isInside(vaultPath, cwd) ? rel : abs;
	const p = chosen.split(path.sep).join("/");
	return /\s/.test(p) ? `"${p}"` : p;
}

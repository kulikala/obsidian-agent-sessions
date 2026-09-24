// Links and `@` insertion (header actions).
//
// `findPathCandidates`, `resolveToVault`, `buildAtToken`, and `selectionLineRange` are pure
// functions (tested in test/links.test.ts). `obsidian` and `@xterm/xterm` are used only for
// their types; runtime values are passed in by the caller (`views/terminal.ts`, `main.ts`) —
// the `obsidian` package has no runtime implementation, only type definitions, so importing it
// as a value would fail to load under vitest.

import * as path from "node:path";
import type { App } from "obsidian";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

/** A string in a line that looks like a path: a run of `\w./~-` plus an extension, with an optional `:line[:col]`. */
const CANDIDATE_RE = /([\w./~-]+\.[A-Za-z0-9]+)(?::(\d+)(?::(\d+))?)?/g;
/** Matches URLs, so they can be excluded from candidates. */
const URL_RE = /\w+:\/\/\S+/g;

export interface PathCandidate {
	/** The literal text in the line (including `:line`). */
	text: string;
	/** Start position within the line (0-based, in characters). */
	start: number;
	/** End position (exclusive). */
	end: number;
	/** The path part, with `:line[:col]` stripped off. */
	path: string;
	/** Line number (1-based). `undefined` if there isn't one. */
	line?: number;
}

/** Picks out path-like candidates from a line of text, excluding URLs. */
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
 * Turns a candidate path into a vault-relative one. An absolute path becomes relative if it's
 * inside the vault; a relative path is resolved against `cwd`, then made vault-relative
 * (normalizing `..`). Returns `null` if it falls outside the vault.
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
 * Builds the token for `@` insertion. Makes the absolute path `absPath` relative to the
 * session's `cwd` (left absolute if it's outside `cwd`). Appends `#L{from}-{to}` (1-based) for
 * a multi-line selection, and quotes the result if it contains whitespace.
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

/** Only the part of `Editor` this needs (a minimal shape so `obsidian`'s value doesn't have to be imported). */
export interface EditorLike {
	getCursor(side: "from" | "to"): { line: number };
}

/** `{from, to}` (0-based lines), only when the selection spans multiple lines. */
export function selectionLineRange(editor: EditorLike): { from: number; to: number } | undefined {
	const from = editor.getCursor("from").line;
	const to = editor.getCursor("to").line;
	return to > from ? { from, to } : undefined;
}

export interface VaultLinkProviderDeps {
	app: App;
	terminal: Terminal;
	/** Fetched on every call (a session's `cwd` doesn't change after start, but this is a function to keep it live anyway). */
	cwd: () => string;
	vaultPath: string;
}

/** Registered with `Terminal.registerLinkProvider`. Checks that a path exists and handles navigating to it on click. */
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

	/** Opens it in the main area via `openLinkText`, and moves the cursor there if a line number was given. */
	private async open(relPath: string, line: number | undefined): Promise<void> {
		const { app } = this.deps;
		await app.workspace.openLinkText(relPath, "", "tab");
		if (line === undefined) {
			return;
		}
		app.workspace.activeEditor?.editor?.setCursor({ line: line - 1, ch: 0 });
	}
}

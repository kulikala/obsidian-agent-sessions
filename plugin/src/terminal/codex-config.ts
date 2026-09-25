// Codex CLI's own config (`~/.codex/config.toml`, respecting `CODEX_HOME`) — the submit-key
// keymap (T-108) and a default `[tui].status_line` when the user hasn't set one. This is the
// plugin's side of the contract agreed with lnx-py's Python-side removal
// (`agentsessions/codex/config_toml.py`, `agent-sessions setup --remove`): every line this
// feature writes ends with `MANAGED_MARKER`, so removal is purely marker-driven, and a brand-new
// table created *solely* to hold our own keys gets its header line marked too (so an empty table
// doesn't linger after removal) — but a key added to a table that already existed for some other
// reason (the user's own, or Codex's own) never has its header marked, since that table isn't
// ours to remove.
//
// Line-based text editing only, never a TOML parse-and-rewrite — same reasoning as the Python
// side: re-serializing risks reformatting or reordering content that has nothing to do with this
// feature (comments, blank-line spacing, key order), and this project has no need to understand
// the rest of the file at all. A table header is recognized only as a single, whole line of the
// exact form `[dotted.path]` (optionally followed by a trailing `#` comment) — this doesn't
// attempt to track multi-line arrays/strings that could (in principle) contain a line that merely
// *looks* like a header; real-world config.toml files don't do this for the tables this feature
// touches, and `readCodexConfig`'s own sanity check (see below) catches the more likely failure
// mode (a config.toml that's simply broken) before anything is written.

import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "../i18n";

/** Written at the end of every line this feature adds to config.toml — must match
 * `agentsessions/codex/config_toml.py`'s `MANAGED_MARKER` exactly (agreed with lnx-py for
 * T-108/T-109). A line is "ours" if it *ends with* this, after trailing whitespace is stripped —
 * never a substring match elsewhere on the line. */
export const MANAGED_MARKER = "# managed by Agent Sessions";

/** Codex's own default `editor.insert_newline` bindings (`codex-rs/tui/src/keymap.rs`, verified
 * 2026-09-25 against codex-cli 0.154.0-alpha.6.2) minus `alt-enter`, which this feature's
 * `composer.submit` always claims when active — the fixed pair this feature writes to
 * `editor.insert_newline` whenever it writes `composer.submit` at all. */
const CODEX_INSERT_NEWLINE_KEYS = ["enter", "shift-enter"];

/** The default `status_line` this feature writes when the user hasn't set one at all — closest to
 * Claude Code's own "model · effort · ctx%" statusLine among Codex's real item names
 * (`model-with-reasoning`, `context-used` — both verified present in `codex-rs`'s own
 * `status_line_setup.rs`/`types.rs`, and in a real local `~/.codex/config.toml`). */
const CODEX_DEFAULT_STATUS_LINE = ["model-with-reasoning", "context-used"];

function markedLine(indent: string, content: string): string {
	return `${indent}${content} ${MANAGED_MARKER}\n`;
}

function isManagedLine(line: string): boolean {
	return line.replace(/[\r\n]+$/, "").trimEnd().endsWith(MANAGED_MARKER);
}

/** `["a", "b"]` — a TOML array of bare strings. Only ever called with this module's own fixed,
 * hardcoded literals (never arbitrary/untrusted text), so no escaping beyond wrapping in quotes
 * is attempted. */
function tomlStringArray(items: readonly string[]): string {
	return `[${items.map((s) => `"${s}"`).join(", ")}]`;
}

/** Escapes a table path segment for the header-matching regex (dots are literal separators in
 * the dotted path we search for, not regex wildcards). */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The `[start, end)` line-index range (into `lines`) belonging to the table `[tablePath]` — from
 * right after its own header line up to (but not including) the next header line, or EOF. `null`
 * if that exact table header doesn't appear anywhere as its own whole line. Matches only a
 * single-bracket header (`[tablePath]`, not `[[tablePath]]`, which is TOML's distinct
 * array-of-tables syntax this feature never writes or needs to recognize). */
function findTableRange(lines: string[], tablePath: string): { headerIndex: number; start: number; end: number } | null {
	const headerRe = new RegExp(`^\\[\\s*${escapeRegExp(tablePath)}\\s*\\](\\s*#.*)?\\s*$`);
	const anyHeaderRe = /^\s*\[/;
	const headerIndex = lines.findIndex((line) => headerRe.test(line));
	if (headerIndex === -1) {
		return null;
	}
	let end = lines.length;
	for (let i = headerIndex + 1; i < lines.length; i++) {
		if (anyHeaderRe.test(lines[i])) {
			end = i;
			break;
		}
	}
	return { headerIndex, start: headerIndex + 1, end };
}

export interface UpsertResult {
	text: string;
	changed: boolean;
	/** A line for this key already exists in the table, but isn't one of ours — left untouched. */
	conflict: boolean;
}

/**
 * Ensures `[tablePath]` has `key = valueLiteral` (marked as ours), creating the table (also
 * marked, at the end of the file) if it doesn't exist yet. If a line for `key` already exists in
 * that table:
 * - Ours already, same value → no-op.
 * - Ours, different value → replaced in place (still marked).
 * - Not ours (the user's own, or Codex's own) → left completely alone; `conflict: true` (the
 *   caller decides what to do with that, e.g. a warning — this function never overwrites a
 *   pre-existing, unmarked key).
 */
export function upsertManagedKey(text: string, tablePath: string, key: string, valueLiteral: string): UpsertResult {
	const lines = text.length > 0 ? text.split(/(?<=\n)/) : [];
	const keyRe = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=`);
	const desired = `${key} = ${valueLiteral}`;

	const range = findTableRange(lines, tablePath);
	if (range) {
		for (let i = range.start; i < range.end; i++) {
			const m = keyRe.exec(lines[i]);
			if (!m) {
				continue;
			}
			if (!isManagedLine(lines[i])) {
				return { text, changed: false, conflict: true };
			}
			const newLine = markedLine(m[1], desired);
			if (lines[i] === newLine) {
				return { text, changed: false, conflict: false };
			}
			lines[i] = newLine;
			return { text: lines.join(""), changed: true, conflict: false };
		}
		// No existing line for `key` in this table — insert right after the table's own last
		// content line, skipping any trailing blank lines within its range, so this doesn't
		// insert *after* the blank line that separates it from the next table (that separator,
		// if there is one, stays between our new line and whatever comes next, unchanged).
		let insertAt = range.end;
		while (insertAt > range.start && lines[insertAt - 1].trim() === "") {
			insertAt--;
		}
		lines.splice(insertAt, 0, markedLine("", desired));
		return { text: lines.join(""), changed: true, conflict: false };
	}

	// The table doesn't exist at all — append a brand-new section at the end of the file. Its
	// header is marked too (T-108 follow-up, agreed with lnx-py): a table created *solely* to
	// hold our own key(s) should leave nothing behind once removed.
	const needsLeadingNewline = text.length > 0 && !text.endsWith("\n");
	const needsBlankLine = text.length > 0 && !text.endsWith("\n\n");
	const prefix = (needsLeadingNewline ? "\n" : "") + (needsBlankLine ? "\n" : "");
	const section = markedLine("", `[${tablePath}]`) + markedLine("", desired);
	return { text: text + prefix + section, changed: true, conflict: false };
}

/**
 * Removes `key`'s line from `[tablePath]` if it exists *and* is marked as ours — a no-op
 * (including when the table or key doesn't exist, or exists but isn't ours) otherwise. Never
 * removes the table header itself, even if this leaves the table empty — matches
 * `agent-sessions setup --remove`'s own contract (an orphaned header is left exactly as is; only
 * `setup --remove`'s blanket sweep at uninstall cleans up every marked line, headers included).
 */
export function removeManagedKey(text: string, tablePath: string, key: string): { text: string; changed: boolean } {
	const lines = text.length > 0 ? text.split(/(?<=\n)/) : [];
	const range = findTableRange(lines, tablePath);
	if (!range) {
		return { text, changed: false };
	}
	const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
	for (let i = range.start; i < range.end; i++) {
		if (keyRe.test(lines[i]) && isManagedLine(lines[i])) {
			lines.splice(i, 1);
			return { text: lines.join(""), changed: true };
		}
	}
	return { text, changed: false };
}

/** Whether `[tablePath]` already has *any* line for `key` — regardless of whose it is. Used for
 * `status_line`, which this feature only ever writes when the user hasn't set one at all (never
 * overwrites, even its own past value, the same "only if unset" rule the whole feature was
 * designed around after `~/.codex/config.toml` from a real machine turned up an
 * already-customized `status_line`). */
export function hasAnyKey(text: string, tablePath: string, key: string): boolean {
	const lines = text.length > 0 ? text.split(/(?<=\n)/) : [];
	const range = findTableRange(lines, tablePath);
	if (!range) {
		return false;
	}
	const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
	return lines.slice(range.start, range.end).some((line) => keyRe.test(line));
}

/**
 * A light, deliberately narrow sanity check — not a TOML parser (see the module comment). Flags
 * a file as malformed only when something this feature's own line-based edits would clearly get
 * wrong: an odd number of `"""`/`'''` (a multi-line string still open at EOF) or unbalanced `[`/`]`
 * bracket counts across the whole file. A file that passes this check isn't guaranteed
 * well-formed TOML — it's just not one of the specific shapes this feature knows it can't safely
 * edit line-by-line.
 */
export function looksMalformed(text: string): boolean {
	const tripleDouble = (text.match(/"""/g) ?? []).length;
	const tripleSingle = (text.match(/'''/g) ?? []).length;
	if (tripleDouble % 2 !== 0 || tripleSingle % 2 !== 0) {
		return true;
	}
	const open = (text.match(/\[/g) ?? []).length;
	const close = (text.match(/\]/g) ?? []).length;
	return open !== close;
}

export interface ApplyCodexConfigResult {
	status: "written" | "unchanged" | "failed";
	warning?: string;
}

/**
 * Syncs `~/.codex/config.toml` (or wherever `filePath` points) with two independent, T-108
 * features:
 *
 * 1. **Submit key**: when `submitKey !== "enter"`, ensures `composer.submit = "alt-enter"` and
 *    `editor.insert_newline = ["enter", "shift-enter"]` (Codex's own default minus alt-enter) —
 *    always this exact fixed pair regardless of *which* of the 4 non-`enter` choices is
 *    configured, since the plugin's own terminal key interception (`terminal/keys.ts`) is what
 *    translates whichever one the user picked into the same alt-enter byte sequence sent to the
 *    PTY (mirroring Claude's own `sendSequence`/keybindings.json approach exactly). When
 *    `submitKey === "enter"`, removes both managed lines instead (reverting to Codex's own
 *    defaults) rather than leaving stale ones behind.
 * 2. **status_line default**: if `[tui]` doesn't have a `status_line` key *at all* yet (ours or
 *    the user's own), writes `["model-with-reasoning", "context-used"]`. Never touches an
 *    already-set one, even one this feature wrote previously.
 *
 * Returns `{status: "unchanged"}` without touching the file (or creating a backup) if nothing
 * needs to change. Returns `{status: "failed", warning}` without writing anything if the file
 * can't be read, or `looksMalformed`. A conflict (an unmarked, pre-existing key where this
 * feature wanted to write one) is reported as a `warning` alongside `"written"` if anything else
 * did change, or as `{status: "unchanged", warning}` if that conflict was the only thing this
 * call would have done.
 */
export function applyCodexConfig(filePath: string, submitKey: string): ApplyCodexConfigResult {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			text = "";
		} else {
			return { status: "failed", warning: t("error.codexConfigUnreadable", { path: filePath }) };
		}
	}

	if (text.length > 0 && looksMalformed(text)) {
		return { status: "failed", warning: t("error.codexConfigMalformed", { path: filePath }) };
	}

	const original = text;
	let changed = false;
	const conflicts: string[] = [];

	if (submitKey !== "enter") {
		const r1 = upsertManagedKey(text, "tui.keymap.composer", "submit", `"alt-enter"`);
		text = r1.text;
		changed = changed || r1.changed;
		if (r1.conflict) {
			conflicts.push("tui.keymap.composer.submit");
		}
		const r2 = upsertManagedKey(text, "tui.keymap.editor", "insert_newline", tomlStringArray(CODEX_INSERT_NEWLINE_KEYS));
		text = r2.text;
		changed = changed || r2.changed;
		if (r2.conflict) {
			conflicts.push("tui.keymap.editor.insert_newline");
		}
	} else {
		const r1 = removeManagedKey(text, "tui.keymap.composer", "submit");
		text = r1.text;
		changed = changed || r1.changed;
		const r2 = removeManagedKey(text, "tui.keymap.editor", "insert_newline");
		text = r2.text;
		changed = changed || r2.changed;
	}

	if (!hasAnyKey(text, "tui", "status_line")) {
		const r3 = upsertManagedKey(text, "tui", "status_line", tomlStringArray(CODEX_DEFAULT_STATUS_LINE));
		text = r3.text;
		changed = changed || r3.changed;
		if (r3.conflict) {
			conflicts.push("tui.status_line");
		}
	}

	const warning = conflicts.length > 0 ? t("warning.codexConfigManualFix", { keys: conflicts.join(", ") }) : undefined;

	if (!changed) {
		return { status: "unchanged", warning };
	}

	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	if (original.length > 0) {
		const backupPath = `${filePath}.bak-${backupTimestamp()}`;
		fs.writeFileSync(backupPath, original, "utf8");
	}
	fs.writeFileSync(filePath, text, "utf8");
	return { status: "written", warning };
}

/** `YYYYMMDDHHmmss`, local time — matches `agentsessions/codex/config_toml.py`'s
 * `time.strftime('%Y%m%d%H%M%S')` backup-naming convention exactly. */
function backupTimestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Where `config.toml` lives — under `$CODEX_HOME` if it's set, matching the Python side's
 * `DEFAULT_CONFIG_TOML_PATH`. */
export function defaultCodexConfigPath(homeDir: string, codexHome?: string): string {
	const base = codexHome || path.join(homeDir, ".codex");
	return path.join(base, "config.toml");
}

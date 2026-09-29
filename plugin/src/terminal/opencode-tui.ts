// OpenCode's TUI config (`$XDG_CONFIG_HOME/opencode/tui.json`, default `~/.config/opencode/`) —
// the submit-key keymap, the OpenCode counterpart of `codex-config.ts`.
//
// With the submit key on plain Enter nothing is managed: OpenCode's defaults (Return submits,
// Ctrl+J / linefeed is a newline) match the bytes the terminal view sends. With any other submit
// key, `keybinds.input_submit` / `keybinds.input_newline` are set so that a linefeed (`\n`)
// submits and Return (`\r`) inserts a newline; the terminal view then sends the chosen submit key
// as `\n` and every other Enter combination as `\r` (`terminal/keys.ts`). Popups and dialogs keep
// answering to `\r`: they are not governed by these two keybinds.
//
// Only those two keys are touched. The file is parsed and re-serialized as plain JSON, keeping
// every other key and the file's indentation; a file that isn't plain JSON (JSONC comments,
// trailing commas) is never rewritten. The user's previous values are recorded in a small backup
// file (`~/.agents/sessions/opencode-tui-backup.json`) that the Python side reads too
// (`agentsessions/agents/opencode/tui_config.py`, run by `agent-sessions setup --remove` and
// `--remove-opencode`), so removal works without the plugin. Restoring puts the previous values
// back (or deletes the keys when there were none) and leaves alone any key the user has changed
// since. The backup's field names must match the Python side.

import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "../i18n";
import type { SubmitKey } from "../settings";

export const BACKUP_FILENAME = "opencode-tui-backup.json";

export interface OpencodeTuiBackup {
	/** The tui.json this backup belongs to. */
	path: string;
	/** The values the keys had before we took them over; `null` = the key wasn't there. */
	input_submit: string | null;
	input_newline: string | null;
	/** The values we wrote. */
	managed: { input_submit: string; input_newline: string };
	/** We created the `keybinds` object / the whole file, so removing our keys may remove them too. */
	created_keybinds: boolean;
	created_file: boolean;
}

export function defaultOpencodeTuiPath(home: string, xdgConfigHome?: string): string {
	return path.join(xdgConfigHome || path.join(home, ".config"), "opencode", "tui.json");
}

const RETURN_KEYS = ["return", "shift+return", "ctrl+return", "alt+return"];
const SUBMIT_KEY_NAMES: Partial<Record<SubmitKey, string>> = {
	"shift+enter": "shift+return",
	"ctrl+enter": "ctrl+return",
	"alt+enter": "alt+return",
};

/** The keybinds written for a non-enter submit key. */
export function managedKeybinds(submitKey: SubmitKey): { input_submit: string; input_newline: string } {
	const own = SUBMIT_KEY_NAMES[submitKey];
	return {
		input_submit: "linefeed,ctrl+j",
		input_newline: RETURN_KEYS.filter((k) => k !== own).join(","),
	};
}

export interface OpencodeTuiResult {
	status: "written" | "restored" | "unchanged" | "failed";
	warning?: string;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface Loaded {
	obj: Json;
	existed: boolean;
	indent: string | number;
	eol: string;
	finalNewline: boolean;
}

/** Reads the file as plain JSON; a string is the warning to show instead. */
function load(filePath: string): Loaded | string {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { obj: {}, existed: false, indent: 2, eol: "\n", finalNewline: true };
		}
		return t("error.opencodeTuiUnreadable", { path: filePath });
	}
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const finalNewline = text.length === 0 || /\n$/.test(text);
	if (text.trim() === "") {
		return { obj: {}, existed: true, indent: 2, eol, finalNewline: true };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return t("error.opencodeTuiNotJson", { path: filePath });
	}
	if (!isObject(parsed) || ("keybinds" in parsed && !isObject(parsed.keybinds))) {
		return t("error.opencodeTuiNotJson", { path: filePath });
	}
	const m = /^([ \t]+)"/m.exec(text);
	const indent = m ? (m[1].startsWith("\t") ? "\t" : m[1].length) : 2;
	return { obj: parsed, existed: true, indent, eol, finalNewline };
}

function serialize(l: Loaded): string {
	let out = JSON.stringify(l.obj, null, l.indent);
	if (l.eol === "\r\n") {
		out = out.replace(/\n/g, "\r\n");
	}
	return l.finalNewline ? out + l.eol : out;
}

function writeAtomic(filePath: string, text: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp`;
	fs.writeFileSync(tmp, text, "utf8");
	fs.renameSync(tmp, filePath);
}

export function readBackup(backupPath: string): OpencodeTuiBackup | null {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(backupPath, "utf8"));
		if (isObject(raw) && typeof raw.path === "string" && isObject(raw.managed)) {
			return raw as unknown as OpencodeTuiBackup;
		}
	} catch {
		// no backup, or an unreadable one
	}
	return null;
}

function stringOrNull(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

/** Puts the user's previous values back and deletes the backup. */
export function restoreOpencodeTui(backupPath: string): OpencodeTuiResult {
	const backup = readBackup(backupPath);
	if (!backup) {
		return { status: "unchanged" };
	}
	const loaded = load(backup.path);
	if (typeof loaded === "string") {
		return { status: "failed", warning: loaded };
	}
	let changed = false;
	if (loaded.existed) {
		const kb = isObject(loaded.obj.keybinds) ? loaded.obj.keybinds : null;
		if (kb) {
			for (const key of ["input_submit", "input_newline"] as const) {
				if (kb[key] !== backup.managed[key]) {
					continue; // changed by the user since; theirs now
				}
				const previous = backup[key];
				if (previous === null || previous === undefined) {
					delete kb[key];
				} else {
					kb[key] = previous;
				}
				changed = true;
			}
			if (Object.keys(kb).length === 0 && backup.created_keybinds) {
				delete loaded.obj.keybinds;
			}
		}
		if (changed) {
			try {
				if (Object.keys(loaded.obj).length === 0 && backup.created_file) {
					fs.unlinkSync(backup.path);
				} else {
					writeAtomic(backup.path, serialize(loaded));
				}
			} catch {
				return { status: "failed", warning: t("error.opencodeTuiUnreadable", { path: backup.path }) };
			}
		}
	}
	try {
		fs.unlinkSync(backupPath);
	} catch {
		// already gone
	}
	return { status: changed ? "restored" : "unchanged" };
}

/** Makes tui.json carry the managed keybinds for `submitKey` (not `enter`). */
export function applyOpencodeTui(filePath: string, backupPath: string, submitKey: SubmitKey): OpencodeTuiResult {
	let backup = readBackup(backupPath);
	if (backup && backup.path !== filePath) {
		restoreOpencodeTui(backupPath); // the config folder moved: hand the old file back first
		backup = null;
	}
	const loaded = load(filePath);
	if (typeof loaded === "string") {
		return { status: "failed", warning: loaded };
	}
	const want = managedKeybinds(submitKey);
	const kb = isObject(loaded.obj.keybinds) ? loaded.obj.keybinds : null;
	const current = { input_submit: kb?.input_submit, input_newline: kb?.input_newline };
	const alreadyManaged = current.input_submit === want.input_submit && current.input_newline === want.input_newline;
	if (alreadyManaged && backup) {
		return { status: "unchanged" };
	}

	// What the user had: the recorded values while the file still holds ours, otherwise what is there now.
	const holdsOurs =
		backup !== null &&
		current.input_submit === backup.managed.input_submit &&
		current.input_newline === backup.managed.input_newline;
	const next: OpencodeTuiBackup = {
		path: filePath,
		input_submit: holdsOurs && backup ? backup.input_submit : stringOrNull(current.input_submit),
		input_newline: holdsOurs && backup ? backup.input_newline : stringOrNull(current.input_newline),
		managed: want,
		created_keybinds: holdsOurs && backup ? backup.created_keybinds : kb === null,
		created_file: holdsOurs && backup ? backup.created_file : !loaded.existed,
	};
	// A value we can't record (not a string) is left as is rather than overwritten.
	for (const key of ["input_submit", "input_newline"] as const) {
		if (current[key] !== undefined && typeof current[key] !== "string") {
			return { status: "failed", warning: t("error.opencodeTuiNotJson", { path: filePath }) };
		}
	}
	try {
		if (!alreadyManaged) {
			const target = kb ?? {};
			target.input_submit = want.input_submit;
			target.input_newline = want.input_newline;
			loaded.obj.keybinds = target;
			writeAtomic(filePath, serialize(loaded));
		}
		writeAtomic(backupPath, JSON.stringify(next, null, 2) + "\n");
	} catch {
		return { status: "failed", warning: t("error.opencodeTuiUnreadable", { path: filePath }) };
	}
	return { status: alreadyManaged ? "unchanged" : "written" };
}

/** The one entry point: manage the keybinds when OpenCode is enabled and the submit key isn't Enter; otherwise restore. */
export function syncOpencodeTui(
	filePath: string,
	backupPath: string,
	submitKey: SubmitKey,
	enabled: boolean
): OpencodeTuiResult {
	if (enabled && submitKey !== "enter") {
		return applyOpencodeTui(filePath, backupPath, submitKey);
	}
	return restoreOpencodeTui(backupPath);
}

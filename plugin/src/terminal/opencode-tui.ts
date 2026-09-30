// OpenCode's TUI config (`$XDG_CONFIG_HOME/opencode/tui.json`, default `~/.config/opencode/`) —
// the submit-key and editor-key keymap, the OpenCode counterpart of `codex-config.ts`.
//
// With the submit key on plain Enter the submit keys are not managed: OpenCode's defaults (Return
// submits, Ctrl+J / linefeed is a newline) match the bytes the terminal view sends. With any other
// submit key, `keybinds.input_submit` / `keybinds.input_newline` are set so that a linefeed (`\n`)
// submits and Return (`\r`) inserts a newline; the terminal view then sends the chosen submit key
// as `\n` and every other Enter combination as `\r` (`terminal/keys.ts`). Popups and dialogs keep
// answering to `\r`: they are not governed by these two keybinds.
//
// `keybinds.editor_open` carries the editor key (`settings.editorKey`). OpenCode's own default is
// the leader chord `<leader>e` (Ctrl+X, then E), which is none of the offered keys, so it is
// written whenever OpenCode is enabled. Ctrl+G is also OpenCode's `messages_first`; with the
// prompt focused the editor still opens and the transcript does not move, so that binding is left
// alone.
//
// Only those keys are touched. The file is parsed and re-serialized as plain JSON, keeping
// every other key and the file's indentation; a file that isn't plain JSON (JSONC comments,
// trailing commas) is never rewritten. The user's previous values are recorded in a small backup
// file (`~/.agents/sessions/opencode-tui-backup.json`) that the Python side reads too
// (`agentsessions/agents/opencode/tui_config.py`, run by `agent-sessions setup --remove` and
// `--remove-opencode`), so removal works without the plugin. Each key is tracked on its own: the
// backup's `managed` holds the keys currently taken over and their values. Restoring puts the
// previous values back (or deletes the keys when there were none) and leaves alone any key the
// user has changed since. The backup's field names must match the Python side.

import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "../i18n";
import type { EditorKey, SubmitKey } from "../settings";
import { agentEditorKeyName, editorKeyIsAgentDefault } from "./keys";

export const BACKUP_FILENAME = "opencode-tui-backup.json";

export type ManagedKey = "input_submit" | "input_newline" | "editor_open";
const MANAGED_KEYS: readonly ManagedKey[] = ["input_submit", "input_newline", "editor_open"];
export type ManagedKeybinds = Partial<Record<ManagedKey, string>>;

export interface OpencodeTuiBackup {
	/** The tui.json this backup belongs to. */
	path: string;
	/** The values the managed keys had before we took them over; `null` = the key wasn't there. */
	input_submit?: string | null;
	input_newline?: string | null;
	editor_open?: string | null;
	/** The keys we hold now and the values we wrote. */
	managed: ManagedKeybinds;
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

/** The keybinds to hold: the submit pair for a non-enter submit key, `editor_open` for an editor key other than OpenCode's own. */
export function managedKeybinds(submitKey: SubmitKey, editorKey: EditorKey): ManagedKeybinds {
	const out: ManagedKeybinds = {};
	if (submitKey !== "enter") {
		const own = SUBMIT_KEY_NAMES[submitKey];
		out.input_submit = "linefeed,ctrl+j";
		out.input_newline = RETURN_KEYS.filter((k) => k !== own).join(",");
	}
	if (!editorKeyIsAgentDefault("opencode", editorKey)) {
		out.editor_open = agentEditorKeyName("opencode", editorKey);
	}
	return out;
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

/**
 * Brings `filePath` in line with `want` (the keys to hold, possibly none) and records what is
 * needed to undo it. A key held before and no longer wanted is handed back; a key wanted is set,
 * remembering the user's value unless the file still holds what we wrote earlier. With nothing
 * wanted, the backup is deleted at the end and a `keybinds` object or file we created goes too.
 */
function syncKeys(filePath: string, backupPath: string, backup: OpencodeTuiBackup | null, want: ManagedKeybinds): OpencodeTuiResult {
	const loaded = load(filePath);
	if (typeof loaded === "string") {
		return { status: "failed", warning: loaded };
	}
	const wanted = MANAGED_KEYS.filter((k) => want[k] !== undefined);
	const deleteBackup = () => {
		try {
			fs.unlinkSync(backupPath);
		} catch {
			// already gone
		}
	};
	if (!loaded.existed && wanted.length === 0) {
		deleteBackup();
		return { status: "unchanged" };
	}

	const kb: Json | null = isObject(loaded.obj.keybinds) ? loaded.obj.keybinds : null;
	const recorded = backup?.managed ?? {};
	const held = MANAGED_KEYS.filter((k) => recorded[k] !== undefined && kb?.[k] === recorded[k]);
	// Nothing of ours left in the file: the old records no longer describe it.
	const fresh = backup === null || held.length === 0;
	for (const k of wanted) {
		if (kb?.[k] !== undefined && typeof kb[k] !== "string") {
			return { status: "failed", warning: t("error.opencodeTuiNotJson", { path: filePath }) };
		}
	}

	const previous: Partial<Record<ManagedKey, string | null>> = {};
	const managed: ManagedKeybinds = {};
	let target = kb;
	let changed = false;
	for (const k of MANAGED_KEYS) {
		const isHeld = held.includes(k);
		const w = want[k];
		if (w === undefined) {
			if (isHeld && target) {
				const before = backup?.[k];
				if (before === null || before === undefined) {
					delete target[k];
				} else {
					target[k] = before;
				}
				changed = true;
			}
			continue;
		}
		if (!target) {
			target = {};
		}
		const before = target[k];
		previous[k] = isHeld ? (backup?.[k] ?? null) : stringOrNull(before);
		managed[k] = w;
		if (before !== w) {
			target[k] = w;
			changed = true;
		}
	}

	const holding = Object.keys(managed).length > 0;
	const next: OpencodeTuiBackup = {
		path: filePath,
		...previous,
		managed,
		created_keybinds: fresh || !backup ? kb === null : backup.created_keybinds,
		created_file: fresh || !backup ? !loaded.existed : backup.created_file,
	};
	if (target) {
		loaded.obj.keybinds = target;
		if (!holding && Object.keys(target).length === 0 && (backup?.created_keybinds ?? false)) {
			delete loaded.obj.keybinds;
		}
	}
	try {
		if (changed) {
			if (!holding && Object.keys(loaded.obj).length === 0 && (backup?.created_file ?? false)) {
				fs.unlinkSync(filePath);
			} else {
				writeAtomic(filePath, serialize(loaded));
			}
		}
		if (holding) {
			if (JSON.stringify(next) !== JSON.stringify(backup)) {
				writeAtomic(backupPath, JSON.stringify(next, null, 2) + "\n");
			}
		} else {
			deleteBackup();
		}
	} catch {
		return { status: "failed", warning: t("error.opencodeTuiUnreadable", { path: filePath }) };
	}
	return { status: changed ? (holding ? "written" : "restored") : "unchanged" };
}

/** Puts the user's previous values back and deletes the backup. */
export function restoreOpencodeTui(backupPath: string): OpencodeTuiResult {
	const backup = readBackup(backupPath);
	if (!backup) {
		return { status: "unchanged" };
	}
	return syncKeys(backup.path, backupPath, backup, {});
}

/** Makes tui.json carry the managed keybinds for `submitKey` and `editorKey`, handing back any it held that are no longer wanted. */
export function applyOpencodeTui(filePath: string, backupPath: string, submitKey: SubmitKey, editorKey: EditorKey): OpencodeTuiResult {
	let backup = readBackup(backupPath);
	if (backup && backup.path !== filePath) {
		restoreOpencodeTui(backupPath); // the config folder moved: hand the old file back first
		backup = null;
	}
	return syncKeys(filePath, backupPath, backup, managedKeybinds(submitKey, editorKey));
}

/**
 * The one entry point: manage the keybinds while OpenCode is enabled (the editor key is always
 * managed; the submit pair only for a submit key other than Enter); restore when it is disabled.
 */
export function syncOpencodeTui(
	filePath: string,
	backupPath: string,
	submitKey: SubmitKey,
	editorKey: EditorKey,
	enabled: boolean
): OpencodeTuiResult {
	if (enabled) {
		return applyOpencodeTui(filePath, backupPath, submitKey, editorKey);
	}
	return restoreOpencodeTui(backupPath);
}

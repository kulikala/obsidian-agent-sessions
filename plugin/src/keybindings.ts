// The submit key. Reads and writes `enter`/`meta+enter` in the `Chat` context of
// `~/.claude/keybindings.json` (more precisely, wherever `$CLAUDE_CONFIG_DIR` points).
// This is a Claude Code-wide setting — the vault's `.claude/` is never read.

import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "./i18n";

export type EnterMode = "submit" | "newline" | "custom" | "unreadable";

export interface EnterModeInfo {
	mode: EnterMode;
	/** The raw value to display when `mode === 'custom'` (`"enter → <value>"`). */
	raw?: string;
}

export interface ApplySubmitKeyResult {
	/** Set when a mismatched key was left behind and needs a manual fix. */
	warning?: string;
}

interface KeybindingsBlock {
	context: string;
	bindings?: Record<string, string>;
}

interface KeybindingsFile {
	$schema?: string;
	$docs?: string;
	bindings: KeybindingsBlock[];
}

const SCHEMA_URL = "https://www.schemastore.org/claude-code-keybindings.json";
const DOCS_URL = "https://code.claude.com/docs/en/keybindings";

/** The two keys written to `Chat` when `submitKey !== 'enter'`. */
const ENTER_KEYS: Record<string, string> = {
	enter: "chat:newline",
	"meta+enter": "chat:submit",
};

function parseKeybindingsFile(text: string): KeybindingsFile | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const bindings = (data as { bindings?: unknown }).bindings;
	if (!Array.isArray(bindings)) {
		return null;
	}
	const ok = bindings.every((b) => typeof b === "object" && b !== null && typeof (b as { context?: unknown }).context === "string");
	if (!ok) {
		return null;
	}
	return data as KeybindingsFile;
}

function findChat(data: KeybindingsFile): KeybindingsBlock | undefined {
	return data.bindings.find((b) => b.context === "Chat");
}

/**
 * Reads Enter's current role.
 * - No file → `submit`
 * - JSON is broken, or not the expected shape → `unreadable`
 * - `Chat` has no `enter`, or it's `chat:submit` → `submit`
 * - `chat:newline` → `newline`
 * - Anything else → `custom` (`raw` holds `enter → <value>`)
 */
export function readEnterMode(filePath: string): EnterModeInfo {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { mode: "submit" };
		}
		return { mode: "unreadable" };
	}
	const data = parseKeybindingsFile(text);
	if (!data) {
		return { mode: "unreadable" };
	}
	const enter = findChat(data)?.bindings?.enter;
	if (enter === undefined || enter === "chat:submit") {
		return { mode: "submit" };
	}
	if (enter === "chat:newline") {
		return { mode: "newline" };
	}
	return { mode: "custom", raw: `enter → ${enter}` };
}

/**
 * Reads the raw key list from the `Chat` context. Used by `deriveSubmitKey` to derive the
 * submit key from whether `enter` and `cmd+enter`/`super+enter` are present.
 * `undefined` if the file doesn't exist, can't be read, or has no `Chat` block.
 */
export function readChatBindings(filePath: string): Record<string, string> | undefined {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const data = parseKeybindingsFile(text);
	if (!data) {
		return undefined;
	}
	return findChat(data)?.bindings;
}

/**
 * Applies the submit-key setting to `keybindings.json`.
 * - `submitKey !== 'enter'`: sets `enter: chat:newline` and `meta+enter: chat:submit` in the
 *   `Chat` block (creating it if needed). Other keys and other contexts are left alone. Adds
 *   `$schema`/`$docs` if they're missing.
 * - `submitKey === 'enter'`: removes only the two keys above that still match the values this
 *   code writes. Removes the `Chat` block if it ends up empty. Leaves any key whose value
 *   doesn't match, and returns a `warning` for those.
 *
 * If the file can't be read (it's broken), returns a `warning` without writing anything.
 */
export function applySubmitKey(filePath: string, submitKey: string): ApplySubmitKeyResult {
	const writing = submitKey !== "enter";

	let text: string | null;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			text = null;
		} else {
			return { warning: t("error.keybindingsUnreadable", { path: filePath }) };
		}
	}

	if (text === null && !writing) {
		// Nothing to write, and no file exists either — do nothing.
		return {};
	}

	let data: KeybindingsFile;
	if (text === null) {
		data = { bindings: [] };
	} else {
		const parsed = parseKeybindingsFile(text);
		if (!parsed) {
			return { warning: t("error.keybindingsUnreadable", { path: filePath }) };
		}
		data = parsed;
	}

	if (data.$schema === undefined) {
		data.$schema = SCHEMA_URL;
	}
	if (data.$docs === undefined) {
		data.$docs = DOCS_URL;
	}

	let warning: string | undefined;

	if (writing) {
		let chat = findChat(data);
		if (!chat) {
			chat = { context: "Chat", bindings: {} };
			data.bindings.push(chat);
		}
		if (!chat.bindings) {
			chat.bindings = {};
		}
		Object.assign(chat.bindings, ENTER_KEYS);
	} else {
		const chat = findChat(data);
		if (chat?.bindings) {
			const mismatched: string[] = [];
			for (const [key, value] of Object.entries(ENTER_KEYS)) {
				if (chat.bindings[key] === value) {
					delete chat.bindings[key];
				} else if (key in chat.bindings) {
					mismatched.push(key);
				}
			}
			if (Object.keys(chat.bindings).length === 0) {
				data.bindings = data.bindings.filter((b) => b !== chat);
			}
			if (mismatched.length > 0) {
				warning = t("warning.manualFix", { keys: mismatched.join(", ") });
			}
		}
	}

	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
	return warning ? { warning } : {};
}

/** Where `keybindings.json` lives — under `$CLAUDE_CONFIG_DIR` if it's set. */
export function defaultKeybindingsPath(homeDir: string, configDir?: string): string {
	const base = configDir || path.join(homeDir, ".claude");
	return path.join(base, "keybindings.json");
}

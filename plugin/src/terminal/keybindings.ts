// The submit key. Reads and writes `enter`/`meta+enter` (and cleans up `OWNED_KEYS`, the wider
// set of keys this feature could plausibly have used across its history) in the `Chat` context
// of `~/.claude/keybindings.json` (more precisely, wherever `$CLAUDE_CONFIG_DIR` points).
// This is a Claude Code-wide setting — the vault's `.claude/` is never read.

import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "../i18n";

export type EnterMode = "submit" | "newline" | "custom" | "unreadable";

export interface EnterModeInfo {
	mode: EnterMode;
	/** The raw value to display when `mode === 'custom'` (`"enter → <value>"`). */
	raw?: string;
}

export interface ApplySubmitKeyResult {
	/** "written" — the file was created or changed. "unchanged" — it already matched the desired
	 * state, so nothing was written. "failed" — the file exists but couldn't be read or parsed;
	 * nothing was written. */
	status: "written" | "unchanged" | "failed";
	/** Set on "failed" (why), or alongside "written" when a same-named key already held an
	 * unexpected value and was left in place rather than overwritten — a manual fix is needed
	 * for that one key. */
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

/**
 * Every key this feature could plausibly have put a `chat:submit`/`chat:newline` value on,
 * across its whole history — `enter`/`meta+enter` are the only two ever written today
 * (`ENTER_KEYS`), but an earlier version wrote `shift+enter` too (D-41's predecessor), and a
 * hand-edited or Claude-Code-authored file can use any of the other literal `SubmitKey` names
 * (`cmd+enter`, `ctrl+enter`, `alt+enter` — `deriveSubmitKey` in `keys.ts` reads these as
 * signals). `applySubmitKey` treats all six as "ours" for cleanup: switching back to `enter`
 * clears every one of them that still holds its canonical value, and switching to a non-`enter`
 * key clears any of the other four holding `chat:submit` (this feature only ever uses one
 * alternate-submit binding at a time). A key holding some other, unrelated action is never ours
 * and is always left alone.
 */
const OWNED_KEYS = ["enter", "meta+enter", "cmd+enter", "ctrl+enter", "shift+enter", "alt+enter"] as const;

/** `enter`'s canonical (ours) value is `chat:newline`; every other owned key's is `chat:submit`. */
function ownedCanonicalValue(key: string): string {
	return key === "enter" ? "chat:newline" : "chat:submit";
}

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
 *   `Chat` block (creating it if needed), and clears any of `cmd+enter`/`ctrl+enter`/
 *   `shift+enter`/`alt+enter` that's still holding `chat:submit` (a stale alternate-submit
 *   binding from a past version or a duplicate entry — this feature only ever uses one at a
 *   time). Every other key, and every other context, is left alone. Adds `$schema`/`$docs` if
 *   they're missing.
 * - `submitKey === 'enter'`: removes every one of `OWNED_KEYS` that still holds its canonical
 *   value. Removes the `Chat` block if it ends up empty. Leaves any owned key whose value
 *   doesn't match its canonical one (some other action, or the user's own custom binding), and
 *   returns a `warning` listing those.
 *
 * Returns `{status: "unchanged"}` without touching the file at all when it already matches the
 * desired state (including "no file, and nothing to write"). Returns `{status: "failed",
 * warning}` without writing anything if the file exists but can't be read or parsed.
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
			return { status: "failed", warning: t("error.keybindingsUnreadable", { path: filePath }) };
		}
	}

	if (text === null && !writing) {
		// Nothing to write, and no file exists either — do nothing.
		return { status: "unchanged" };
	}

	let data: KeybindingsFile;
	let mutated = false;
	if (text === null) {
		data = { bindings: [] };
		mutated = true; // Creating the file at all.
	} else {
		const parsed = parseKeybindingsFile(text);
		if (!parsed) {
			return { status: "failed", warning: t("error.keybindingsUnreadable", { path: filePath }) };
		}
		data = parsed;
	}

	if (data.$schema === undefined) {
		data.$schema = SCHEMA_URL;
		mutated = true;
	}
	if (data.$docs === undefined) {
		data.$docs = DOCS_URL;
		mutated = true;
	}

	let warning: string | undefined;

	if (writing) {
		let chat = findChat(data);
		if (!chat) {
			chat = { context: "Chat", bindings: {} };
			data.bindings.push(chat);
			mutated = true;
		}
		if (!chat.bindings) {
			chat.bindings = {};
		}
		for (const [key, value] of Object.entries(ENTER_KEYS)) {
			if (chat.bindings[key] !== value) {
				chat.bindings[key] = value;
				mutated = true;
			}
		}
		for (const key of OWNED_KEYS) {
			if (key === "enter" || key === "meta+enter") {
				continue;
			}
			if (chat.bindings[key] === "chat:submit") {
				delete chat.bindings[key];
				mutated = true;
			}
		}
	} else {
		const chat = findChat(data);
		if (chat?.bindings) {
			const mismatched: string[] = [];
			for (const key of OWNED_KEYS) {
				if (chat.bindings[key] === ownedCanonicalValue(key)) {
					delete chat.bindings[key];
					mutated = true;
				} else if (key in chat.bindings) {
					mismatched.push(key);
				}
			}
			if (Object.keys(chat.bindings).length === 0) {
				const before = data.bindings.length;
				data.bindings = data.bindings.filter((b) => b !== chat);
				mutated = mutated || data.bindings.length !== before;
			}
			if (mismatched.length > 0) {
				warning = t("warning.manualFix", { keys: mismatched.join(", ") });
			}
		}
	}

	if (!mutated) {
		return { status: "unchanged", warning };
	}

	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
	return { status: "written", warning };
}

/** Where `keybindings.json` lives — under `$CLAUDE_CONFIG_DIR` if it's set. */
export function defaultKeybindingsPath(homeDir: string, configDir?: string): string {
	const base = configDir || path.join(homeDir, ".claude");
	return path.join(base, "keybindings.json");
}

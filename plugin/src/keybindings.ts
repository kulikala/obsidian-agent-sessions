// Enter の役割（送信／改行）（D-14・§6.8）。`~/.claude/keybindings.json`（正しくは
// `$CLAUDE_CONFIG_DIR` 配下）の `Chat` コンテキストの `enter` を読み書きする。
// Claude Code 全体の設定で、vault の `.claude/` は読まない。

import * as fs from "node:fs";
import * as path from "node:path";

export type EnterMode = "submit" | "newline" | "custom" | "unreadable";

export interface EnterModeInfo {
	mode: EnterMode;
	/** `mode === 'custom'` のときの表示用の生値（`"enter → <値>"`）。 */
	raw?: string;
}

export interface SetEnterModeResult {
	/** 一致しない鍵が残っていて手で直す必要があるときの文言。 */
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

/** 改行モードで `Chat` に入れる 3 鍵（§6.8）。 */
const NEWLINE_KEYS: Record<string, string> = {
	enter: "chat:newline",
	"shift+enter": "chat:submit",
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
 * 現在の Enter の役割を読む。
 * - ファイルが無い → `submit`
 * - JSON が壊れている／形が想定と違う → `unreadable`
 * - `Chat` の `enter` が無い、または `chat:submit` → `submit`
 * - `chat:newline` → `newline`
 * - それ以外 → `custom`（`raw` に `enter → <値>`）
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
 * Enter の役割を切り替える（§6.8）。
 * - `newline`：`Chat` ブロック（無ければ作る）に 3 鍵を入れる。他の鍵・他の
 *   コンテキストは触らない。`$schema`・`$docs` が無ければ足す。
 * - `submit`：3 鍵のうち、書いた値と一致するものだけ消す。空になった `Chat`
 *   ブロックは消す。一致しない鍵は残し `warning` を返す。
 *
 * ファイルが読めない（壊れている）ときは書かずに `warning` を返す。
 */
export function setEnterMode(filePath: string, mode: "newline" | "submit"): SetEnterModeResult {
	let text: string | null;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			text = null;
		} else {
			return { warning: `${filePath} が読めません。手で直す必要があります` };
		}
	}

	if (text === null && mode === "submit") {
		// 既定（送信）で、ファイルも無い。何もしない。
		return {};
	}

	let data: KeybindingsFile;
	if (text === null) {
		data = { bindings: [] };
	} else {
		const parsed = parseKeybindingsFile(text);
		if (!parsed) {
			return { warning: `${filePath} が読めません。手で直す必要があります` };
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

	if (mode === "newline") {
		let chat = findChat(data);
		if (!chat) {
			chat = { context: "Chat", bindings: {} };
			data.bindings.push(chat);
		}
		if (!chat.bindings) {
			chat.bindings = {};
		}
		Object.assign(chat.bindings, NEWLINE_KEYS);
	} else {
		const chat = findChat(data);
		if (chat?.bindings) {
			const mismatched: string[] = [];
			for (const [key, value] of Object.entries(NEWLINE_KEYS)) {
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
				warning = `手で直す必要があります（${mismatched.join(", ")} が想定と違う値のまま残っています）`;
			}
		}
	}

	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
	return warning ? { warning } : {};
}

/** `keybindings.json` の置き場。`$CLAUDE_CONFIG_DIR` があればその配下。 */
export function defaultKeybindingsPath(homeDir: string, configDir?: string): string {
	const base = configDir || path.join(homeDir, ".claude");
	return path.join(base, "keybindings.json");
}

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySubmitKey, defaultKeybindingsPath, readChatBindings, readEnterMode } from "../../src/terminal/keybindings";
import {
	deriveSubmitKey,
	reconcileSubmitKey,
	sendSequence,
	submitKeyButtonLabel,
	submitKeyStatuslineSymbol,
} from "../../src/terminal/keys";
import { SUBMIT_KEYS } from "../../src/settings";

describe("readEnterMode", () => {
	let dir: string;
	let filePath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-keybindings-"));
		filePath = join(dir, "keybindings.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("is submit when the file doesn't exist", () => {
		expect(readEnterMode(filePath)).toEqual({ mode: "submit" });
	});

	it("is submit when the Chat block has no enter binding", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: [{ context: "Chat", bindings: { "ctrl+j": "chat:newline" } }] }));
		expect(readEnterMode(filePath)).toEqual({ mode: "submit" });
	});

	it("is submit when enter is bound to chat:submit", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: [{ context: "Chat", bindings: { enter: "chat:submit" } }] }));
		expect(readEnterMode(filePath)).toEqual({ mode: "submit" });
	});

	it("is newline when enter is bound to chat:newline", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: [{ context: "Chat", bindings: { enter: "chat:newline" } }] }));
		expect(readEnterMode(filePath)).toEqual({ mode: "newline" });
	});

	it("is custom (raw holds the literal binding) for anything else", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: [{ context: "Chat", bindings: { enter: "chat:clear" } }] }));
		expect(readEnterMode(filePath)).toEqual({ mode: "custom", raw: "enter → chat:clear" });
	});

	it("is submit when there's no Chat block at all", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: [{ context: "Other", bindings: { enter: "x" } }] }));
		expect(readEnterMode(filePath)).toEqual({ mode: "submit" });
	});

	it("is unreadable when the JSON is malformed", () => {
		writeFileSync(filePath, "{not json");
		expect(readEnterMode(filePath)).toEqual({ mode: "unreadable" });
	});

	it("is unreadable when bindings isn't an array", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: {} }));
		expect(readEnterMode(filePath)).toEqual({ mode: "unreadable" });
	});
});

describe("readChatBindings", () => {
	let dir: string;
	let filePath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-keybindings-"));
		filePath = join(dir, "keybindings.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns undefined when the file doesn't exist", () => {
		expect(readChatBindings(filePath)).toBeUndefined();
	});

	it("returns undefined when the JSON is malformed", () => {
		writeFileSync(filePath, "{not json");
		expect(readChatBindings(filePath)).toBeUndefined();
	});

	it("returns undefined when there's no Chat block", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: [{ context: "Other", bindings: { enter: "x" } }] }));
		expect(readChatBindings(filePath)).toBeUndefined();
	});

	it("returns the Chat block's raw key map unchanged (a real-world example)", () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				bindings: [{ context: "Chat", bindings: { enter: "chat:newline", "meta+enter": "chat:submit", "cmd+enter": "chat:submit" } }],
			})
		);
		expect(readChatBindings(filePath)).toEqual({
			enter: "chat:newline",
			"meta+enter": "chat:submit",
			"cmd+enter": "chat:submit",
		});
	});
});

describe("applySubmitKey", () => {
	let dir: string;
	let filePath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-keybindings-"));
		filePath = join(dir, "keybindings.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("for a non-enter key: creates the file if missing, writing both keys plus $schema/$docs", () => {
		const result = applySubmitKey(filePath, "cmd+enter");
		expect(result).toEqual({ status: "written", warning: undefined });

		const data = JSON.parse(readFileSync(filePath, "utf8"));
		expect(data.$schema).toBe("https://www.schemastore.org/claude-code-keybindings.json");
		expect(data.$docs).toBe("https://code.claude.com/docs/en/keybindings");
		const chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		expect(chat.bindings).toEqual({
			enter: "chat:newline",
			"meta+enter": "chat:submit",
		});
	});

	it("for enter: does nothing (doesn't create the file) if it's missing", () => {
		const result = applySubmitKey(filePath, "enter");
		expect(result).toEqual({ status: "unchanged" });
		expect(() => readFileSync(filePath, "utf8")).toThrow();
	});

	it("switching cmd+enter back to enter removes both keys, and the now-empty Chat block along with them", () => {
		applySubmitKey(filePath, "cmd+enter");
		const result = applySubmitKey(filePath, "enter");
		expect(result).toEqual({ status: "written", warning: undefined });

		const data = JSON.parse(readFileSync(filePath, "utf8"));
		expect(data.bindings.find((b: { context: string }) => b.context === "Chat")).toBeUndefined();
	});

	it("re-applying the same submit key is a no-op (status unchanged, nothing written)", () => {
		applySubmitKey(filePath, "ctrl+enter");
		const before = readFileSync(filePath, "utf8");
		const result = applySubmitKey(filePath, "ctrl+enter");
		expect(result).toEqual({ status: "unchanged" });
		expect(readFileSync(filePath, "utf8")).toBe(before);
	});

	it("leaves other contexts and other keys untouched", () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				bindings: [
					{ context: "Chat", bindings: { "ctrl+j": "chat:newline" } },
					{ context: "Other", bindings: { a: "b" } },
				],
			})
		);

		applySubmitKey(filePath, "cmd+enter");
		let data = JSON.parse(readFileSync(filePath, "utf8"));
		let chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		expect(chat.bindings["ctrl+j"]).toBe("chat:newline");
		expect(chat.bindings.enter).toBe("chat:newline");
		expect(data.bindings.find((b: { context: string }) => b.context === "Other").bindings).toEqual({ a: "b" });

		applySubmitKey(filePath, "enter");
		data = JSON.parse(readFileSync(filePath, "utf8"));
		chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		// ctrl+j wasn't added by us, so it survives; the Chat block survives too (it's not empty).
		expect(chat.bindings).toEqual({ "ctrl+j": "chat:newline" });
	});

	it("returns a warning and leaves mismatched keys alone instead of deleting them", () => {
		writeFileSync(
			filePath,
			JSON.stringify({ bindings: [{ context: "Chat", bindings: { enter: "chat:clear", "meta+enter": "chat:submit" } }] })
		);

		const result = applySubmitKey(filePath, "enter");
		expect(result.status).toBe("written");
		expect(result.warning).toContain("enter");
		const data = JSON.parse(readFileSync(filePath, "utf8"));
		const chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		// enter had an unexpected value, so it's left in place; meta+enter matched, so it's removed.
		expect(chat.bindings).toEqual({ enter: "chat:clear" });
	});

	it("warns about a mismatched value on any owned key, not just enter/meta+enter", () => {
		writeFileSync(
			filePath,
			JSON.stringify({ bindings: [{ context: "Chat", bindings: { "ctrl+enter": "chat:externalEditor" } }] })
		);
		const result = applySubmitKey(filePath, "enter");
		expect(result.warning).toContain("ctrl+enter");
		const data = JSON.parse(readFileSync(filePath, "utf8"));
		const chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		// Not ours (a different action entirely), so it's left in place.
		expect(chat.bindings).toEqual({ "ctrl+enter": "chat:externalEditor" });
	});

	it("doesn't write to malformed JSON, and returns status failed with a warning instead", () => {
		writeFileSync(filePath, "{not json");
		const result = applySubmitKey(filePath, "cmd+enter");
		expect(result.status).toBe("failed");
		expect(result.warning).toBeTruthy();
		expect(readFileSync(filePath, "utf8")).toBe("{not json");
	});

	it("writes the same two keys for every non-enter submit key (alt+enter, shift+enter, ctrl+enter)", () => {
		for (const submitKey of ["alt+enter", "shift+enter", "ctrl+enter"]) {
			applySubmitKey(filePath, submitKey);
			const data = JSON.parse(readFileSync(filePath, "utf8"));
			const chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
			expect(chat.bindings).toEqual({ enter: "chat:newline", "meta+enter": "chat:submit" });
			applySubmitKey(filePath, "enter");
		}
	});

	it("switching back to enter from a real-world shape (with cmd+enter added) removes every owned key", () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				bindings: [
					{ context: "Chat", bindings: { enter: "chat:newline", "meta+enter": "chat:submit", "cmd+enter": "chat:submit" } },
				],
			})
		);
		const result = applySubmitKey(filePath, "enter");
		expect(result).toEqual({ status: "written", warning: undefined });
		const data = JSON.parse(readFileSync(filePath, "utf8"));
		// Nothing left to remove leaves the Chat block itself removed too.
		expect(data.bindings.find((b: { context: string }) => b.context === "Chat")).toBeUndefined();
	});

	it("switching between two non-enter keys clears a stale alternate-submit binding left on a third key", () => {
		// A past version wrote shift+enter directly (D-41's predecessor); simulate that leftover.
		writeFileSync(
			filePath,
			JSON.stringify({
				bindings: [
					{ context: "Chat", bindings: { enter: "chat:newline", "shift+enter": "chat:submit" } },
				],
			})
		);
		const result = applySubmitKey(filePath, "ctrl+enter");
		expect(result).toEqual({ status: "written", warning: undefined });
		const data = JSON.parse(readFileSync(filePath, "utf8"));
		const chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		expect(chat.bindings).toEqual({ enter: "chat:newline", "meta+enter": "chat:submit" });
	});
});

describe("deriveSubmitKey", () => {
	it("a real-world {enter:chat:newline, meta+enter:chat:submit, cmd+enter:chat:submit} resolves to cmd+enter", () => {
		expect(
			deriveSubmitKey({ enter: "chat:newline", "meta+enter": "chat:submit", "cmd+enter": "chat:submit" })
		).toBe("cmd+enter");
	});

	it("super+enter also resolves to cmd+enter", () => {
		expect(deriveSubmitKey({ enter: "chat:newline", "super+enter": "chat:submit" })).toBe("cmd+enter");
	});

	it("{enter:chat:newline, meta+enter:chat:submit} resolves to alt+enter", () => {
		expect(deriveSubmitKey({ enter: "chat:newline", "meta+enter": "chat:submit" })).toBe("alt+enter");
	});

	it("empty, missing, or enter already bound to chat:submit all resolve to enter", () => {
		expect(deriveSubmitKey({})).toBe("enter");
		expect(deriveSubmitKey(undefined)).toBe("enter");
		expect(deriveSubmitKey({ enter: "chat:submit", "cmd+enter": "chat:submit" })).toBe("enter");
	});
});

describe("reconcileSubmitKey", () => {
	const newlineMode = { enter: "chat:newline", "meta+enter": "chat:submit" };

	it("keeps the configured value when the file has Enter=newline and the setting isn't enter (shift/ctrl can't be told apart from the file alone)", () => {
		expect(reconcileSubmitKey(newlineMode, "shift+enter")).toBe("shift+enter");
		expect(reconcileSubmitKey(newlineMode, "cmd+enter")).toBe("cmd+enter");
	});

	it("derives the value from the file when it has Enter=newline and the setting is enter", () => {
		expect(reconcileSubmitKey(newlineMode, "enter")).toBe("alt+enter");
		expect(reconcileSubmitKey({ ...newlineMode, "cmd+enter": "chat:submit" }, "enter")).toBe("cmd+enter");
	});

	it("resolves to enter when the file is at its default and the setting isn't enter", () => {
		expect(reconcileSubmitKey(undefined, "cmd+enter")).toBe("enter");
		expect(reconcileSubmitKey({}, "enter")).toBe("enter");
	});
});

/**
 * The full submit-key combination table (T-98's "組み合わせの総点検"), tying together every
 * piece that has to agree for a given `submitKey`: `applySubmitKey`'s effect on
 * `keybindings.json`'s `Chat` block, the PTY bytes `sendSequence` produces for submit/newline
 * (what `main.ts`'s `commandBytes`/`views/terminal.ts`'s `sendSubmit` actually send — both call
 * `sendSequence`/`submitSequence` directly, so there's nothing agent- or command-specific left to
 * check separately here), and the label/symbol shown in the settings dropdown, the built-in
 * editor's "send" button, and the statusLine (`ui.json`'s `submitSymbol`). This is Claude-only —
 * every other agent never touches `keybindings.json` at all and always sends plain `\r`
 * (`views/terminal.ts`'s `this.agent === "claude"` guard around all of §7.2's mechanics, and
 * `main.ts`'s `commandBytes`), so there's no agent dimension to cross here.
 */
describe("the submit-key combination table (submitKey × platform, Claude only)", () => {
	let dir: string;
	let filePath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-keybindings-"));
		filePath = join(dir, "keybindings.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const ROWS: Record<
		(typeof SUBMIT_KEYS)[number],
		{ chat: Record<string, string> | undefined; submit: string; newline: string; macSymbol: string }
	> = {
		enter: { chat: undefined, submit: "\r", newline: "\x1b\r", macSymbol: "⏎" },
		"shift+enter": { chat: { enter: "chat:newline", "meta+enter": "chat:submit" }, submit: "\x1b\r", newline: "\r", macSymbol: "⇧⏎" },
		"ctrl+enter": { chat: { enter: "chat:newline", "meta+enter": "chat:submit" }, submit: "\x1b\r", newline: "\r", macSymbol: "⌃⏎" },
		"alt+enter": { chat: { enter: "chat:newline", "meta+enter": "chat:submit" }, submit: "\x1b\r", newline: "\r", macSymbol: "⌥⏎" },
		"cmd+enter": { chat: { enter: "chat:newline", "meta+enter": "chat:submit" }, submit: "\x1b\r", newline: "\r", macSymbol: "⌘⏎" },
	};

	for (const submitKey of SUBMIT_KEYS) {
		const row = ROWS[submitKey];

		it(`${submitKey}: keybindings.json Chat block`, () => {
			applySubmitKey(filePath, submitKey);
			let chat: Record<string, string> | undefined;
			try {
				const data = JSON.parse(readFileSync(filePath, "utf8")) as {
					bindings?: { context: string; bindings?: Record<string, string> }[];
				};
				chat = data.bindings?.find((b) => b.context === "Chat")?.bindings;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					throw err;
				}
			}
			expect(chat).toEqual(row.chat);
		});

		it(`${submitKey}: PTY bytes (submit / newline)`, () => {
			expect(sendSequence("submit", submitKey)).toBe(row.submit);
			expect(sendSequence("newline", submitKey)).toBe(row.newline);
		});

		it(`${submitKey}: macOS label/symbol (dropdown, editor "send" button, statusLine)`, () => {
			expect(submitKeyButtonLabel(submitKey, true)).toBe(row.macSymbol);
			expect(submitKeyStatuslineSymbol(submitKey, true)).toBe(row.macSymbol);
		});
	}
});

describe("defaultKeybindingsPath", () => {
	it("falls under ~/.claude when CLAUDE_CONFIG_DIR isn't set", () => {
		expect(defaultKeybindingsPath("/Users/x")).toBe("/Users/x/.claude/keybindings.json");
	});

	it("falls under CLAUDE_CONFIG_DIR when it is set", () => {
		expect(defaultKeybindingsPath("/Users/x", "/custom/config")).toBe("/custom/config/keybindings.json");
	});
});

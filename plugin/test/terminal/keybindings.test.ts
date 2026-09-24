import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySubmitKey, defaultKeybindingsPath, readChatBindings, readEnterMode } from "../../src/terminal/keybindings";
import { deriveSubmitKey, reconcileSubmitKey } from "../../src/terminal/keys";

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
		expect(result).toEqual({});

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
		expect(result).toEqual({});
		expect(() => readFileSync(filePath, "utf8")).toThrow();
	});

	it("switching cmd+enter back to enter removes both keys, and the now-empty Chat block along with them", () => {
		applySubmitKey(filePath, "cmd+enter");
		const result = applySubmitKey(filePath, "enter");
		expect(result).toEqual({});

		const data = JSON.parse(readFileSync(filePath, "utf8"));
		expect(data.bindings.find((b: { context: string }) => b.context === "Chat")).toBeUndefined();
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
		expect(result.warning).toContain("enter");
		const data = JSON.parse(readFileSync(filePath, "utf8"));
		const chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		// enter had an unexpected value, so it's left in place; meta+enter matched, so it's removed.
		expect(chat.bindings).toEqual({ enter: "chat:clear" });
	});

	it("doesn't write to malformed JSON, and returns a warning instead", () => {
		writeFileSync(filePath, "{not json");
		const result = applySubmitKey(filePath, "cmd+enter");
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

	it("switching back to enter from a real-world shape (with cmd+enter added) removes only our own two keys", () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				bindings: [
					{ context: "Chat", bindings: { enter: "chat:newline", "meta+enter": "chat:submit", "cmd+enter": "chat:submit" } },
				],
			})
		);
		applySubmitKey(filePath, "enter");
		const data = JSON.parse(readFileSync(filePath, "utf8"));
		const chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		expect(chat.bindings).toEqual({ "cmd+enter": "chat:submit" });
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

describe("defaultKeybindingsPath", () => {
	it("falls under ~/.claude when CLAUDE_CONFIG_DIR isn't set", () => {
		expect(defaultKeybindingsPath("/Users/x")).toBe("/Users/x/.claude/keybindings.json");
	});

	it("falls under CLAUDE_CONFIG_DIR when it is set", () => {
		expect(defaultKeybindingsPath("/Users/x", "/custom/config")).toBe("/custom/config/keybindings.json");
	});
});

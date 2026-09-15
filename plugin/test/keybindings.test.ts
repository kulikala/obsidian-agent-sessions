import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultKeybindingsPath, readEnterMode, setEnterMode } from "../src/keybindings";

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

	it("ファイルが無ければ submit", () => {
		expect(readEnterMode(filePath)).toEqual({ mode: "submit" });
	});

	it("Chat の enter が無ければ submit", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: [{ context: "Chat", bindings: { "ctrl+j": "chat:newline" } }] }));
		expect(readEnterMode(filePath)).toEqual({ mode: "submit" });
	});

	it("enter が chat:submit なら submit", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: [{ context: "Chat", bindings: { enter: "chat:submit" } }] }));
		expect(readEnterMode(filePath)).toEqual({ mode: "submit" });
	});

	it("enter が chat:newline なら newline", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: [{ context: "Chat", bindings: { enter: "chat:newline" } }] }));
		expect(readEnterMode(filePath)).toEqual({ mode: "newline" });
	});

	it("enter がそれ以外なら custom（raw に生値）", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: [{ context: "Chat", bindings: { enter: "chat:clear" } }] }));
		expect(readEnterMode(filePath)).toEqual({ mode: "custom", raw: "enter → chat:clear" });
	});

	it("Chat ブロックが無ければ submit", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: [{ context: "Other", bindings: { enter: "x" } }] }));
		expect(readEnterMode(filePath)).toEqual({ mode: "submit" });
	});

	it("JSON が壊れていれば unreadable", () => {
		writeFileSync(filePath, "{not json");
		expect(readEnterMode(filePath)).toEqual({ mode: "unreadable" });
	});

	it("bindings が配列でなければ unreadable", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: {} }));
		expect(readEnterMode(filePath)).toEqual({ mode: "unreadable" });
	});
});

describe("setEnterMode", () => {
	let dir: string;
	let filePath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-keybindings-"));
		filePath = join(dir, "keybindings.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("newline：ファイルが無ければ作り、3 鍵と $schema/$docs を入れる", () => {
		const result = setEnterMode(filePath, "newline");
		expect(result).toEqual({});

		const data = JSON.parse(readFileSync(filePath, "utf8"));
		expect(data.$schema).toBe("https://www.schemastore.org/claude-code-keybindings.json");
		expect(data.$docs).toBe("https://code.claude.com/docs/en/keybindings");
		const chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		expect(chat.bindings).toEqual({
			enter: "chat:newline",
			"shift+enter": "chat:submit",
			"meta+enter": "chat:submit",
		});
	});

	it("submit：ファイルが無ければ何もしない（作らない）", () => {
		const result = setEnterMode(filePath, "submit");
		expect(result).toEqual({});
		expect(() => readFileSync(filePath, "utf8")).toThrow();
	});

	it("newline → submit で 3 鍵が消え、空になった Chat ブロックごと消える", () => {
		setEnterMode(filePath, "newline");
		const result = setEnterMode(filePath, "submit");
		expect(result).toEqual({});

		const data = JSON.parse(readFileSync(filePath, "utf8"));
		expect(data.bindings.find((b: { context: string }) => b.context === "Chat")).toBeUndefined();
	});

	it("他のコンテキスト・他の鍵は触らない", () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				bindings: [
					{ context: "Chat", bindings: { "ctrl+j": "chat:newline" } },
					{ context: "Other", bindings: { a: "b" } },
				],
			})
		);

		setEnterMode(filePath, "newline");
		let data = JSON.parse(readFileSync(filePath, "utf8"));
		let chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		expect(chat.bindings["ctrl+j"]).toBe("chat:newline");
		expect(chat.bindings.enter).toBe("chat:newline");
		expect(data.bindings.find((b: { context: string }) => b.context === "Other").bindings).toEqual({ a: "b" });

		setEnterMode(filePath, "submit");
		data = JSON.parse(readFileSync(filePath, "utf8"));
		chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		// 自分で足していない ctrl+j は残る。Chat ブロックも残る（空でないので）。
		expect(chat.bindings).toEqual({ "ctrl+j": "chat:newline" });
	});

	it("一致しない値の鍵は消さずに warning を返す", () => {
		writeFileSync(
			filePath,
			JSON.stringify({ bindings: [{ context: "Chat", bindings: { enter: "chat:clear", "shift+enter": "chat:submit" } }] })
		);

		const result = setEnterMode(filePath, "submit");
		expect(result.warning).toContain("enter");
		const data = JSON.parse(readFileSync(filePath, "utf8"));
		const chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		// enter は想定と違う値だったので残る。shift+enter は一致したので消える。
		expect(chat.bindings).toEqual({ enter: "chat:clear" });
	});

	it("壊れた JSON には書かず warning を返す", () => {
		writeFileSync(filePath, "{not json");
		const result = setEnterMode(filePath, "newline");
		expect(result.warning).toBeTruthy();
		expect(readFileSync(filePath, "utf8")).toBe("{not json");
	});
});

describe("defaultKeybindingsPath", () => {
	it("CLAUDE_CONFIG_DIR が無ければ ~/.claude 配下", () => {
		expect(defaultKeybindingsPath("/Users/x")).toBe("/Users/x/.claude/keybindings.json");
	});

	it("CLAUDE_CONFIG_DIR があればその配下", () => {
		expect(defaultKeybindingsPath("/Users/x", "/custom/config")).toBe("/custom/config/keybindings.json");
	});
});

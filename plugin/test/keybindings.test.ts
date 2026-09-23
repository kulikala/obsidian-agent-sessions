import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySubmitKey, defaultKeybindingsPath, readChatBindings, readEnterMode } from "../src/keybindings";
import { deriveSubmitKey, reconcileSubmitKey } from "../src/keys";

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

	it("ファイルが無ければ undefined", () => {
		expect(readChatBindings(filePath)).toBeUndefined();
	});

	it("JSON が壊れていれば undefined", () => {
		writeFileSync(filePath, "{not json");
		expect(readChatBindings(filePath)).toBeUndefined();
	});

	it("Chat ブロックが無ければ undefined", () => {
		writeFileSync(filePath, JSON.stringify({ bindings: [{ context: "Other", bindings: { enter: "x" } }] }));
		expect(readChatBindings(filePath)).toBeUndefined();
	});

	it("Chat の生の鍵一覧をそのまま返す（実機の例）", () => {
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

	it("enter 以外：ファイルが無ければ作り、2 鍵と $schema/$docs を入れる", () => {
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

	it("enter：ファイルが無ければ何もしない（作らない）", () => {
		const result = applySubmitKey(filePath, "enter");
		expect(result).toEqual({});
		expect(() => readFileSync(filePath, "utf8")).toThrow();
	});

	it("cmd+enter → enter で 2 鍵が消え、空になった Chat ブロックごと消える", () => {
		applySubmitKey(filePath, "cmd+enter");
		const result = applySubmitKey(filePath, "enter");
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

		applySubmitKey(filePath, "cmd+enter");
		let data = JSON.parse(readFileSync(filePath, "utf8"));
		let chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		expect(chat.bindings["ctrl+j"]).toBe("chat:newline");
		expect(chat.bindings.enter).toBe("chat:newline");
		expect(data.bindings.find((b: { context: string }) => b.context === "Other").bindings).toEqual({ a: "b" });

		applySubmitKey(filePath, "enter");
		data = JSON.parse(readFileSync(filePath, "utf8"));
		chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		// 自分で足していない ctrl+j は残る。Chat ブロックも残る（空でないので）。
		expect(chat.bindings).toEqual({ "ctrl+j": "chat:newline" });
	});

	it("一致しない値の鍵は消さずに warning を返す", () => {
		writeFileSync(
			filePath,
			JSON.stringify({ bindings: [{ context: "Chat", bindings: { enter: "chat:clear", "meta+enter": "chat:submit" } }] })
		);

		const result = applySubmitKey(filePath, "enter");
		expect(result.warning).toContain("enter");
		const data = JSON.parse(readFileSync(filePath, "utf8"));
		const chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
		// enter は想定と違う値だったので残る。meta+enter は一致したので消える。
		expect(chat.bindings).toEqual({ enter: "chat:clear" });
	});

	it("壊れた JSON には書かず warning を返す", () => {
		writeFileSync(filePath, "{not json");
		const result = applySubmitKey(filePath, "cmd+enter");
		expect(result.warning).toBeTruthy();
		expect(readFileSync(filePath, "utf8")).toBe("{not json");
	});

	it("enter 以外の送信キーはどれも同じ 2 鍵を書く（alt+enter・shift+enter・ctrl+enter）", () => {
		for (const submitKey of ["alt+enter", "shift+enter", "ctrl+enter"]) {
			applySubmitKey(filePath, submitKey);
			const data = JSON.parse(readFileSync(filePath, "utf8"));
			const chat = data.bindings.find((b: { context: string }) => b.context === "Chat");
			expect(chat.bindings).toEqual({ enter: "chat:newline", "meta+enter": "chat:submit" });
			applySubmitKey(filePath, "enter");
		}
	});

	it("enter へ戻すと、実機と同じ形（cmd+enter を足したもの）から自分の 2 鍵だけ消える", () => {
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

describe("deriveSubmitKey（D-50）", () => {
	it("実機の {enter:chat:newline, meta+enter:chat:submit, cmd+enter:chat:submit} → cmd+enter", () => {
		expect(
			deriveSubmitKey({ enter: "chat:newline", "meta+enter": "chat:submit", "cmd+enter": "chat:submit" })
		).toBe("cmd+enter");
	});

	it("super+enter でも cmd+enter", () => {
		expect(deriveSubmitKey({ enter: "chat:newline", "super+enter": "chat:submit" })).toBe("cmd+enter");
	});

	it("{enter:chat:newline, meta+enter:chat:submit} → alt+enter", () => {
		expect(deriveSubmitKey({ enter: "chat:newline", "meta+enter": "chat:submit" })).toBe("alt+enter");
	});

	it("空・無し・enter が chat:submit → enter", () => {
		expect(deriveSubmitKey({})).toBe("enter");
		expect(deriveSubmitKey(undefined)).toBe("enter");
		expect(deriveSubmitKey({ enter: "chat:submit", "cmd+enter": "chat:submit" })).toBe("enter");
	});
});

describe("reconcileSubmitKey（D-50）", () => {
	const newlineMode = { enter: "chat:newline", "meta+enter": "chat:submit" };

	it("ファイルが Enter＝改行で設定も enter 以外なら、設定を保つ（shift/ctrl はファイルから区別できない）", () => {
		expect(reconcileSubmitKey(newlineMode, "shift+enter")).toBe("shift+enter");
		expect(reconcileSubmitKey(newlineMode, "cmd+enter")).toBe("cmd+enter");
	});

	it("ファイルが Enter＝改行で設定が enter なら、導いた値", () => {
		expect(reconcileSubmitKey(newlineMode, "enter")).toBe("alt+enter");
		expect(reconcileSubmitKey({ ...newlineMode, "cmd+enter": "chat:submit" }, "enter")).toBe("cmd+enter");
	});

	it("ファイルが既定で設定が enter 以外なら enter", () => {
		expect(reconcileSubmitKey(undefined, "cmd+enter")).toBe("enter");
		expect(reconcileSubmitKey({}, "enter")).toBe("enter");
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

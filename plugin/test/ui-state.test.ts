import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeUiState } from "../src/ui-state";

describe("writeUiState", () => {
	let dir: string;
	let runtimeDir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-ui-state-"));
		runtimeDir = join(dir, "sessions");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("submitKey と対応する記号を ui.json に書く", () => {
		writeUiState(runtimeDir, "cmd+enter");
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data).toEqual({ submitKey: "cmd+enter", submitSymbol: "⌘⏎" });
	});

	it("enter は ⏎", () => {
		writeUiState(runtimeDir, "enter");
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data.submitSymbol).toBe("⏎");
	});

	it("ディレクトリが無ければ作る", () => {
		expect(existsSync(runtimeDir)).toBe(false);
		writeUiState(runtimeDir, "shift+enter");
		expect(existsSync(join(runtimeDir, "ui.json"))).toBe(true);
	});

	it("tmp ファイルを残さない", () => {
		writeUiState(runtimeDir, "ctrl+enter");
		const files = readdirSync(runtimeDir);
		expect(files).toEqual(["ui.json"]);
	});

	it("書き直すと上書きされる", () => {
		writeUiState(runtimeDir, "enter");
		writeUiState(runtimeDir, "alt+enter");
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data).toEqual({ submitKey: "alt+enter", submitSymbol: "⌥⏎" });
	});
});

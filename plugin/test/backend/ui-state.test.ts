import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeUiState } from "../../src/backend/ui-state";

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

	it("writes submitKey and its matching symbol to ui.json", () => {
		writeUiState(runtimeDir, "cmd+enter", "ja");
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data).toEqual({ submitKey: "cmd+enter", submitSymbol: "⌘⏎", language: "ja" });
	});

	it("maps enter to ⏎", () => {
		writeUiState(runtimeDir, "enter", "ja");
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data.submitSymbol).toBe("⏎");
	});

	it("creates the directory if it doesn't exist", () => {
		expect(existsSync(runtimeDir)).toBe(false);
		writeUiState(runtimeDir, "shift+enter", "ja");
		expect(existsSync(join(runtimeDir, "ui.json"))).toBe(true);
	});

	it("doesn't leave a tmp file behind", () => {
		writeUiState(runtimeDir, "ctrl+enter", "ja");
		const files = readdirSync(runtimeDir);
		expect(files).toEqual(["ui.json"]);
	});

	it("overwrites the file when written again", () => {
		writeUiState(runtimeDir, "enter", "ja");
		writeUiState(runtimeDir, "alt+enter", "ja");
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data).toEqual({ submitKey: "alt+enter", submitSymbol: "⌥⏎", language: "ja" });
	});

	it("uses short text symbols on non-macOS (for the status line)", () => {
		writeUiState(runtimeDir, "ctrl+enter", "ja", false);
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data).toEqual({ submitKey: "ctrl+enter", submitSymbol: "C-⏎", language: "ja" });
	});

	it("still maps non-macOS enter to the same ⏎ as macOS", () => {
		writeUiState(runtimeDir, "enter", "ja", false);
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data.submitSymbol).toBe("⏎");
	});

	it("writes the resolved display language", () => {
		writeUiState(runtimeDir, "enter", "en");
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data.language).toBe("en");
	});
});

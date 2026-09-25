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
		writeUiState(runtimeDir, "cmd+enter", "ja", ["claude"]);
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data).toEqual({ submitKey: "cmd+enter", submitSymbol: "⌘⏎", language: "ja", agents: ["claude"] });
	});

	it("maps enter to ⏎", () => {
		writeUiState(runtimeDir, "enter", "ja", ["claude"]);
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data.submitSymbol).toBe("⏎");
	});

	it("creates the directory if it doesn't exist", () => {
		expect(existsSync(runtimeDir)).toBe(false);
		writeUiState(runtimeDir, "shift+enter", "ja", ["claude"]);
		expect(existsSync(join(runtimeDir, "ui.json"))).toBe(true);
	});

	it("doesn't leave a tmp file behind", () => {
		writeUiState(runtimeDir, "ctrl+enter", "ja", ["claude"]);
		const files = readdirSync(runtimeDir);
		expect(files).toEqual(["ui.json"]);
	});

	it("overwrites the file when written again", () => {
		writeUiState(runtimeDir, "enter", "ja", ["claude"]);
		writeUiState(runtimeDir, "alt+enter", "ja", ["claude"]);
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data).toEqual({ submitKey: "alt+enter", submitSymbol: "⌥⏎", language: "ja", agents: ["claude"] });
	});

	it("uses short text symbols on non-macOS (for the status line)", () => {
		writeUiState(runtimeDir, "ctrl+enter", "ja", ["claude"], false);
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data).toEqual({ submitKey: "ctrl+enter", submitSymbol: "C-⏎", language: "ja", agents: ["claude"] });
	});

	it("still maps non-macOS enter to the same ⏎ as macOS", () => {
		writeUiState(runtimeDir, "enter", "ja", ["claude"], false);
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data.submitSymbol).toBe("⏎");
	});

	it("writes the resolved display language", () => {
		writeUiState(runtimeDir, "enter", "en", ["claude"]);
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data.language).toBe("en");
	});

	it("writes the enabled agent ids, in the order given", () => {
		writeUiState(runtimeDir, "enter", "en", ["claude", "codex"]);
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data.agents).toEqual(["claude", "codex"]);
	});

	it("writes an empty array when no agent is enabled (shouldn't normally happen — at least one is always on)", () => {
		writeUiState(runtimeDir, "enter", "en", []);
		const data = JSON.parse(readFileSync(join(runtimeDir, "ui.json"), "utf8"));
		expect(data.agents).toEqual([]);
	});
});

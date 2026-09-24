import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeSettingsPath, isFullscreenTui, readFullscreenTui } from "../../src/terminal/tui-mode";

describe("isFullscreenTui", () => {
	it("is true when tui is fullscreen", () => {
		expect(isFullscreenTui('{"tui": "fullscreen", "model": "opus"}')).toBe(true);
	});

	it("is false when tui is missing, holds another value, the JSON is malformed, or there's no file", () => {
		expect(isFullscreenTui('{"model": "opus"}')).toBe(false);
		expect(isFullscreenTui('{"tui": "default"}')).toBe(false);
		expect(isFullscreenTui("{oops")).toBe(false);
		expect(isFullscreenTui("[]")).toBe(false);
		expect(isFullscreenTui(null)).toBe(false);
	});
});

describe("claudeSettingsPath / readFullscreenTui", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-tui-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("resolves under CLAUDE_CONFIG_DIR when set, otherwise under ~/.claude", () => {
		expect(claudeSettingsPath("/home/u")).toBe("/home/u/.claude/settings.json");
		expect(claudeSettingsPath("/home/u", "/cfg")).toBe("/cfg/settings.json");
	});

	it("reads the value from the file, or false if it doesn't exist", () => {
		const p = join(dir, "settings.json");
		expect(readFullscreenTui(p)).toBe(false);
		writeFileSync(p, '{"tui":"fullscreen"}', "utf8");
		expect(readFullscreenTui(p)).toBe(true);
	});
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeSettingsPath, isFullscreenTui, readFullscreenTui } from "../src/tui-mode";

describe("isFullscreenTui（D-42）", () => {
	it("tui が fullscreen なら true", () => {
		expect(isFullscreenTui('{"tui": "fullscreen", "model": "opus"}')).toBe(true);
	});

	it("tui が無い・別の値・壊れた JSON・無いファイルは false", () => {
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

	it("CLAUDE_CONFIG_DIR があればその下、無ければ ~/.claude", () => {
		expect(claudeSettingsPath("/home/u")).toBe("/home/u/.claude/settings.json");
		expect(claudeSettingsPath("/home/u", "/cfg")).toBe("/cfg/settings.json");
	});

	it("ファイルから読む。無ければ false", () => {
		const p = join(dir, "settings.json");
		expect(readFullscreenTui(p)).toBe(false);
		writeFileSync(p, '{"tui":"fullscreen"}', "utf8");
		expect(readFullscreenTui(p)).toBe(true);
	});
});

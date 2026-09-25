import { describe, expect, it } from "vitest";
import {
	asAgentId,
	DEFAULT_SETTINGS,
	defaultFontFamily,
	mergeSettings,
	parseEnvLines,
	SUBMIT_KEYS_NON_MAC,
} from "../src/settings";

describe("DEFAULT_SETTINGS", () => {
	it("has the expected default values", () => {
		expect(DEFAULT_SETTINGS).toEqual({
			fontFamily: 'Menlo, "Hiragino Sans", monospace',
			fontSize: 13,
			padding: "comfortable",
			recentCount: 10,
			notifyOnIdle: true,
			agents: {
				claude: { enabled: true, path: "", env: "" },
				codex: { enabled: false, path: "", env: "" },
			},
			lastNewSessionAgent: "claude",
			agentSessionsPath: "",
			scrollback: 5000,
			editorHeight: 40,
			submitKey: "enter",
			sideDetailHeight: 220,
			language: "auto",
			managerAnalysisHeight: 240,
			managerAnalysisCollapsed: false,
			managerStatusFilter: "all",
		});
	});
});

describe("mergeSettings", () => {
	it("drops the removed newlineKey and an old submitKey value no longer in the current type", () => {
		const merged = mergeSettings({ newlineKey: "enter", submitKey: "super+enter", fontSize: 15 });
		expect(merged).not.toHaveProperty("newlineKey");
		expect(merged.submitKey).toBe("enter");
		expect(merged.fontSize).toBe(15);
	});

	it("keeps a submitKey value that's in the current type", () => {
		expect(mergeSettings({ submitKey: "cmd+enter" }).submitKey).toBe("cmd+enter");
	});

	it("keeps a managerStatusFilter value that's a registered filter", () => {
		expect(mergeSettings({ managerStatusFilter: "running" }).managerStatusFilter).toBe("running");
	});

	it("drops an unrecognized managerStatusFilter value, falling back to the default (all)", () => {
		expect(mergeSettings({ managerStatusFilter: "needs-something" }).managerStatusFilter).toBe("all");
	});

	it("falls back to defaults when there's no saved data", () => {
		expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});
});

describe("mergeSettings (agents)", () => {
	it("migrates a pre-T-96 top-level claudePath into agents.claude.path, once", () => {
		const merged = mergeSettings({ claudePath: "/usr/local/bin/claude" });
		expect(merged.agents.claude.path).toBe("/usr/local/bin/claude");
		expect(merged.agents.claude.enabled).toBe(true);
		expect(merged.agents.codex).toEqual({ enabled: false, path: "", env: "" });
		expect(merged).not.toHaveProperty("claudePath");
	});

	it("does not migrate claudePath once agents has already been saved (migrates only once)", () => {
		const merged = mergeSettings({
			claudePath: "/usr/local/bin/claude",
			agents: { claude: { enabled: false, path: "/opt/claude", env: "" }, codex: { enabled: true, path: "", env: "" } },
		});
		expect(merged.agents.claude.path).toBe("/opt/claude");
		expect(merged.agents.claude.enabled).toBe(false);
	});

	it("keeps a saved agents object as-is when every field is valid", () => {
		const saved = {
			claude: { enabled: false, path: "/x/claude", env: "FOO=1" },
			codex: { enabled: true, path: "/x/codex", env: "CODEX_HOME=/x" },
		};
		expect(mergeSettings({ agents: saved }).agents).toEqual(saved);
	});

	it("falls back field-by-field when a saved agent entry has an invalid field, keeping the rest", () => {
		const merged = mergeSettings({
			agents: { claude: { enabled: "yes", path: "/x/claude", env: 42 }, codex: null },
		});
		// enabled/env were invalid types -> default; path (valid) survives.
		expect(merged.agents.claude).toEqual({ enabled: true, path: "/x/claude", env: "" });
		// codex wasn't an object at all -> the whole entry falls back to default.
		expect(merged.agents.codex).toEqual({ enabled: false, path: "", env: "" });
	});

	it("falls back to defaults entirely when agents isn't an object", () => {
		expect(mergeSettings({ agents: "nope" }).agents).toEqual(DEFAULT_SETTINGS.agents);
	});

	it("keeps a valid lastNewSessionAgent", () => {
		expect(mergeSettings({ lastNewSessionAgent: "codex" }).lastNewSessionAgent).toBe("codex");
	});

	it("drops an unrecognized lastNewSessionAgent, falling back to the default (claude)", () => {
		expect(mergeSettings({ lastNewSessionAgent: "gemini" }).lastNewSessionAgent).toBe("claude");
	});
});

describe("parseEnvLines", () => {
	it("parses KEY=VALUE lines into an object", () => {
		expect(parseEnvLines("FOO=1\nBAR=two")).toEqual({ FOO: "1", BAR: "two" });
	});

	it("skips blank lines and lines starting with #", () => {
		expect(parseEnvLines("FOO=1\n\n# a comment\nBAR=2")).toEqual({ FOO: "1", BAR: "2" });
	});

	it("skips a line with no = (not treated as an empty-value key)", () => {
		expect(parseEnvLines("FOO=1\nNOTANASSIGNMENT\nBAR=2")).toEqual({ FOO: "1", BAR: "2" });
	});

	it("trims whitespace around the key and value", () => {
		expect(parseEnvLines("  FOO = 1  ")).toEqual({ FOO: "1" });
	});

	it("allows = inside the value (splits on the first = only)", () => {
		expect(parseEnvLines("FOO=a=b=c")).toEqual({ FOO: "a=b=c" });
	});

	it("returns an empty object for an empty string", () => {
		expect(parseEnvLines("")).toEqual({});
	});
});

describe("asAgentId", () => {
	it("passes through known agent ids", () => {
		expect(asAgentId("claude")).toBe("claude");
		expect(asAgentId("codex")).toBe("codex");
	});

	it("falls back to claude for anything else", () => {
		expect(asAgentId("")).toBe("claude");
		expect(asAgentId("gemini")).toBe("claude");
	});
});

describe("mergeSettings (non-macOS support)", () => {
	it("uses the non-macOS default font on a fresh non-macOS install (no saved data)", () => {
		expect(mergeSettings(null, false).fontFamily).toBe(defaultFontFamily(false));
	});

	it("does not change fontFamily on non-macOS when one is already saved (keeps the value saved on macOS)", () => {
		const merged = mergeSettings({ fontFamily: 'Menlo, "Hiragino Sans", monospace' }, false);
		expect(merged.fontFamily).toBe('Menlo, "Hiragino Sans", monospace');
	});

	it("drops cmd+enter on non-macOS and falls back to the default (enter)", () => {
		expect(mergeSettings({ submitKey: "cmd+enter" }, false).submitKey).toBe("enter");
	});

	it("keeps cmd+enter on macOS (the default call)", () => {
		expect(mergeSettings({ submitKey: "cmd+enter" }).submitKey).toBe("cmd+enter");
	});
});

describe("defaultFontFamily (non-macOS support; Menlo isn't available on Linux)", () => {
	it("is Menlo on macOS", () => {
		expect(defaultFontFamily(true)).toBe('Menlo, "Hiragino Sans", monospace');
	});

	it("is a font with matching CJK widths on non-macOS", () => {
		expect(defaultFontFamily(false)).toBe('"DejaVu Sans Mono", "Noto Sans Mono CJK JP", monospace');
	});
});

describe("SUBMIT_KEYS_NON_MAC", () => {
	it("does not include cmd+enter", () => {
		expect(SUBMIT_KEYS_NON_MAC).toEqual(["enter", "shift+enter", "ctrl+enter", "alt+enter"]);
	});
});

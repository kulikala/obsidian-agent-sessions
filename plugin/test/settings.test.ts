import { describe, expect, it } from "vitest";
import {
	agentConfigDue,
	submitKeyOptionLabel,
	agentsWithLimits,
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
				opencode: { enabled: false, path: "", env: "", launchVia: "opencode", ollamaModel: "" },
			},
			lastNewSessionAgent: "claude",
			agentSessionsPath: "",
			scrollback: 5000,
			editorHeight: 40,
			submitKey: "enter",
			editorKey: "ctrl+g",
			sideDetailHeight: 220,
			language: "auto",
			managerAnalysisHeight: 240,
			managerAnalysisCollapsed: false,
			managerAnalysisFolded: { claude: false, codex: false, opencode: false },
			managerStatusFilter: "all",
			organizeModel: "sonnet",
			efficiencyThreshold: 80,
			efficiencyBudget: 10_000_000,
			efficiencyModel: "sonnet",
			activityMode: "session",
			activityGapMinutes: 30,
			activityHiddenAgents: [],
			activityDetailWidth: 38,
			agentSkillsStamp: "",
			agentConfigApplied: [],
			onboardingShownVersion: "",
			onboardingOnUpdate: true,
			onboardingProgress: null,
			onboardingImages: true,
			rcServerEnabled: false,
		});
	});
});

describe("mergeSettings", () => {
	it("ignores the old installAgentSkills setting and keeps the skill stamp only as a string", () => {
		expect(mergeSettings({ installAgentSkills: true })).not.toHaveProperty("installAgentSkills");
		expect(mergeSettings({ installAgentSkills: false })).not.toHaveProperty("installAgentSkills");
		expect(mergeSettings({ agentSkillsStamp: "x" }).agentSkillsStamp).toBe("x");
		expect(mergeSettings({ agentSkillsStamp: 3 }).agentSkillsStamp).toBe("");
		expect(mergeSettings({}).agentSkillsStamp).toBe("");
		expect(mergeSettings({ onboardingShownVersion: "0.4.0", onboardingOnUpdate: false })).toMatchObject({
			onboardingShownVersion: "0.4.0",
			onboardingOnUpdate: false,
		});
		expect(mergeSettings({ onboardingShownVersion: 4, onboardingOnUpdate: "no" })).toMatchObject({
			onboardingShownVersion: "",
			onboardingOnUpdate: true,
		});
	});

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

	it("keeps token efficiency settings in range and drops the rest", () => {
		const ok = mergeSettings({ efficiencyThreshold: 90, efficiencyBudget: 5_000_000, efficiencyModel: "opus" });
		expect([ok.efficiencyThreshold, ok.efficiencyBudget, ok.efficiencyModel]).toEqual([90, 5_000_000, "opus"]);
		for (const bad of [
			{ efficiencyThreshold: 49, efficiencyBudget: 999_999, efficiencyModel: "haiku" },
			{ efficiencyThreshold: 96, efficiencyBudget: 100_000_001, efficiencyModel: 3 },
			{ efficiencyThreshold: "80", efficiencyBudget: Number.NaN, efficiencyModel: null },
		]) {
			const s = mergeSettings(bad);
			expect([s.efficiencyThreshold, s.efficiencyBudget, s.efficiencyModel]).toEqual([80, 10_000_000, "sonnet"]);
		}
		const edges = mergeSettings({ efficiencyThreshold: 50, efficiencyBudget: 100_000_000 });
		expect([edges.efficiencyThreshold, edges.efficiencyBudget]).toEqual([50, 100_000_000]);
	});

	it("keeps a known organizeModel and drops an unknown one", () => {
		expect(mergeSettings({ organizeModel: "haiku" }).organizeModel).toBe("haiku");
		expect(mergeSettings({ organizeModel: "opus" }).organizeModel).toBe("sonnet");
	});

	it("keeps a known activityMode and drops an unknown one", () => {
		expect(mergeSettings({ activityMode: "day" }).activityMode).toBe("day");
		expect(mergeSettings({ activityMode: "month" }).activityMode).toBe("session");
	});

	it("keeps a known activity join gap and drops an unknown one", () => {
		expect(mergeSettings({ activityGapMinutes: 60 }).activityGapMinutes).toBe(60);
		expect(mergeSettings({ activityGapMinutes: 45 }).activityGapMinutes).toBe(30);
	});

	it("keeps valid activity calendar choices and drops invalid ones", () => {
		expect(mergeSettings({ activityHiddenAgents: ["codex"], activityDetailWidth: 50 })).toMatchObject({
			activityHiddenAgents: ["codex"],
			activityDetailWidth: 50,
		});
		expect(mergeSettings({ activityHiddenAgents: [1], activityDetailWidth: 5 })).toMatchObject({
			activityHiddenAgents: [],
			activityDetailWidth: 38,
		});
	});

	it("drops an unrecognized managerStatusFilter value, falling back to the default (all)", () => {
		expect(mergeSettings({ managerStatusFilter: "needs-something" }).managerStatusFilter).toBe("all");
	});

	it("falls back to defaults when there's no saved data", () => {
		expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});
});

describe("mergeSettings (agents)", () => {
	it("migrates an old top-level claudePath into agents.claude.path, once", () => {
		const merged = mergeSettings({ claudePath: "/usr/local/bin/claude" });
		expect(merged.agents.claude.path).toBe("/usr/local/bin/claude");
		expect(merged.agents.claude.enabled).toBe(true);
		expect(merged.agents.codex).toEqual({ enabled: false, path: "", env: "" });
		expect(merged.agents.opencode).toEqual({ enabled: false, path: "", env: "", launchVia: "opencode", ollamaModel: "" });
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
			opencode: { enabled: true, path: "/x/opencode", env: "", launchVia: "ollama", ollamaModel: "gpt-oss:20b" },
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

	it("normalises OpenCode's launch settings: an unknown launchVia falls back, the model is trimmed", () => {
		const merged = mergeSettings({
			agents: { opencode: { enabled: true, path: "", env: "", launchVia: "docker", ollamaModel: "  gpt-oss:20b " } },
		});
		expect(merged.agents.opencode.launchVia).toBe("opencode");
		expect(merged.agents.opencode.ollamaModel).toBe("gpt-oss:20b");
		const bad = mergeSettings({ agents: { opencode: { enabled: true, launchVia: 7, ollamaModel: 3 } } });
		expect(bad.agents.opencode).toEqual({ enabled: true, path: "", env: "", launchVia: "opencode", ollamaModel: "" });
	});

	it("doesn't add launch settings to the other agents", () => {
		const merged = mergeSettings({ agents: { claude: { launchVia: "ollama" } } });
		expect(merged.agents.claude).not.toHaveProperty("launchVia");
		expect(merged.agents.codex).not.toHaveProperty("ollamaModel");
	});

	it("keeps a valid lastNewSessionAgent", () => {
		expect(mergeSettings({ lastNewSessionAgent: "codex" }).lastNewSessionAgent).toBe("codex");
		expect(mergeSettings({ lastNewSessionAgent: "opencode" }).lastNewSessionAgent).toBe("opencode");
	});

	it("drops an unrecognized lastNewSessionAgent, falling back to the default (claude)", () => {
		expect(mergeSettings({ lastNewSessionAgent: "gemini" }).lastNewSessionAgent).toBe("claude");
	});
});

describe("mergeSettings (managerAnalysisFolded)", () => {
	it("keeps a saved value as-is when every agent's entry is a valid boolean", () => {
		expect(mergeSettings({ managerAnalysisFolded: { claude: true, codex: false } }).managerAnalysisFolded).toEqual({
			claude: true,
			codex: false,
			opencode: false,
		});
	});

	it("falls back to unfolded, per agent, for an invalid or missing entry", () => {
		expect(mergeSettings({ managerAnalysisFolded: { claude: "yes" } }).managerAnalysisFolded).toEqual({
			claude: false,
			codex: false,
			opencode: false,
		});
	});

	it("falls back to defaults entirely when managerAnalysisFolded isn't an object", () => {
		expect(mergeSettings({ managerAnalysisFolded: "nope" }).managerAnalysisFolded).toEqual({
			claude: false,
			codex: false,
			opencode: false,
		});
	});

	it("defaults to unfolded when there's no saved data at all", () => {
		expect(mergeSettings(null).managerAnalysisFolded).toEqual({ claude: false, codex: false, opencode: false });
	});
});

describe("mergeSettings (onboarding)", () => {
	const saved = {
		version: 1,
		mode: "first",
		steps: ["language", "about"],
		current: 1,
		states: { language: "done" },
		sessionId: "s1",
	};

	it("keeps saved progress that is a well-formed record", () => {
		expect(mergeSettings({ onboardingProgress: saved }).onboardingProgress).toEqual(saved);
	});

	it("reads a record with no session (nothing started yet) as progress, not as nothing", () => {
		expect(mergeSettings({ onboardingProgress: { ...saved, sessionId: null } }).onboardingProgress).toEqual({
			...saved,
			sessionId: null,
		});
	});

	it("drops malformed progress, so the guide starts from the top rather than on a half-record", () => {
		for (const bad of [
			{ ...saved, version: 2 },
			{ ...saved, mode: "later" },
			{ ...saved, steps: ["about", "install-everything"] },
			{ ...saved, current: 9 },
			{ ...saved, states: { language: "finished" } },
			"progress",
			42,
		]) {
			expect(mergeSettings({ onboardingProgress: bad }).onboardingProgress).toBeNull();
		}
	});

	it("falls back to the default when there is no saved progress at all", () => {
		expect(mergeSettings({}).onboardingProgress).toBeNull();
		expect(mergeSettings(null).onboardingProgress).toBeNull();
	});

	it("keeps a saved screenshot preference and drops a non-boolean one", () => {
		expect(mergeSettings({ onboardingImages: false }).onboardingImages).toBe(false);
		expect(mergeSettings({ onboardingImages: true }).onboardingImages).toBe(true);
		expect(mergeSettings({ onboardingImages: "no" }).onboardingImages).toBe(true);
		expect(mergeSettings({}).onboardingImages).toBe(true);
	});

	it("keeps the Remote Control toggle's saved position and drops a non-boolean one", () => {
		expect(mergeSettings({ rcServerEnabled: true }).rcServerEnabled).toBe(true);
		expect(mergeSettings({ rcServerEnabled: "on" }).rcServerEnabled).toBe(false);
		expect(mergeSettings({}).rcServerEnabled).toBe(false);
	});
});

describe("mergeSettings (agentConfigApplied)", () => {
	it("keeps only known agent ids and defaults to none", () => {
		expect(mergeSettings({ agentConfigApplied: ["codex", "bogus", 3, "opencode"] }).agentConfigApplied).toEqual(["codex", "opencode"]);
		expect(mergeSettings({ agentConfigApplied: "codex" }).agentConfigApplied).toEqual([]);
		expect(mergeSettings({}).agentConfigApplied).toEqual([]);
	});
});

describe("agentConfigDue", () => {
	const agents = (codex: boolean, opencode: boolean) => ({
		claude: { enabled: true },
		codex: { enabled: codex },
		opencode: { enabled: opencode },
	});

	it("lists an enabled agent whose config was never set up", () => {
		expect(agentConfigDue({ agents: agents(true, true), agentConfigApplied: [] }, true)).toEqual(["codex", "opencode"]);
	});

	it("leaves out an agent already set up once, so a removed status line isn't added back", () => {
		expect(agentConfigDue({ agents: agents(true, true), agentConfigApplied: ["codex"] }, true)).toEqual(["opencode"]);
		expect(agentConfigDue({ agents: agents(true, true), agentConfigApplied: ["codex", "opencode"] }, true)).toEqual([]);
	});

	it("leaves out a disabled agent", () => {
		expect(agentConfigDue({ agents: agents(false, false), agentConfigApplied: [] }, true)).toEqual([]);
	});

	it("waits for the program before OpenCode's status plugin, but not for Codex's config.toml", () => {
		expect(agentConfigDue({ agents: agents(true, true), agentConfigApplied: [] }, false)).toEqual(["codex"]);
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
		expect(asAgentId("opencode")).toBe("opencode");
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

describe("agentsWithLimits", () => {
	const on = { enabled: true };
	const off = { enabled: false };

	it("leaves OpenCode out: it has no usage windows", () => {
		expect(agentsWithLimits({ claude: on, codex: off, opencode: on })).toEqual(["claude"]);
		expect(agentsWithLimits({ claude: on, codex: on, opencode: on })).toEqual(["claude", "codex"]);
	});

	it("is empty when OpenCode is the only agent enabled, so no empty group is drawn", () => {
		expect(agentsWithLimits({ claude: off, codex: off, opencode: on })).toEqual([]);
	});

	it("falls back to Claude when nothing is enabled", () => {
		expect(agentsWithLimits({ claude: off, codex: off, opencode: off })).toEqual(["claude"]);
	});
});

describe("agents off macOS", () => {
	it("keeps every saved agent toggle", () => {
		const merged = mergeSettings({ agents: { codex: { enabled: true }, opencode: { enabled: true } } }, false);
		expect(merged.agents.claude.enabled).toBe(true);
		expect(merged.agents.codex.enabled).toBe(true);
		expect(merged.agents.opencode.enabled).toBe(true);
	});
});

describe("submitKeyOptionLabel", () => {
	it("calls the Option key Alt off macOS and leaves the other labels alone", () => {
		expect(submitKeyOptionLabel("alt+enter", true)).toBe("Option+Enter");
		expect(submitKeyOptionLabel("alt+enter", false)).toBe("Alt+Enter");
		expect(submitKeyOptionLabel("ctrl+enter", false)).toBe("Ctrl+Enter");
	});
});

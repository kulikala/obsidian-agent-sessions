import { afterEach, describe, expect, it } from "vitest";
import { setLang, t } from "../../src/i18n";
import {
	analysisArgs,
	analysisModels,
	defaultCause,
	fixPrompt,
	numbersIn,
	paneBlock,
	panesOf,
	replaceUnknownNumbers,
	statFinding,
	statsChange,
	usageWindow,
	type EffAgent,
	type EffPane,
	type EffHit,
	type Finding,
} from "../../src/sessions/efficiency";

afterEach(() => setLang("en"));

function hit(over: Partial<EffHit> & { id: string; detector: string }): EffHit {
	return {
		session: "s1",
		task: "t-aaaa",
		ts: 1_000,
		metrics: {},
		impact_w: 1000,
		impact_usd: 0.5,
		saving_rate: 0.5,
		confidence: "high",
		needs_llm: false,
		remedy_kind: "habit",
		change: null,
		targets: [],
		shown_targets: [],
		...over,
	};
}

const HITS: EffHit[] = [
	hit({
		id: "h-e01",
		detector: "E01",
		impact_w: 50_000,
		impact_usd: 2,
		saving_rate: 0.8,
		metrics: { est_tokens: 12_000, reads_after: 40 },
		remedy_kind: "fix",
		change: "add",
		targets: ["/home/pat/vault/CLAUDE.md"],
		shown_targets: ["CLAUDE.md"],
	}),
	hit({ id: "h-e04", detector: "E04", impact_w: 9_000, metrics: { gap: 7200, cache_write: 4_000 } }),
	hit({ id: "h-e16", detector: "E16", task: "t-bbbb", impact_w: 30_000, needs_llm: true, metrics: { corrections: 2, calls: 120, calls_ratio: 3.1 } }),
	hit({ id: "h-e03", detector: "E03", task: "t-cccc", impact_w: 20_000, needs_llm: true, metrics: { tasks: 3, carry: 150_000 } }),
];

describe("statistics-only findings", () => {
	it("a canned finding: the detector's text, its cause, and an agent's change only when every hit agrees", () => {
		const f = statFinding("largeOutput", [HITS[0]], false);
		expect(f.title).toBe(t("efficiency.detector.E01.title"));
		expect(f.observed).toContain("12.0k");
		expect([f.cause, f.action, f.change, f.targets]).toEqual(["agent_behavior", "agent", "add", ["/home/pat/vault/CLAUDE.md"]]);
		expect(f.savingW).toBe(40_000);
		expect(f.fromStats).toBe(true);
		const mixed = [HITS[0], { ...HITS[0], id: "h-e01b", targets: ["/other/CLAUDE.md"] }];
		expect(statsChange(mixed)).toBeNull();
		expect(statFinding("largeOutput", mixed, false).action).toBe("none");
		expect(statFinding("rework", [HITS[2]], true).action).toBe("template");
	});

	it("the cause the statistics point to, by detector", () => {
		expect(defaultCause([HITS[2]])).toBe("user_prompt");
		expect(defaultCause([HITS[1]])).toBe("habit");
		expect(defaultCause([{ ...HITS[1], remedy_kind: "fix", change: "add", targets: ["/s.json"] }])).toBe("config");
		expect(defaultCause([hit({ id: "h-e17", detector: "E17", metrics: { calls: 12 } })])).toBe("user_prompt");
	});

	it("E17's canned text has its numbers", () => {
		expect(statFinding("firstRequest", [hit({ id: "h-e17", detector: "E17", metrics: { calls: 12 } })], true).observed).toContain("12 calls");
	});
});

describe("numbers", () => {
	it("reads three-digit numbers and numbers with units", () => {
		expect(numbersIn("about 12,345 tokens, 1.2M, 40K, 3万, 86% and 12 calls")).toEqual([12345, 1_200_000, 40_000, 30_000]);
	});

	it("keeps sentences whose numbers are within 5% of a sent value", () => {
		expect(replaceUnknownNumbers("Used 1.2M tokens. Then 9,999 more.", [1_230_000], "CANNED")).toBe("Used 1.2M tokens. CANNED");
	});
});

describe("prompts", () => {
	const FIX: Finding = {
		check: "largeOutput",
		hits: ["h-e01"],
		title: "Test output fills the context",
		observed: "The full output stayed.",
		cause: "config",
		fix: "s",
		quotes: [],
		action: "agent",
		change: "add",
		targets: ["/v/CLAUDE.md"],
		draft: "- Show only failures.",
		sources: [],
		impactW: 50_000,
		impactUsd: 2,
		savingW: 40_000,
		fromStats: false,
	};

	it.each(["en", "ja"] as const)("the fix request has every required paragraph (%s)", (lang) => {
		setLang(lang);
		for (const change of ["add", "trim", "move"] as const) {
			const targets = change === "move" ? ["/v/CLAUDE.md", "/v/CLAUDE.reference.md"] : ["/v/CLAUDE.md"];
			const text = fixPrompt({ ...FIX, change, targets }, ["s1 · 10:00 · 12k tokens"]) as string;
			for (const key of [
				"efficiency.fix.prompt.targets",
				"efficiency.fix.prompt.step1",
				"efficiency.fix.prompt.step3",
				"efficiency.fix.prompt.rules",
				"efficiency.fix.prompt.rule1",
				"efficiency.fix.prompt.rule2",
				"efficiency.fix.prompt.rule3",
				"efficiency.fix.prompt.finally",
				"efficiency.fix.prompt.newConversation",
				`efficiency.fix.prompt.${change}`,
			] as const) {
				expect(text).toContain(t(key));
			}
			expect(text).toContain(t("efficiency.fix.prompt.step2", { max_lines: change === "add" ? 40 : 120 }));
			for (const other of ["add", "trim", "move"].filter((c) => c !== change)) {
				expect(text).not.toContain(t(`efficiency.fix.prompt.${other}` as "efficiency.fix.prompt.add"));
			}
			for (const target of targets) {
				expect(text).toContain(target);
			}
			expect(text).toContain("- Show only failures.");
			expect(text).not.toMatch(/\/clear/);
		}
	});

	it("an E08 request names the file read at the start of every session", () => {
		const hits = [
			hit({
				id: "h-e08",
				detector: "E08",
				metrics: { sessions: 4, est_tokens: 3000, shown_path: "docs/ref.md" },
				remedy_kind: "fix",
				change: "add",
				targets: ["/v/CLAUDE.md"],
				shown_targets: ["CLAUDE.md"],
				read_path: "/v/docs/ref.md",
			}),
		];
		const f = statFinding("repeatedLookups", hits, false);
		expect(f.observed).toContain("docs/ref.md");
		expect(f.fix).toContain("docs/ref.md");
		const text = fixPrompt(f, []) as string;
		expect(text).toContain(t("efficiency.fix.prompt.sources"));
		expect(text).toContain("- /v/docs/ref.md");
		setLang("ja");
		expect(fixPrompt(statFinding("repeatedLookups", hits, false), []) as string).toContain("- /v/docs/ref.md");
	});

	it("no fix request for advice", () => {
		expect(fixPrompt({ ...FIX, action: "none" }, [])).toBeNull();
		expect(fixPrompt({ ...FIX, action: "template" }, [])).toBeNull();
	});
});

describe("Codex and OpenCode panes", () => {
	const totals = (w: number) => ({ w, calls: 1 }) as EffAgent["totals"];
	const block = {
		range: { rule: "budget", start: 0, end: 1, used_percentage: null, exhausted: false },
		totals: totals(300),
		sessions: [
			{ id: "s1", provider: "anthropic" },
			{ id: "s2", provider: "ollama" },
		],
		breakdown: [],
		tasks: [],
		hits: [hit({ id: "h-1", detector: "E01", session: "s1" }), hit({ id: "h-2", detector: "E01", session: "s2" })],
		excerpts: [],
		baselines: { disabled: [] },
		limits: { truncated: false, reason: null },
		summary: { agent: "opencode" },
	} as unknown as EffAgent;
	const pane = (provider: string, ids: string[], local = false): EffPane => ({
		key: `opencode-${provider}`,
		agent: "opencode",
		provider,
		model: provider === "ollama" ? "big-local" : "claude-sonnet-5",
		local,
		sessions: 1,
		w: 100,
		totals: totals(100),
		breakdown: [],
		hits: ids,
		summary: { agent: "opencode", provider },
		excerpts: [],
	});

	it("a pane holds only its provider's sessions and hits, and what it sends", () => {
		const local = paneBlock(block, pane("ollama", ["h-2"], true));
		expect(local.hits.map((h) => h.id)).toEqual(["h-2"]);
		expect(local.sessions.map((s) => s.id)).toEqual(["s2"]);
		expect(local.summary).toEqual({ agent: "opencode", provider: "ollama" });
		expect(local.totals.w).toBe(100);
		expect(local.range).toBe(block.range);
	});

	it("an older program's block becomes one pane", () => {
		const [only] = panesOf("claude", block);
		expect([only.key, only.hits, only.summary]).toEqual(["claude", ["h-1", "h-2"], block.summary]);
		expect(panesOf("opencode", { ...block, panes: [pane("ollama", [])] }).map((p) => p.key)).toEqual(["opencode-ollama"]);
	});

	it("tries the listed models in order, or the one model", () => {
		expect(analysisModels({ model: "gpt-5.6-terra", models: ["gpt-5.6-terra", "gpt-6-luna"] })).toEqual(["gpt-5.6-terra", "gpt-6-luna"]);
		expect(analysisModels({ model: "m" })).toEqual(["m"]);
		expect(analysisModels({ model: null, models: [] })).toEqual([null]);
	});

	it("names the provider and model on the command line", () => {
		expect(analysisArgs({ agent: "opencode", provider: "ollama", model: "big-local" })).toEqual(["--model", "ollama/big-local"]);
		expect(analysisArgs({ agent: "opencode", provider: "ollama", model: null })).toEqual([]);
		expect(analysisArgs({ agent: "codex", provider: "openai", model: "gpt-6-luna" })).toEqual(["-m", "gpt-6-luna"]);
		expect(analysisArgs({ agent: "codex", provider: "ollama", model: "gpt-oss:20b" })).toEqual([
			"-m",
			"gpt-oss:20b",
			"-c",
			'model_provider="ollama"',
		]);
		expect(analysisArgs({ agent: "claude", provider: "anthropic", model: null })).toEqual([]);
	});

	it("the usage window to name: the range's, else the first known, Codex's monthly one by its length", () => {
		const range = {
			rule: "budget",
			start: 0,
			end: 1,
			used_percentage: null,
			exhausted: false,
			windows: {
				five_hour: { used_percentage: null, end: null, exhausted: false },
				window_43200m: { used_percentage: 13, end: null, exhausted: false },
			},
		};
		expect(usageWindow(range)).toEqual({ label: "30-day window", percent: 13 });
		expect(usageWindow({ ...range, windows: {} })).toBeNull();
		setLang("ja");
		expect(usageWindow({ ...range, windows: { five_hour: { used_percentage: 38, end: null, exhausted: false } } })).toEqual({ label: "5 時間枠", percent: 38 });
	});

	it("the fixing request says how each agent waits for approval", () => {
		const f = statFinding("largeOutput", [HITS[0]], false);
		const claude = fixPrompt(f, []) as string;
		const codex = fixPrompt(f, [], "codex") as string;
		const opencode = fixPrompt(f, [], "opencode") as string;
		expect(claude).toContain(t("efficiency.fix.prompt.step3"));
		expect(codex).toContain(t("efficiency.fix.prompt.step3Codex"));
		expect(opencode).toContain(t("efficiency.fix.prompt.step3Opencode"));
		expect(opencode).toContain("Tab");
		for (const text of [codex, opencode]) {
			expect(text).toContain(t("efficiency.fix.prompt.step2", { max_lines: 40 }));
			expect(text).not.toMatch(/\/clear/);
		}
	});
});

describe("token efficiency strings", () => {
	it("every efficiency key exists in both languages and none recommends /clear", async () => {
		const { en } = await import("../../src/i18n/locales/en");
		const { ja } = await import("../../src/i18n/locales/ja");
		const keys = Object.keys(en).filter((k) => k.startsWith("efficiency.") || k.startsWith("settings.efficiency") || k === "action.analyzeEfficiency");
		expect(keys.length).toBeGreaterThan(100);
		for (const key of keys) {
			expect(ja[key as keyof typeof ja], key).toBeTruthy();
			for (const value of [en[key as keyof typeof en], ja[key as keyof typeof ja] as string]) {
				expect(value, key).not.toMatch(/\/clear/);
			}
		}
	});
});

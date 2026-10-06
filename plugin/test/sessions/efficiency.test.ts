import { afterEach, describe, expect, it } from "vitest";
import { setLang, t } from "../../src/i18n";
import {
	analysisPrompt,
	candidates,
	fixPrompt,
	mergeReply,
	numbersIn,
	payloadOf,
	rangeLine,
	replaceUnknownNumbers,
	retryPrompt,
	ReplyShapeError,
	statFindings,
	type EffAgent,
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

const BLOCK: Pick<EffAgent, "hits" | "excerpts" | "summary"> = {
	hits: HITS,
	excerpts: [
		{
			task: "t-aaaa",
			session: "s1",
			provider: "anthropic",
			w: 80_000,
			calls: 45,
			impact_w: 50_000,
			prompts: [{ ref: "t-aaaa.p1", text: "Run the whole test suite and show me everything." }],
			replies: [{ ref: "t-aaaa.r1", text: "Here is the full output of the tests." }],
			tools: [],
		},
		{
			task: "t-bbbb",
			session: "s1",
			provider: "anthropic",
			w: 60_000,
			calls: 120,
			impact_w: 30_000,
			prompts: [
				{ ref: "t-bbbb.p1", text: "Fix the login redirect." },
				{ ref: "t-bbbb.p2", text: "still wrong" },
			],
			replies: [],
			tools: [],
		},
	],
	summary: { totals: { w: 2_400_000, calls: 900 }, hits: HITS.map((h) => ({ id: h.id, impact_w: h.impact_w, metrics: h.metrics })) },
};

function reply(findings: unknown[], dismissed: unknown[] = []): string {
	return "```json\n" + JSON.stringify({ findings, dismissed }) + "\n```";
}

const GOOD_E01 = {
	hits: ["h-e01"],
	detector: "E01",
	origin: "config",
	title: "Test output fills the context",
	cause: "The full test output of about 12,000 tokens stayed in the conversation for 40 calls.",
	quotes: [{ ref: "t-aaaa.p1", text: "show me everything" }],
	remedy: { kind: "fix", change: "add", summary: "Ask for failures only.", steps: ["Add the rule."], targets: ["CLAUDE.md"], draft: "- Show only failing tests." },
	confidence: "high",
};

describe("mergeReply", () => {
	it("keeps a well-formed finding, takes the targets from the statistics and recomputes the impact", () => {
		const { findings } = mergeReply(reply([GOOD_E01]), BLOCK);
		const f = findings.find((x) => !x.fromStats) as Finding;
		expect(f.title).toBe("Test output fills the context");
		expect(f.quotes).toEqual([{ ref: "t-aaaa.p1", text: "show me everything" }]);
		expect(f.remedy).toMatchObject({ kind: "fix", change: "add", targets: ["/home/pat/vault/CLAUDE.md"], draft: "- Show only failing tests." });
		expect(f.impactW).toBe(50_000);
		expect(f.effectW).toBe(40_000);
	});

	it("drops hit ids that were not sent, and a finding left without any", () => {
		const { findings, notes } = mergeReply(reply([{ ...GOOD_E01, hits: ["h-nope"] }]), BLOCK);
		expect(findings.every((f) => f.fromStats)).toBe(true);
		expect(notes.join(" ")).toContain("h-nope");
	});

	it("removes quotes that were not sent, are not in that prompt, or belong to another task", () => {
		const quotes = [
			{ ref: "t-zzzz.p1", text: "anything" },
			{ ref: "t-aaaa.p1", text: "words never written" },
			{ ref: "t-bbbb.p2", text: "still wrong" },
			{ ref: "t-aaaa.r1", text: "full output" },
		];
		const { findings } = mergeReply(reply([{ ...GOOD_E01, quotes }]), BLOCK);
		expect(findings.find((f) => !f.fromStats)?.quotes).toEqual([{ ref: "t-aaaa.r1", text: "full output" }]);
	});

	it("turns a fix whose change or targets differ from the statistics into advice", () => {
		for (const remedy of [
			{ ...GOOD_E01.remedy, change: "trim" },
			{ ...GOOD_E01.remedy, targets: ["/etc/passwd"] },
		]) {
			const f = mergeReply(reply([{ ...GOOD_E01, remedy }]), BLOCK).findings.find((x) => !x.fromStats) as Finding;
			expect(f.remedy).toMatchObject({ kind: "habit", change: null, targets: [], draft: "" });
		}
		const habitHit = mergeReply(reply([{ ...GOOD_E01, hits: ["h-e04"], detector: "E04" }]), BLOCK).findings.find((x) => !x.fromStats);
		expect(habitHit?.remedy.kind).toBe("habit");
	});

	it("replaces sentences with numbers the statistics don't have by the canned text", () => {
		const cause = "The output was 12,000 tokens. It cost 987,654 tokens over the week.";
		const f = mergeReply(reply([{ ...GOOD_E01, cause, title: "Saved 333K tokens" }]), BLOCK).findings.find((x) => !x.fromStats) as Finding;
		expect(f.cause).toContain("The output was 12,000 tokens.");
		expect(f.cause).not.toContain("987,654");
		expect(f.cause).toContain(t("efficiency.detector.E01.cause", { tokens: "12.0k", reads: 40 }));
		expect(f.title).toBe(t("efficiency.detector.E01.title"));
	});

	it("replaces a remedy that recommends /clear", () => {
		const remedy = { ...GOOD_E01.remedy, summary: "Run /clear after each test run.", steps: ["Type /clear"] };
		const f = mergeReply(reply([{ ...GOOD_E01, remedy }]), BLOCK).findings.find((x) => !x.fromStats) as Finding;
		expect(f.remedy.summary).not.toMatch(/\/clear/);
		expect(f.remedy.steps).toEqual([]);
	});

	it("keeps uncovered hits as canned findings, but not dismissed or needs_llm ones; largest first", () => {
		const { findings, dismissed } = mergeReply(reply([], [{ hits: ["h-e04"], reason: "short pause" }]), BLOCK);
		expect(dismissed).toEqual([{ hits: ["h-e04"], reason: "short pause" }]);
		expect(findings.map((f) => f.hits)).toEqual([["h-e01"]]);
		const confirmed = mergeReply(
			reply([{ ...GOOD_E01, hits: ["h-e16"], detector: "E16", quotes: [{ ref: "t-bbbb.p2", text: "still wrong" }], remedy: { kind: "habit", summary: "Write the target and how to check it." } }]),
			BLOCK
		).findings;
		expect(confirmed.map((f) => f.detector)).toEqual(["E01", "E16", "E04"]);
		expect(confirmed.every((f, i, all) => i === 0 || all[i - 1].impactW >= f.impactW)).toBe(true);
	});

	it("throws a shape error for a reply that isn't the JSON object", () => {
		expect(() => mergeReply("I could not do it.", BLOCK)).toThrow(ReplyShapeError);
		expect(() => mergeReply('{"items": []}', BLOCK)).toThrow(ReplyShapeError);
	});
});

describe("statistics-only findings", () => {
	it("never shows needs_llm hits, groups the rest by detector and remedy", () => {
		const list = statFindings([...HITS, hit({ id: "h-e04b", detector: "E04", impact_w: 1_000 })]);
		expect(list.map((f) => [f.detector, f.hits])).toEqual([
			["E01", ["h-e01"]],
			["E04", ["h-e04", "h-e04b"]],
		]);
		expect(list.every((f) => f.fromStats)).toBe(true);
		expect(candidates(HITS)).toEqual({ E16: 1, E03: 1 });
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
	it("the analysis prompt carries the data between markers, the meaning checks and the language", () => {
		const prompt = analysisPrompt(payloadOf({ summary: { a: 1 }, excerpts: [] }), "ja");
		expect(prompt).toContain("<<<DATA\n" + '{"statistics":{"a":1},"excerpts":[]}' + "\nDATA>>>");
		expect(prompt).toContain("Write title, cause, remedy and reason in Japanese.");
		expect(prompt).toContain("whatever language they are in");
		expect(prompt).toContain("only scolds");
		expect(prompt).toContain("recommend /clear");
		expect(prompt).toContain("start a new conversation in a new tab");
		expect(retryPrompt("P", "bad JSON")).toContain("could not be used (bad JSON)");
	});

	const FIX: Finding = {
		hits: ["h-e01"],
		detector: "E01",
		origin: "config",
		title: "Test output fills the context",
		cause: "The full output stayed.",
		quotes: [],
		remedy: { kind: "fix", change: "add", summary: "s", steps: [], targets: ["/v/CLAUDE.md"], draft: "- Show only failures." },
		confidence: "high",
		impactW: 50_000,
		impactUsd: 2,
		effectW: 40_000,
		sessions: ["s1"],
		fromStats: false,
	};

	it.each(["en", "ja"] as const)("the fix request has every required paragraph (%s)", (lang) => {
		setLang(lang);
		for (const change of ["add", "trim", "move"] as const) {
			const targets = change === "move" ? ["/v/CLAUDE.md", "/v/CLAUDE.reference.md"] : ["/v/CLAUDE.md"];
			const text = fixPrompt({ ...FIX, remedy: { ...FIX.remedy, change, targets } }, ["s1 · 10:00 · 12k tokens"]) as string;
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

	it("no fix request for advice", () => {
		expect(fixPrompt({ ...FIX, remedy: { ...FIX.remedy, kind: "habit" } }, [])).toBeNull();
	});
});

describe("rangeLine", () => {
	const totals = { w: 41_300_000 } as EffAgent["totals"];
	const sessions = Array.from({ length: 14 }, (_, i) => ({ id: String(i) })) as EffAgent["sessions"];

	it("names the rule, its usage, the sessions and the tokens", () => {
		const line = rangeLine("Claude Code", {
			range: { rule: "five_hour", start: 1_000_000, end: 1_018_000, used_percentage: 86, exhausted: false },
			totals,
			sessions,
		});
		expect(line).toMatch(/^Claude Code — 5-hour window \(86% used\) .+–.+ · 14 sessions · 41\.3M tokens$/);
		const budget = rangeLine("Claude Code", {
			range: { rule: "budget", start: 1_000_000, end: 1_018_000, used_percentage: null, exhausted: false, budget: 10_000_000 },
			totals,
			sessions,
		});
		expect(budget).toContain("latest 10.0M weighted tokens (from ");
		setLang("ja");
		const ja = rangeLine("Claude Code", {
			range: { rule: "seven_day", start: 1_000_000, end: 1_018_000, used_percentage: null, exhausted: true },
			totals,
			sessions,
		});
		expect(ja).toContain("7 日枠（上限に到達）");
	});
});

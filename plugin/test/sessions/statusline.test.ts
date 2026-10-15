import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../../src/i18n";
import { formatStatus, StatusLine } from "../../src/sessions/statusline";

describe("StatusLine.get", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-status-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads effort even when it's shaped as {level}", () => {
		writeFileSync(join(dir, "s1.json"), JSON.stringify({ model: { display_name: "Opus 5" }, effort: { level: "high" } }));
		const status = new StatusLine(dir);
		expect(status.get("s1")?.effort).toBe("high");
	});

	it("is null when the file doesn't exist", () => {
		const status = new StatusLine(dir);
		expect(status.get("missing")).toBeNull();
	});

	it("is null for malformed JSON", () => {
		writeFileSync(join(dir, "a.json"), "{not json", "utf8");
		const status = new StatusLine(dir);
		expect(status.get("a")).toBeNull();
	});

	it("reads the statusLine JSON as-is", () => {
		writeFileSync(
			join(dir, "a.json"),
			JSON.stringify({
				model: { display_name: "Opus 5" },
				context_window: { used_percentage: 42.4 },
				rate_limits: { five_hour: { used_percentage: 37 }, seven_day: { used_percentage: 12 } },
				effort: "high",
			}),
			"utf8"
		);
		const status = new StatusLine(dir);
		expect(status.get("a")).toEqual({
			model: "Opus 5",
			effort: "high",
			advisor: null,
			ctxPercent: 42.4,
			fiveHour: 37,
			sevenDay: 12,
		});
	});

	it("fills missing keys with null", () => {
		writeFileSync(join(dir, "a.json"), JSON.stringify({ model: { display_name: "Sonnet 5" } }), "utf8");
		const status = new StatusLine(dir);
		expect(status.get("a")).toEqual({
			model: "Sonnet 5",
			effort: null,
			advisor: null,
			ctxPercent: null,
			fiveHour: null,
			sevenDay: null,
		});
	});

	it("reads the advisor agent-sessions adds next to Claude Code's own fields", () => {
		writeFileSync(
			join(dir, "a.json"),
			JSON.stringify({
				model: { display_name: "Sonnet 5" },
				agent_sessions: { advisor: { id: "claude-opus-5-5", display_name: "Opus 5.5" } },
			}),
			"utf8"
		);
		expect(new StatusLine(dir).get("a")?.advisor).toEqual({ name: "Opus 5.5", id: "claude-opus-5-5" });
	});

	it("names the advisor by its id when the short name is missing, and ignores one with no id", () => {
		writeFileSync(join(dir, "a.json"), JSON.stringify({ agent_sessions: { advisor: { id: "opus" } } }), "utf8");
		writeFileSync(join(dir, "b.json"), JSON.stringify({ agent_sessions: { advisor: { display_name: "Opus" } } }), "utf8");
		const status = new StatusLine(dir);
		expect(status.get("a")?.advisor).toEqual({ name: "opus", id: "opus" });
		expect(status.get("b")?.advisor).toBeNull();
	});
});

describe("formatStatus", () => {
	afterEach(() => setLang("en"));

	it("when everything is present", () => {
		expect(
			formatStatus({ model: "Opus 5", effort: "high", advisor: null, ctxPercent: 42, fiveHour: 37, sevenDay: 12 }, true)
		).toBe("Opus 5 · high · ctx 42% · rc ● · 5h 37% · 7d 12%");
	});

	it("puts the advisor after the effort", () => {
		const advisor = { name: "Opus 5.5", id: "claude-opus-5-5" };
		expect(formatStatus({ model: "Sonnet 5", effort: "high", advisor, ctxPercent: 42, fiveHour: 37, sevenDay: 12 }, true)).toBe(
			"Sonnet 5 · high · advisor Opus 5.5 · ctx 42% · rc ● · 5h 37% · 7d 12%"
		);
	});

	it("shows ○ when rc is false", () => {
		expect(
			formatStatus({ model: "Opus 5", effort: "high", advisor: null, ctxPercent: 42, fiveHour: 37, sevenDay: 12 }, false)
		).toContain("rc ○");
	});

	it("shows ○ when rc is null, i.e. no ledger entry (● means actively connected only)", () => {
		expect(
			formatStatus({ model: "Opus 5", effort: "high", advisor: null, ctxPercent: 42, fiveHour: 37, sevenDay: 12 }, null)
		).toContain("rc ○");
	});

	it("falls back to デフォルト (default) when model/effort are missing, and — for everything else", () => {
		// The default-value fallback goes through t(), so pin the language for these assertions.
		setLang("ja");
		expect(formatStatus(null, null)).toBe("デフォルト · デフォルト · ctx — · rc ○ · 5h — · 7d —");
	});

	it("info is present but some fields are missing", () => {
		setLang("ja");
		expect(formatStatus({ model: "Sonnet 5", effort: null, advisor: null, ctxPercent: 10, fiveHour: null, sevenDay: null }, true)).toBe(
			"Sonnet 5 · デフォルト · ctx 10% · rc ● · 5h — · 7d —"
		);
	});
});

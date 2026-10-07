import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../src/i18n";
import {
	GOAL_ICON,
	goalMarkClass,
	goalNeedsRescan,
	goalState,
	goalTooltip,
	GOAL_TOOLTIP_REASON_CHARS,
	truncateText,
} from "../../src/sessions/goal";
import type { SessionGoal } from "../../src/types";

afterEach(() => setLang("en"));

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
	return { condition: "Finish the plan", met: false, reason: null, since: 1, updated: 1, ...overrides };
}

describe("goalState", () => {
	it("is null without a goal", () => {
		expect(goalState(null)).toBeNull();
		expect(goalState(undefined)).toBeNull();
	});

	it("is active until met, and failed wins over met", () => {
		expect(goalState(goal())).toBe("active");
		expect(goalState(goal({ reason: "T-12 not started" }))).toBe("active");
		expect(goalState(goal({ met: true, reason: "done" }))).toBe("met");
		expect(goalState(goal({ failed: true, reason: "impossible" }))).toBe("failed");
	});

	it("gives each state its own icon", () => {
		expect(new Set(Object.values(GOAL_ICON)).size).toBe(3);
		expect(GOAL_ICON.active).toBe("target");
	});
});

describe("goalMarkClass", () => {
	it("moves only while an active goal's session is running", () => {
		expect(goalMarkClass("active", "working")).toBe("agent-sessions-goal-mark agent-sessions-goal-active is-live");
		expect(goalMarkClass("active", "running-shell")).toContain("is-live");
		expect(goalMarkClass("active", "idle")).toBe("agent-sessions-goal-mark agent-sessions-goal-active");
		expect(goalMarkClass("active", "asking")).not.toContain("is-live");
		expect(goalMarkClass("active", null)).not.toContain("is-live");
	});

	it("never moves once met or failed", () => {
		expect(goalMarkClass("met", "working")).toBe("agent-sessions-goal-mark agent-sessions-goal-met");
		expect(goalMarkClass("failed", "working")).toBe("agent-sessions-goal-mark agent-sessions-goal-failed");
	});
});

describe("goalTooltip", () => {
	it("shows the state and the condition before the first evaluation", () => {
		expect(goalTooltip(goal())).toBe("Goal active\nFinish the plan");
	});

	it("adds the evaluator's reason, cut short", () => {
		const text = goalTooltip(goal({ met: true, reason: "x".repeat(1000) }));
		const [state, condition, reason] = text.split("\n");
		expect(state).toBe("Goal met");
		expect(condition).toBe("Finish the plan");
		expect(reason.startsWith("Evaluator: ")).toBe(true);
		expect([...reason.slice("Evaluator: ".length)].length).toBe(GOAL_TOOLTIP_REASON_CHARS);
		expect(reason.endsWith("…")).toBe(true);
	});

	it("is translated", () => {
		setLang("ja");
		expect(goalTooltip(goal({ met: true, reason: "完了" }))).toBe("ゴール達成\nFinish the plan\n判定: 完了");
	});
});

describe("truncateText", () => {
	it("keeps short text and cuts by code point", () => {
		expect(truncateText("abc", 3)).toBe("abc");
		expect(truncateText("abcd", 3)).toBe("ab…");
		expect(truncateText("😀😀😀😀", 3)).toBe("😀😀…");
	});
});

describe("goalNeedsRescan", () => {
	const claude = (g?: SessionGoal | null) => ({ agent: "claude", goal: g });

	it("looks on busy while no goal is active (a goal may just have been set)", () => {
		expect(goalNeedsRescan("busy", claude(null))).toBe(true);
		expect(goalNeedsRescan("busy", claude(goal({ met: true })))).toBe(true);
		expect(goalNeedsRescan("busy", claude(goal()))).toBe(false);
	});

	it("looks on idle while a goal is showing (the evaluator may just have run, or a verdict mark may be due to go)", () => {
		expect(goalNeedsRescan("idle", claude(goal()))).toBe(true);
		expect(goalNeedsRescan("idle", claude(goal({ met: true })))).toBe(true);
		expect(goalNeedsRescan("idle", claude(goal({ failed: true })))).toBe(true);
		expect(goalNeedsRescan("idle", claude(null))).toBe(false);
	});

	it("ignores other agents and unknown rows", () => {
		expect(goalNeedsRescan("busy", { agent: "codex", goal: null })).toBe(false);
		expect(goalNeedsRescan("busy", undefined)).toBe(false);
	});
});

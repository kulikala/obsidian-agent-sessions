import { beforeAll, describe, expect, it } from "vitest";
import { setLang } from "../../src/i18n";
import { activeSchedule, scheduleLines, scheduleTooltip, startsLooped, staysLooped } from "../../src/sessions/looped";
import type { SessionSchedule } from "../../src/types";

const NOW = new Date(2026, 9, 8, 12, 0, 0);
const at = (h: number, m: number, day = 8) => new Date(2026, 9, day, h, m).getTime() / 1000;

function schedule(over: Partial<SessionSchedule> = {}): SessionSchedule {
	return {
		jobs: [{ cron: "*/5 * * * *", recurring: true, human: "Every 5 minutes", next: at(12, 5) }],
		job_count: 1,
		wakeup: null,
		next: at(12, 5),
		...over,
	};
}

beforeAll(() => setLang("en"));

describe("activeSchedule", () => {
	const base = { agent: "claude", pid: 123, schedule: schedule() };

	it("needs a Claude Code session with a live process", () => {
		expect(activeSchedule(base)).toBe(base.schedule);
		expect(activeSchedule({ ...base, pid: null })).toBeNull();
		expect(activeSchedule({ ...base, agent: "codex" })).toBeNull();
		expect(activeSchedule({ ...base, schedule: undefined })).toBeNull();
	});
});

describe("scheduleTooltip", () => {
	it("says how many tasks are scheduled and when the next runs", () => {
		const text = scheduleTooltip(schedule(), NOW);
		expect(text).toMatch(/^1 scheduled task, next run at /);
		expect(scheduleTooltip(schedule({ job_count: 3 }), NOW)).toMatch(/^3 scheduled tasks, /);
	});

	it("names a pending wakeup, alone or after the tasks", () => {
		const wake = schedule({ jobs: [], job_count: 0, wakeup: at(12, 30), next: at(12, 30) });
		expect(scheduleTooltip(wake, NOW)).toMatch(/^Resumes by itself at /);
		expect(scheduleTooltip(schedule({ wakeup: at(12, 30) }), NOW)).toMatch(/task, next run at .*\. Resumes by itself at /);
	});

	it("leaves the time out when the next run is unknown", () => {
		const s = schedule({ jobs: [{ cron: "x", recurring: true, human: "", next: null }] });
		expect(scheduleTooltip(s, NOW)).toBe("1 scheduled task.");
	});

	it("shows the date for a run on another day", () => {
		const s = schedule({ jobs: [{ cron: "0 9 * * *", recurring: true, human: "Daily", next: at(9, 0, 9) }] });
		expect(scheduleTooltip(s, NOW)).toMatch(/10\/9|9\/10|09/);
	});
});

describe("scheduleLines", () => {
	it("lists each job with its own next run, and the wakeup", () => {
		const lines = scheduleLines(schedule({ wakeup: at(12, 30) }), NOW);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^Every 5 minutes — next run at /);
		expect(lines[1]).toMatch(/^Resumes by itself/);
	});

	it("marks a one-shot job and counts the ones not listed", () => {
		const s = schedule({ jobs: [{ cron: "0 9 8 10 *", recurring: false, human: "", next: null }], job_count: 4 });
		const lines = scheduleLines(s, NOW);
		expect(lines[0]).toBe("0 9 8 10 * (once)");
		expect(lines[1]).toBe("and 3 more");
	});
});

describe("looped transitions", () => {
	it("starts only for a scheduled turn that ended while the tab was out of front", () => {
		expect(startsLooped({ scheduledTurn: true, front: false })).toBe(true);
		expect(startsLooped({ scheduledTurn: true, front: true })).toBe(false);
		expect(startsLooped({ scheduledTurn: false, front: false })).toBe(false);
	});

	it("ends when the tab comes to front or a human turn follows", () => {
		expect(staysLooped({ front: false, scheduledTurn: true })).toBe(true);
		expect(staysLooped({ front: true, scheduledTurn: true })).toBe(false);
		expect(staysLooped({ front: false, scheduledTurn: false })).toBe(false);
	});
});

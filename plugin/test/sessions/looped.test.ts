import { beforeAll, describe, expect, it } from "vitest";
import { setLang } from "../../src/i18n";
import { activeSchedule, describeCron, scheduleLines, scheduleTooltip, startsLooped, staysLooped } from "../../src/sessions/looped";
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

describe("describeCron", () => {
	const cases: Array<[string, string, string]> = [
		["*/30 * * * *", "Every 30 minutes", "30 分ごと"],
		["*/1 * * * *", "Every 1 minute", "1 分ごと"],
		["15 * * * *", "Every hour at 15 min past", "毎時 15 分"],
		["0 9 * * *", "Every day at 9:00", "毎日 9:00"],
		["5 14 * * 1", "Every Monday at 14:05", "毎週 月曜 14:05"],
		["0 8 * * 7", "Every Sunday at 8:00", "毎週 日曜 8:00"],
		["59 13 9 10 *", "Once, on 10/9 at 13:59", "1 回だけ 10 月 9 日 13:59"],
		["0 9 * * 1-5", "Cron expression `0 9 * * 1-5`", "cron 式 `0 9 * * 1-5`"],
		["nonsense", "Cron expression `nonsense`", "cron 式 `nonsense`"],
	];

	it.each(cases)("%s in English", (cron, en) => {
		setLang("en");
		expect(describeCron(cron)).toBe(en);
	});

	it.each(cases)("%s in Japanese", (cron, _en, ja) => {
		setLang("ja");
		expect(describeCron(cron)).toBe(ja);
		setLang("en");
	});
});

describe("scheduleLines", () => {
	it("describes each job in words with its next run beneath, then the wakeup", () => {
		const lines = scheduleLines(schedule({ wakeup: at(12, 30) }), NOW);
		expect(lines).toHaveLength(2);
		expect(lines[0].text).toBe("Every 5 minutes");
		expect(lines[0].note).toMatch(/^Next run at /);
		expect(lines[1].text).toMatch(/^Resumes by itself/);
	});

	it("marks a one-shot job that is not a single date, and counts the ones not listed", () => {
		const s = schedule({ jobs: [{ cron: "0 9 * * 1-5", recurring: false, human: "", next: null }], job_count: 4 });
		const lines = scheduleLines(s, NOW);
		expect(lines[0]).toEqual({ text: "Once, Cron expression `0 9 * * 1-5`", note: undefined });
		expect(lines[1].text).toBe("and 3 more");
	});

	it("leaves a single-date job as it is", () => {
		const s = schedule({ jobs: [{ cron: "59 13 9 10 *", recurring: false, human: "", next: at(13, 59) }] });
		expect(scheduleLines(s, NOW)[0].text).toBe("Once, on 10/9 at 13:59");
	});

	it("speaks Japanese", () => {
		setLang("ja");
		const lines = scheduleLines(schedule({ wakeup: at(12, 30) }), NOW);
		setLang("en");
		expect(lines[0].text).toBe("5 分ごと");
		expect(lines[0].note).toMatch(/^次の実行は /);
		expect(lines[1].text).toMatch(/に自動で再開します。$/);
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

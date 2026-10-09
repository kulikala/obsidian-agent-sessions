// Scheduled work in a Claude Code session, as pure functions (no `obsidian` import): when a
// session counts as having an active schedule, the text that describes it, and when the
// `looped` state starts and ends. Tested in test/sessions/looped.test.ts.

import { t } from "../i18n";
import type { Row } from "./index";
import type { ScheduleJob, SessionSchedule } from "../types";

/** The row's schedule while it can fire: a Claude Code session whose process is alive. The
 * transcript alone cannot tell a schedule from one that died with its process. */
export function activeSchedule(row: Pick<Row, "agent" | "pid" | "schedule">): SessionSchedule | null {
	return row.agent === "claude" && row.pid != null && row.schedule ? row.schedule : null;
}

function clock(epochSeconds: number, now: Date): string {
	const d = new Date(epochSeconds * 1000);
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { month: "numeric", day: "numeric" })} ${time}`;
}

/** The tooltip of the schedule badge: what is scheduled and when it runs next. */
export function scheduleTooltip(schedule: SessionSchedule, now = new Date()): string {
	const parts: string[] = [];
	if (schedule.job_count > 0) {
		const next = soonestJob(schedule.jobs);
		parts.push(
			next != null
				? t("schedule.jobsNext", { n: schedule.job_count, time: clock(next, now) })
				: t("schedule.jobs", { n: schedule.job_count })
		);
	}
	if (schedule.wakeup != null) {
		parts.push(t("schedule.wakeup", { time: clock(schedule.wakeup, now) }));
	}
	return parts.join(" ");
}

function soonestJob(jobs: ScheduleJob[]): number | null {
	const times = jobs.map((j) => j.next).filter((n): n is number => n != null);
	return times.length ? Math.min(...times) : null;
}

const NUM = /^\d+$/;

function hhmm(hour: string, minute: string): string {
	return `${Number(hour)}:${minute.padStart(2, "0")}`;
}

/**
 * A cron expression in words (the forms `/loop` and `CronCreate` produce most: every N minutes,
 * hourly, daily, weekly, and a single date), or "Cron expression `…`" for anything else.
 */
export function describeCron(cron: string): string {
	const f = cron.trim().split(/\s+/);
	if (f.length === 5) {
		const [min, hour, dom, mon, dow] = f;
		const everyDay = dom === "*" && mon === "*" && dow === "*";
		const step = /^\*\/(\d+)$/.exec(min);
		if (step && hour === "*" && everyDay) {
			return t("schedule.cron.everyMinutes", { n: Number(step[1]) });
		}
		if (min === "*" && hour === "*" && everyDay) {
			return t("schedule.cron.everyMinutes", { n: 1 });
		}
		if (NUM.test(min) && hour === "*" && everyDay) {
			return t("schedule.cron.hourly", { minute: Number(min) });
		}
		if (NUM.test(min) && NUM.test(hour)) {
			if (everyDay) {
				return t("schedule.cron.daily", { time: hhmm(hour, min) });
			}
			if (dom === "*" && mon === "*" && NUM.test(dow) && Number(dow) <= 7) {
				const names = t("schedule.weekdays").split(",");
				return t("schedule.cron.weekly", { day: names[Number(dow) % 7], time: hhmm(hour, min) });
			}
			if (NUM.test(dom) && NUM.test(mon) && dow === "*") {
				return t("schedule.cron.date", { month: Number(mon), day: Number(dom), time: hhmm(hour, min) });
			}
		}
	}
	return t("schedule.cron.other", { cron });
}

export interface ScheduleLine {
	text: string;
	/** A fainter second line (when it runs next). */
	note?: string;
}

/** The detail pane's lines: each job in words with its next run beneath, then the wakeup. */
export function scheduleLines(schedule: SessionSchedule, now = new Date()): ScheduleLine[] {
	const lines: ScheduleLine[] = schedule.jobs.map((j) => {
		const once = !j.recurring && !/^\d+ \d+ \d+ \d+ \*$/.test(j.cron.trim());
		return {
			text: once ? t("schedule.cron.onceOther", { what: describeCron(j.cron) }) : describeCron(j.cron),
			note: j.next != null ? t("schedule.nextRun", { time: clock(j.next, now) }) : undefined,
		};
	});
	if (schedule.job_count > schedule.jobs.length) {
		lines.push({ text: t("schedule.more", { n: schedule.job_count - schedule.jobs.length }) });
	}
	if (schedule.wakeup != null) {
		lines.push({ text: t("schedule.wakeup", { time: clock(schedule.wakeup, now) }) });
	}
	return lines;
}

export interface LoopedIdleInput {
	/** The rescanned row's `scheduled_turn`: the turn that just ended was started by a schedule. */
	scheduledTurn: boolean;
	/** The tab is in front, so the user is already looking at it. */
	front: boolean;
}

/** Whether a busy→idle transition marks the tab `looped`. */
export function startsLooped(input: LoopedIdleInput): boolean {
	return input.scheduledTurn && !input.front;
}

/** Whether a tab marked `looped` stays so. The mark ends when the tab is brought to front, or
 * when a rescan shows the latest turn is no longer a scheduled one (the user sent something). */
export function staysLooped(input: { front: boolean; scheduledTurn: boolean }): boolean {
	return !input.front && input.scheduledTurn;
}

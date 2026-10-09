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

/** One line per scheduled item for the detail pane. */
export function scheduleLines(schedule: SessionSchedule, now = new Date()): string[] {
	const lines = schedule.jobs.map((j) => {
		const what = j.human || j.cron;
		const kind = j.recurring ? "" : ` (${t("schedule.once")})`;
		return j.next != null ? `${what}${kind} — ${t("schedule.next", { time: clock(j.next, now) })}` : `${what}${kind}`;
	});
	if (schedule.job_count > schedule.jobs.length) {
		lines.push(t("schedule.more", { n: schedule.job_count - schedule.jobs.length }));
	}
	if (schedule.wakeup != null) {
		lines.push(t("schedule.wakeup", { time: clock(schedule.wakeup, now) }));
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

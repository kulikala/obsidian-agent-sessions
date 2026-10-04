// Step results and how they add up. A step is { name, status, ms, message }.

export const STATUSES = ["pass", "fail", "skipped"];

/** Counts by status and the overall verdict: ok only if nothing failed and something passed. */
export function aggregate(steps) {
	const counts = { pass: 0, fail: 0, skipped: 0 };
	for (const step of steps) {
		if (step.status in counts) {
			counts[step.status]++;
		} else {
			counts.fail++;
		}
	}
	return { ...counts, total: steps.length, ok: counts.fail === 0 && counts.pass > 0 };
}

/** A step for something the runner itself could not do (it never reached Obsidian, say). */
export function failedStep(name, message, ms = 0) {
	return { name, status: "fail", ms, message };
}

/** Every step as skipped for `reason`, e.g. the verify stage after a failed run. */
export function skipAll(names, reason) {
	return names.map((name) => ({ name, status: "skipped", ms: 0, message: reason }));
}

/** One target's result: the run and the verify stage together. */
export function targetResult({ target, startedAt, env = null, run = [], verify = [], error = null }) {
	const steps = [...run, ...verify];
	const summary = aggregate(steps);
	const ok = summary.ok && !error;
	return { target, startedAt, env, ok, summary, error, run, verify };
}

/** `macos: 14 pass, 0 fail, 2 skipped` */
export function oneLine(result) {
	const { pass, fail, skipped } = result.summary;
	const head = `${result.ok ? "PASS" : "FAIL"} ${result.target}`;
	const tail = result.error ? ` (${result.error})` : "";
	return `${head}: ${pass} pass, ${fail} fail, ${skipped} skipped${tail}`;
}

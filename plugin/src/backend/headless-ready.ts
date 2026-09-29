// Waiting for a background (headless) agent session to be ready for its next input.
//
// Claude Code always reports `idle` through its ledger, so waiting for that status is enough.
// OpenCode reports status only when the plugin sees an event: a freshly resumed session may
// produce none until a turn has run. For OpenCode, "ready" is therefore either `idle`, or "no
// status at all, and the terminal has been quiet for a while after it started drawing".

import type { AgentId } from "../settings";

export interface ReadyOptions {
	agent: AgentId;
	/** The session's status in the registry (`null` = none seen). */
	status: () => string | null;
	/** When the PTY last produced output (`now()` scale); `null` = none yet. */
	lastOutputAt: () => number | null;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	timeoutMs: number;
	/** OpenCode only: how long the terminal must be quiet. */
	quietMs: number;
	pollMs: number;
}

/** Resolves `true` once the session is ready, `false` at `timeoutMs`. A `busy`/`waiting`
 * status is never ready, however quiet the terminal is. */
export async function waitUntilReady(o: ReadyOptions): Promise<boolean> {
	const deadline = o.now() + o.timeoutMs;
	for (;;) {
		const status = o.status();
		if (status === "idle") {
			return true;
		}
		if (o.agent === "opencode" && status === null) {
			const last = o.lastOutputAt();
			if (last !== null && o.now() - last >= o.quietMs) {
				return true;
			}
		}
		if (o.now() >= deadline) {
			return false;
		}
		await o.sleep(o.pollMs);
	}
}

// The `open` op's main.ts handler, in a pure function: validate the agent and decide what the tab
// needs, so `plugin/test/sessions/open-tab.test.ts` can pin it without Obsidian.

import type { OpenRequest } from "../backend/edit-server";
import { AGENT_IDS, asAgentId, type AgentId } from "../settings";

export interface OpenTabPlan {
	session: string;
	agent: AgentId;
	cwd: string;
	/** Only when it differs from `session`; the view attaches to this daemon id. */
	daemonId?: string;
	name?: string;
	/** Keep `name` in `pendingNames` (no tab exists yet, so nothing else shows it). */
	rememberName: boolean;
	/** Start resolving an unlinked Codex/OpenCode daemon session's real id, as a new tab does. */
	trackNewAgent: boolean;
}

export type OpenTabDecision = { ok: true; plan: OpenTabPlan } | { ok: false; error: string };

/** What the `open` handler should do: reject a disabled/unknown agent, and decide which tab to open.
 * `tabExists` answers for both a view's own id and a Codex/OpenCode tab's daemon id. */
export function planOpenTab(
	req: OpenRequest,
	opts: { enabled: (agent: AgentId) => boolean; tabExists: (id: string) => boolean }
): OpenTabDecision {
	if (!AGENT_IDS.some((id) => id === req.agent)) {
		return { ok: false, error: "bad-request" };
	}
	const agent = asAgentId(req.agent);
	if (!opts.enabled(agent)) {
		return { ok: false, error: "agent-disabled" };
	}
	const name = req.name && req.name.trim() ? req.name : undefined;
	const tabExists = opts.tabExists(req.session) || (req.daemon ? opts.tabExists(req.daemon) : false);
	return {
		ok: true,
		plan: {
			session: req.session,
			agent,
			cwd: req.cwd,
			daemonId: req.daemon,
			name,
			rememberName: Boolean(name) && !tabExists,
			trackNewAgent: agent !== "claude" && (!req.daemon || req.daemon === req.session),
		},
	};
}

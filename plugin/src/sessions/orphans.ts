// Running Codex/OpenCode daemon sessions nobody is looking the real id for. They exist when
// `agent-sessions new` started one (no tab, so no resolver of the plugin's own), or when a tab's
// resolver died with a plugin reload. `main.ts` runs the same resolve-and-link flow for them as for a
// tab of its own.

import type { DaemonSession } from "../types";

export interface KnownSessions {
	/** Daemon ids `sessions.json` links to a real session (`sessions[real].daemon`). */
	linkedDaemonIds: ReadonlySet<string>;
	/** Real session ids: the store's keys and the index's rows. A session resumed under its real id
	 * runs in the daemon under that id, and needs no resolving. */
	sessionIds: ReadonlySet<string>;
	/** Daemon ids a resolver is already looking for. */
	resolving: ReadonlySet<string>;
}

const RESOLVED_LATER = ["codex", "opencode"];

/** The running Codex/OpenCode daemon sessions that are not linked, not a known session, and not being resolved. */
export function orphanDaemonSessions(daemon: readonly DaemonSession[], known: KnownSessions): DaemonSession[] {
	return daemon.filter(
		(s) =>
			RESOLVED_LATER.includes(s.agent) &&
			s.exited === null &&
			typeof s.pid === "number" &&
			!known.linkedDaemonIds.has(s.id) &&
			!known.sessionIds.has(s.id) &&
			!known.resolving.has(s.id)
	);
}

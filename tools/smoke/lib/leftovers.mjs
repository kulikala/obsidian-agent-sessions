// Which sessions in the daemon's list are left over from an earlier smoke run.
//
// `run.mjs` ships this function's source into Obsidian (`Function.prototype.toString`) as
// `globalThis.__smokeDecideLeftovers`, so it must stay one self-contained function: no imports,
// no references to anything outside its own body.

/**
 * `sessions` is the daemon's `list` (`{ id, exited, ... }`, `exited` null while running).
 * Returns the ids to end (still running) and to forget (every match, running or not).
 */
export function decideLeftovers(sessions, prefix) {
	const mine = (Array.isArray(sessions) ? sessions : []).filter((s) => s && typeof s.id === "string" && s.id.startsWith(prefix));
	return {
		kill: mine.filter((s) => s.exited === null || s.exited === undefined).map((s) => s.id),
		forget: mine.map((s) => s.id),
	};
}

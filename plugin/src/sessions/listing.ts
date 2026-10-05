// Which sessions the Session Manager lists — one rule, shared by its tree, its per-category
// totals, the side panel's recent list, and the activity calendar, so they all show the same set.
// No dependency on `obsidian` (tested in test/sessions/listing.test.ts).

/** What the rule needs of a session. */
export interface Listable {
	name: string | null;
	/** Started by another session (a sub-agent, `claude -p`, a Codex companion task) rather than by a person. */
	child: boolean;
	archived: boolean;
}

/** A child session nobody named: spawned by another session and never adopted by the user. */
export function isUnnamedChild(row: Pick<Listable, "name" | "child">): boolean {
	return !row.name && row.child;
}

/**
 * Whether the Session Manager lists `row`. An archived session only shows with "Show archived"
 * (`showArchived`); every other session shows unless it is an unnamed child. (A named child
 * counts as the user's own: they named it.)
 */
export function listedInManager(row: Listable, opts: { showArchived?: boolean } = {}): boolean {
	if (row.archived) {
		return opts.showArchived === true;
	}
	return !isUnnamedChild(row);
}

// What a plugin reload would interrupt: text being typed. `noteKey` is called on every keydown
// in the plugin's terminal tabs and its built-in editor pane (one number written, nothing else);
// `summarizeReloadSafety` turns the open tabs' state into the answer `plugin.reloadSafety()`
// gives. No dependency on `obsidian` (tested in test/terminal/reload-safety.test.ts).

let lastKeyAt: number | null = null;

/** Records that a key was just typed into one of the plugin's terminals or its editor pane. */
export function noteKey(now: number = Date.now()): void {
	lastKeyAt = now;
}

/** Milliseconds since the last recorded key; `null` when none was recorded since the plugin loaded. */
export function msSinceKey(now: number = Date.now()): number | null {
	return lastKeyAt === null ? null : Math.max(0, now - lastKeyAt);
}

/** Forgets the recorded key (for tests). */
export function resetKeyClock(): void {
	lastKeyAt = null;
}

export interface ReloadSafety {
	/** A built-in editor pane (Ctrl+G) is open in some tab. */
	editorOpen: boolean;
	/** Milliseconds since a key was last typed into a terminal tab or the editor pane; `null` if none was. */
	recentKeyMs: number | null;
	/** Names of the sessions whose prompt line currently holds text that wasn't sent. */
	drafts: string[];
}

export interface TabState {
	name: string;
	editorOpen: boolean;
	/** `null` when the tab shows no prompt line to judge. */
	hasDraft: boolean | null;
}

export function summarizeReloadSafety(tabs: readonly TabState[], sinceKeyMs: number | null): ReloadSafety {
	return {
		editorOpen: tabs.some((t) => t.editorOpen),
		recentKeyMs: sinceKeyMs,
		drafts: tabs.filter((t) => t.hasDraft === true).map((t) => t.name),
	};
}

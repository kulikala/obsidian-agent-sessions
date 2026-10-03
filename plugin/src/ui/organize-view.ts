// The organize dialog shows one of three views at a time; this is the pure part of switching.

export type OrganizeView = "start" | "working" | "result";

/**
 * Where the dialog goes when a run ends: to the results when it produced some, otherwise back to
 * the view it was started from (failure, cancel or an empty answer), so nothing already on screen is lost.
 */
export function viewAfterRun(from: OrganizeView, produced: boolean): OrganizeView {
	return produced ? "result" : from === "working" ? "start" : from;
}

export interface ReviewState {
	checked: number;
	unchecked: number;
	/** Apply selected needs at least one ticked row. */
	canApply: boolean;
	/** The overall comment and "Suggest again for unchecked" belong to a result with unticked rows. */
	showResuggest: boolean;
}

/** What the result view offers, from each row's tick. */
export function reviewState(ticks: boolean[]): ReviewState {
	const checked = ticks.filter(Boolean).length;
	const unchecked = ticks.length - checked;
	return { checked, unchecked, canApply: checked > 0, showResuggest: unchecked > 0 };
}

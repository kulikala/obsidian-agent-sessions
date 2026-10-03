// The organize dialog shows one of three views at a time; this is the pure part of switching.

export type OrganizeView = "start" | "working" | "result";

/**
 * Where the dialog goes when a run ends: to the results when it produced some, otherwise back to
 * the view it was started from (failure, cancel or an empty answer), so nothing already on screen is lost.
 */
export function viewAfterRun(from: OrganizeView, produced: boolean): OrganizeView {
	return produced ? "result" : from === "working" ? "start" : from;
}

// Debouncing input, with a way to force it early on commit. Used by `views/editor-pane.ts`'s
// built-in editor to autosave to a temp file whenever input settles. A pure class with nothing
// but a `setTimeout` — no dependency on the DOM or `obsidian` (kept testable, same reason as `marks.ts`).

/**
 * Calling `schedule()` repeatedly only lets `run` fire once `ms` has passed since the last
 * call — i.e. a debounce extended by every keystroke. On commit (send, or back to prompt), call
 * `flush()`, which cancels any pending timer and calls `run` immediately — so the autosave
 * write and the commit write never race (one finishes before the other starts, and neither
 * double-writes). Cancel calls only `cancel()` and never `run` (the caller writes something
 * else itself).
 */
export class SaveDebouncer {
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly ms: number,
		private readonly run: () => void
	) {}

	/** Input happened: cancels any pending timer and starts a new one. */
	schedule(): void {
		this.cancel();
		this.timer = setTimeout(() => {
			this.timer = null;
			this.run();
		}, this.ms);
	}

	/** Commit: cancels any pending timer, then calls `run` immediately. */
	flush(): void {
		this.cancel();
		this.run();
	}

	/** Cancels any pending timer only (never calls `run`). */
	cancel(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** Whether a timer is currently pending (for tests/debugging). */
	get pending(): boolean {
		return this.timer !== null;
	}
}

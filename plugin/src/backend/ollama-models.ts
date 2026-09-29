// The settings tab's cache of `ollama list`'s model names (OpenCode's "Ollama model" dropdown).
// One instance lives on the tab, so redrawing the page never starts another `ollama list`.

export class OllamaModelCache {
	/** The names once loaded; `null` until then. */
	list: string[] | null = null;
	private loading = false;
	private waiters: Array<() => void> = [];
	private generation = 0;

	/**
	 * Loads the list unless it is loaded already, then calls `onLoaded`. While a load is in
	 * flight, further calls only queue their `onLoaded` (a redraw during the load still gets
	 * told); once the list is there they return at once without calling it (the caller reads
	 * `list`). A failing `load` leaves an empty list (free text still works). A `reset()` that
	 * happens meanwhile drops the result and every queued `onLoaded`.
	 */
	async ensure(load: () => Promise<string[]>, onLoaded: () => void): Promise<void> {
		if (this.list !== null) {
			return;
		}
		this.waiters.push(onLoaded);
		if (this.loading) {
			return;
		}
		this.loading = true;
		const generation = this.generation;
		let names: string[];
		try {
			names = await load();
		} catch {
			names = [];
		}
		if (generation !== this.generation) {
			return;
		}
		this.loading = false;
		this.list = names;
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) {
			waiter();
		}
	}

	/** Forgets the list (the settings tab closed); the next `ensure` loads again. */
	reset(): void {
		this.list = null;
		this.loading = false;
		this.waiters = [];
		this.generation++;
	}
}

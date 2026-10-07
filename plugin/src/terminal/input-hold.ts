// Holds back what the user types into a tab while the plugin finishes a line of its own (the
// `/rename` a new, named Codex tab gets at start-up), so the two never mix in the agent's input
// box. Typed bytes are kept in order and written once the last hold is released. Pure apart from
// the `write` it is given; tested in plain Node (test/terminal/input-hold.test.ts).

export class InputHold {
	private queue: Buffer[] = [];
	private holds = 0;
	private waiters: (() => void)[] = [];

	constructor(private readonly write: (bytes: Buffer) => void) {}

	/** Whether input is being held. */
	get held(): boolean {
		return this.holds > 0;
	}

	/** Starts holding. Returns the release, which writes what was held once no other hold is left;
	 * calling it again does nothing. */
	hold(): () => void {
		this.holds++;
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.holds--;
			if (this.holds === 0) {
				const queued = this.queue;
				this.queue = [];
				for (const bytes of queued) {
					this.write(bytes);
				}
				const waiters = this.waiters;
				this.waiters = [];
				for (const resolve of waiters) {
					resolve();
				}
			}
		};
	}

	/** Resolves once nothing holds input (at once when nothing does). */
	free(): Promise<void> {
		return this.holds === 0 ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve));
	}

	/** Input from the user: written now, or kept while held. */
	input(bytes: Buffer): void {
		if (this.holds > 0) {
			this.queue.push(bytes);
		} else {
			this.write(bytes);
		}
	}
}

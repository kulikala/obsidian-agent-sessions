// Jump: remembers instructions (where the submit key was pressed) and the start of each
// response (`idle → busy`) as markers, so the UI can jump to the previous instruction, next
// instruction, or last response. Has no dependency on xterm — a pure class that receives a
// `MarkerSource` wrapping `registerMarker` from `views/terminal.ts`.

/** A minimal wrapper around xterm's `IMarker`. `isDisposed` is true once it's been disposed. */
export interface MarkerHandle {
	readonly line: number;
	readonly isDisposed: boolean;
}

export interface MarkerSource {
	registerMarker(): MarkerHandle | undefined;
}

export class MarkTracker {
	private instructions: MarkerHandle[] = [];
	private response: MarkerHandle | undefined;

	constructor(private source: MarkerSource) {}

	/**
	 * Places a marker where an instruction was sent. Called explicitly by `views/terminal.ts`'s
	 * `sendSubmit()` only when the submit key is pressed (not recorded from `onData`'s `\r`).
	 */
	markInstruction(): void {
		const marker = this.source.registerMarker();
		if (marker) {
			this.instructions.push(marker);
		}
	}

	/** Records the start of a response (`registry`'s `idle → busy`). Keeps only the most recent one. */
	onBusy(): void {
		const marker = this.source.registerMarker();
		if (marker) {
			this.response = marker;
		}
	}

	/** The nearest instruction's line above the top of the viewport (`viewportY`). `null` if there isn't one. */
	prev(viewportY: number): number | null {
		return this.nearest(viewportY, "up");
	}

	/** The nearest instruction's line below the top of the viewport (`viewportY`). `null` if there isn't one. */
	next(viewportY: number): number | null {
		return this.nearest(viewportY, "down");
	}

	/** The last response's starting line. `null` if it's been disposed. */
	lastResponse(): number | null {
		if (this.response?.isDisposed) {
			this.response = undefined;
		}
		return this.response ? this.response.line : null;
	}

	private nearest(viewportY: number, dir: "up" | "down"): number | null {
		this.instructions = this.instructions.filter((m) => !m.isDisposed);
		let best: number | null = null;
		for (const m of this.instructions) {
			const inRange = dir === "up" ? m.line < viewportY : m.line > viewportY;
			if (!inRange) {
				continue;
			}
			if (best === null || (dir === "up" ? m.line > best : m.line < best)) {
				best = m.line;
			}
		}
		return best;
	}
}

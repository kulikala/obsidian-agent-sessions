// ジャンプ（§6.7 D-13・D-41）。指示（送信キーが押された位置）と応答の先頭（`idle → busy`）を
// マーカーとして覚え、前の指示・次の指示・最後の応答へ飛べるようにする。xterm には依存しない——
// `registerMarker` を包んだ `MarkerSource` を `views/terminal.ts` から受け取る純クラス。

/** xterm の `IMarker` を包んだ最小形。破棄済みなら `isDisposed` が真。 */
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
	 * 指示を送った位置としてマーカーを打つ。`views/terminal.ts` の `sendSubmit()` から、
	 * 送信キーが押されたときだけ明示的に呼ばれる（`onData` の `\r` からは記録しない。§6.7）。
	 */
	markInstruction(): void {
		const marker = this.source.registerMarker();
		if (marker) {
			this.instructions.push(marker);
		}
	}

	/** 応答の先頭（`registry` の `idle → busy`）を記録する。最後の 1 つだけ保持する。 */
	onBusy(): void {
		const marker = this.source.registerMarker();
		if (marker) {
			this.response = marker;
		}
	}

	/** 表示先頭 `viewportY` より上で最も近い指示の行。無ければ `null`。 */
	prev(viewportY: number): number | null {
		return this.nearest(viewportY, "up");
	}

	/** 表示先頭 `viewportY` より下で最も近い指示の行。無ければ `null`。 */
	next(viewportY: number): number | null {
		return this.nearest(viewportY, "down");
	}

	/** 最後の応答の先頭行。破棄済みなら `null`。 */
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

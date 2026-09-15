// ジャンプ（§6.7 D-13）。指示（CR を含む入力）と応答の先頭（`idle → busy`）をマーカーとして
// 覚え、前の指示・次の指示・最後の応答へ飛べるようにする。xterm には依存しない——
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
	 * 入力に CR が含まれ、かつ括弧付きペースト中でなければ、指示の位置としてマーカーを打つ。
	 * ペースト内の改行や、Enter を伴わない入力は数えない。
	 */
	onInput(data: string, bracketedPasting: boolean): void {
		if (bracketedPasting || !data.includes("\r")) {
			return;
		}
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

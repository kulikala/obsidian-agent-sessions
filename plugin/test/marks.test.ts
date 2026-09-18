import { describe, expect, it } from "vitest";
import { MarkTracker, type MarkerHandle, type MarkerSource } from "../src/marks";

class FakeMarker implements MarkerHandle {
	isDisposed = false;
	constructor(public line: number) {}
}

class FakeSource implements MarkerSource {
	markers: FakeMarker[] = [];
	nextLine = 0;
	/** `undefined` を返すよう仕込むと「登録できない」状態を再現できる。 */
	fail = false;

	registerMarker(): MarkerHandle | undefined {
		if (this.fail) {
			return undefined;
		}
		const marker = new FakeMarker(this.nextLine);
		this.markers.push(marker);
		return marker;
	}
}

describe("MarkTracker（§6.7 ジャンプ）", () => {
	it("markInstruction を指示として記録する", () => {
		const source = new FakeSource();
		const tracker = new MarkTracker(source);
		source.nextLine = 5;
		tracker.markInstruction();
		expect(tracker.prev(10)).toBe(5);
	});

	it("3 回指示すると、前の指示は表示先頭に最も近いものから戻る", () => {
		const source = new FakeSource();
		const tracker = new MarkTracker(source);
		for (const line of [1, 5, 9]) {
			source.nextLine = line;
			tracker.markInstruction();
		}
		expect(tracker.prev(100)).toBe(9);
		expect(tracker.prev(9)).toBe(5);
		expect(tracker.prev(5)).toBe(1);
		expect(tracker.prev(1)).toBeNull();
	});

	it("次の指示は表示先頭より下で最も近いもの", () => {
		const source = new FakeSource();
		const tracker = new MarkTracker(source);
		for (const line of [1, 5, 9]) {
			source.nextLine = line;
			tracker.markInstruction();
		}
		expect(tracker.next(0)).toBe(1);
		expect(tracker.next(1)).toBe(5);
		expect(tracker.next(9)).toBeNull();
	});

	it("破棄済みのマーカーは前後どちらからも捨てる", () => {
		const source = new FakeSource();
		const tracker = new MarkTracker(source);
		source.nextLine = 1;
		tracker.markInstruction();
		source.nextLine = 5;
		tracker.markInstruction();
		source.markers[1].isDisposed = true;
		expect(tracker.prev(100)).toBe(1);
	});

	it("registerMarker が undefined を返しても壊れない", () => {
		const source = new FakeSource();
		source.fail = true;
		const tracker = new MarkTracker(source);
		tracker.markInstruction();
		tracker.onBusy();
		expect(tracker.prev(100)).toBeNull();
		expect(tracker.lastResponse()).toBeNull();
	});

	it("onBusy は最後の 1 つだけ保持する", () => {
		const source = new FakeSource();
		const tracker = new MarkTracker(source);
		source.nextLine = 2;
		tracker.onBusy();
		source.nextLine = 8;
		tracker.onBusy();
		expect(tracker.lastResponse()).toBe(8);
	});

	it("応答マーカーが破棄済みなら null", () => {
		const source = new FakeSource();
		const tracker = new MarkTracker(source);
		source.nextLine = 3;
		tracker.onBusy();
		source.markers[0].isDisposed = true;
		expect(tracker.lastResponse()).toBeNull();
	});
});

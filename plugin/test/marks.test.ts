import { describe, expect, it } from "vitest";
import { MarkTracker, type MarkerHandle, type MarkerSource } from "../src/marks";

class FakeMarker implements MarkerHandle {
	isDisposed = false;
	constructor(public line: number) {}
}

class FakeSource implements MarkerSource {
	markers: FakeMarker[] = [];
	nextLine = 0;
	/** Setting this makes registerMarker return `undefined`, simulating a state where registration fails. */
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

describe("MarkTracker (jump to marker)", () => {
	it("records markInstruction as an instruction mark", () => {
		const source = new FakeSource();
		const tracker = new MarkTracker(source);
		source.nextLine = 5;
		tracker.markInstruction();
		expect(tracker.prev(10)).toBe(5);
	});

	it("returns the previous instruction closest to the top of view first, after marking three times", () => {
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

	it("returns the next instruction as the closest one below the top of view", () => {
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

	it("drops a disposed marker from both prev and next", () => {
		const source = new FakeSource();
		const tracker = new MarkTracker(source);
		source.nextLine = 1;
		tracker.markInstruction();
		source.nextLine = 5;
		tracker.markInstruction();
		source.markers[1].isDisposed = true;
		expect(tracker.prev(100)).toBe(1);
	});

	it("does not break when registerMarker returns undefined", () => {
		const source = new FakeSource();
		source.fail = true;
		const tracker = new MarkTracker(source);
		tracker.markInstruction();
		tracker.onBusy();
		expect(tracker.prev(100)).toBeNull();
		expect(tracker.lastResponse()).toBeNull();
	});

	it("onBusy keeps only the most recent one", () => {
		const source = new FakeSource();
		const tracker = new MarkTracker(source);
		source.nextLine = 2;
		tracker.onBusy();
		source.nextLine = 8;
		tracker.onBusy();
		expect(tracker.lastResponse()).toBe(8);
	});

	it("is null when the response marker has been disposed", () => {
		const source = new FakeSource();
		const tracker = new MarkTracker(source);
		source.nextLine = 3;
		tracker.onBusy();
		source.markers[0].isDisposed = true;
		expect(tracker.lastResponse()).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import { computeSuggestPosition, type SuggestAnchorRect } from "../../src/ui/suggest-position";

function rect(overrides: Partial<SuggestAnchorRect> = {}): SuggestAnchorRect {
	return { left: 10, width: 300, top: 100, bottom: 130, ...overrides };
}

describe("computeSuggestPosition (T-104(e): the category-suggestion dropdown, portaled to <body>)", () => {
	it("carries the anchor's left/width through unchanged", () => {
		const pos = computeSuggestPosition(rect({ left: 42, width: 250 }), 1000, 224);
		expect(pos.left).toBe(42);
		expect(pos.width).toBe(250);
	});

	it("sits below the anchor (top set, bottom null) when there's plenty of room below", () => {
		const pos = computeSuggestPosition(rect({ bottom: 130 }), 1000, 224, 4);
		expect(pos.top).toBe(134);
		expect(pos.bottom).toBeNull();
	});

	it("flips above the anchor (bottom set, top null) when there isn't room below but there is above", () => {
		// A short viewport with the anchor near the bottom: only 50px below, but 700px above.
		const pos = computeSuggestPosition(rect({ top: 700, bottom: 730 }), 800, 224, 4);
		expect(pos.top).toBeNull();
		expect(pos.bottom).toBe(800 - 700 + 4);
	});

	it("does not flip when there's more room below than above, even if neither fits maxHeight", () => {
		// Anchor roughly centered in a short viewport: not enough room either way, but below
		// (116px) still beats above (96px), so it stays below rather than flipping to the smaller side.
		const pos = computeSuggestPosition(rect({ top: 100, bottom: 130 }), 250, 224, 4);
		expect(pos.top).toBe(134);
		expect(pos.bottom).toBeNull();
	});

	it("does not flip when there's exactly enough room below (boundary)", () => {
		const pos = computeSuggestPosition(rect({ top: 300, bottom: 330 }), 330 + 224 + 4, 224, 4);
		expect(pos.top).not.toBeNull();
		expect(pos.bottom).toBeNull();
	});

	it("uses margin consistently on both the below and flipped-above placements", () => {
		const below = computeSuggestPosition(rect({ bottom: 50 }), 1000, 224, 8);
		expect(below.top).toBe(58);
		const above = computeSuggestPosition(rect({ top: 900, bottom: 930 }), 950, 224, 8);
		expect(above.bottom).toBe(950 - 900 + 8);
	});
});

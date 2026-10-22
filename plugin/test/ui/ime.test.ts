import { describe, expect, it, vi } from "vitest";
import { ignoreWhileComposing } from "../../src/ui/ime";

const key = (k: string, extra: { isComposing?: boolean; keyCode?: number } = {}) => ({
	key: k,
	shiftKey: false,
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	...extra,
});

describe("ignoreWhileComposing", () => {
	it("skips Enter that commits an IME composition (isComposing)", () => {
		const handler = vi.fn();
		ignoreWhileComposing(handler)(key("Enter", { isComposing: true }));
		expect(handler).not.toHaveBeenCalled();
	});

	it("skips a composing keydown reported only as keyCode 229", () => {
		const handler = vi.fn();
		ignoreWhileComposing(handler)(key("Process", { keyCode: 229 }));
		ignoreWhileComposing(handler)(key("Enter", { keyCode: 229 }));
		expect(handler).not.toHaveBeenCalled();
	});

	it("skips the arrow keys, Tab and Escape while composing", () => {
		const handler = vi.fn();
		const guarded = ignoreWhileComposing(handler);
		for (const k of ["ArrowDown", "ArrowUp", "Tab", "Escape"]) {
			guarded(key(k, { isComposing: true }));
		}
		expect(handler).not.toHaveBeenCalled();
	});

	it("passes every keydown outside a composition through", () => {
		const handler = vi.fn();
		const guarded = ignoreWhileComposing(handler);
		const enter = key("Enter", { isComposing: false, keyCode: 13 });
		guarded(enter);
		guarded(key("ArrowDown"));
		expect(handler).toHaveBeenCalledTimes(2);
		expect(handler).toHaveBeenNthCalledWith(1, enter);
	});
});

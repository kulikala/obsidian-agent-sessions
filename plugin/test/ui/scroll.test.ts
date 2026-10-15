import { describe, expect, it } from "vitest";
import { keepScroll } from "../../src/ui/scroll";

describe("keepScroll", () => {
	it("puts the position back after a rebuild that reset it", () => {
		const el = { scrollTop: 480, scrollLeft: 12 };
		const out = keepScroll(el, () => {
			el.scrollTop = 0;
			el.scrollLeft = 0;
			return "rebuilt";
		});
		expect(out).toBe("rebuilt");
		expect(el).toEqual({ scrollTop: 480, scrollLeft: 12 });
	});
});

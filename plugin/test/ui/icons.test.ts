import { describe, expect, it } from "vitest";
import { moreIconId } from "../../src/ui/icons";

describe("moreIconId", () => {
	it("is horizontal on macOS and vertical elsewhere", () => {
		expect(moreIconId(true)).toBe("more-horizontal");
		expect(moreIconId(false)).toBe("more-vertical");
	});
});

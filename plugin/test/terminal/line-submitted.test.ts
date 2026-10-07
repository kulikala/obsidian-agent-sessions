import { describe, expect, it } from "vitest";
import { isTypedLine, lineState, TYPED_LINE_MAX } from "../../src/terminal/line-submitted";

describe("lineState", () => {
	const line = "/rename Race: One";

	it("is done when the composer is empty, and waits while there is none", () => {
		expect(lineState("", line)).toBe("done");
		expect(lineState(null, line)).toBe("wait");
	});

	it("asks for the submit key again while the composer still holds the line, wrapped or not", () => {
		expect(lineState("/rename Race: One", line)).toBe("resubmit");
		expect(lineState("/rename Race: O ne", line)).toBe("resubmit");
	});

	it("leaves anything else alone", () => {
		expect(lineState("/rename Race: OneReply with alpha", line)).toBe("other");
	});
});

describe("isTypedLine", () => {
	it("takes a short single line, not a multi-line or long one", () => {
		expect(isTypedLine("/new")).toBe(true);
		expect(isTypedLine("first\nsecond")).toBe(false);
		expect(isTypedLine("x".repeat(TYPED_LINE_MAX + 1))).toBe(false);
	});
});

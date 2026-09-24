import { describe, expect, it } from "vitest";
import { applyCompletion, findAtQuery, relPathFor } from "../src/at-complete";

describe("findAtQuery", () => {
	it("pulls out the query after an @ at the start of the line", () => {
		expect(findAtQuery("@des", 4)).toEqual({ start: 0, query: "des" });
	});

	it("targets an @ right after whitespace", () => {
		const text = "see @docs/de and";
		expect(findAtQuery(text, 12)).toEqual({ start: 4, query: "docs/de" });
	});

	it("still targets an @ immediately followed by the cursor (empty query)", () => {
		expect(findAtQuery("hi @", 4)).toEqual({ start: 3, query: "" });
	});

	it("doesn't target across a whitespace boundary", () => {
		expect(findAtQuery("@docs a", 7)).toBeNull();
	});

	it("doesn't target an @ in the middle of a word, like an email address", () => {
		expect(findAtQuery("foo@bar", 7)).toBeNull();
	});

	it("returns null when there's no @", () => {
		expect(findAtQuery("plain text", 5)).toBeNull();
	});

	it("uses only the text up to the cursor as the query, when the cursor is mid-word", () => {
		expect(findAtQuery("@abcdef", 3)).toEqual({ start: 0, query: "ab" });
	});
});

describe("applyCompletion", () => {
	it("replaces @query with @path plus a trailing space, and places the cursor right after it", () => {
		const out = applyCompletion("see @de now", 4, 7, "docs/design.md");
		expect(out.text).toBe("see @docs/design.md  now");
		expect(out.cursor).toBe(4 + "@docs/design.md ".length);
	});

	it("also replaces correctly at the end of the text", () => {
		const out = applyCompletion("@", 0, 1, "a.md");
		expect(out).toEqual({ text: "@a.md ", cursor: 6 });
	});
});

describe("relPathFor", () => {
	it("stays vault-relative when cwd is the vault root", () => {
		expect(relPathFor("/v", "docs/design.md", "/v")).toBe("docs/design.md");
	});

	it("walks up with ../ when cwd is below the vault root", () => {
		expect(relPathFor("/v", "docs/design.md", "/v/sub")).toBe("../docs/design.md");
	});

	it("uses an absolute path when cwd is outside the vault", () => {
		expect(relPathFor("/v", "docs/design.md", "/other")).toBe("/v/docs/design.md");
	});

	it("wraps the path in quotes when it contains a space", () => {
		expect(relPathFor("/v", "my notes/a b.md", "/v")).toBe('"my notes/a b.md"');
	});
});

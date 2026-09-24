import { describe, expect, it } from "vitest";
import { buildAtToken, findPathCandidates, resolveToVault, selectionLineRange } from "../src/links";

describe("findPathCandidates", () => {
	it("picks up a relative path with a line number", () => {
		const out = findPathCandidates("Error: see docs/design.md:10");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ text: "docs/design.md:10", path: "docs/design.md", line: 10 });
	});

	it("picks up a relative path starting with ./", () => {
		const out = findPathCandidates("See ./a/b.md here");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ text: "./a/b.md", path: "./a/b.md", line: undefined });
	});

	it("picks up an absolute path with line:column", () => {
		const out = findPathCandidates("Error at /abs/vault/x.md:3:4");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ text: "/abs/vault/x.md:3:4", path: "/abs/vault/x.md", line: 3 });
	});

	it("does not include a URL as a candidate", () => {
		const out = findPathCandidates("See https://example.com/docs/design.md:10 for details");
		expect(out).toHaveLength(0);
	});

	it("picks up only the path when both a URL and a path appear in the text", () => {
		const out = findPathCandidates("After viewing https://example.com/a.html, open docs/design.md");
		expect(out).toHaveLength(1);
		expect(out[0].path).toBe("docs/design.md");
	});

	it("does not include trailing punctuation in the candidate", () => {
		const out = findPathCandidates("See docs/design.md. Next up");
		expect(out).toHaveLength(1);
		expect(out[0].text).toBe("docs/design.md");
	});

	it("does not treat a word without an extension as a candidate", () => {
		const out = findPathCandidates("This is not README");
		expect(out).toHaveLength(0);
	});

	it("reports start/end as character-based offsets", () => {
		const prefix = "see ";
		const out = findPathCandidates(`${prefix}docs/design.md now`);
		expect(out[0].start).toBe(prefix.length);
		expect(out[0].end).toBe(prefix.length + "docs/design.md".length);
	});
});

describe("resolveToVault", () => {
	const vault = "/Users/me/vault";

	it("converts an absolute path under vault into a vault-relative path", () => {
		expect(resolveToVault("/Users/me/vault/docs/design.md", "/Users/me/vault", vault)).toBe("docs/design.md");
	});

	it("converts a path relative to cwd into a vault-relative path", () => {
		expect(resolveToVault("design.md", "/Users/me/vault/docs", vault)).toBe("docs/design.md");
	});

	it("normalizes a relative path containing `..`", () => {
		expect(resolveToVault("../docs/design.md", "/Users/me/vault/sub", vault)).toBe("docs/design.md");
	});

	it("returns null for an absolute path outside vault", () => {
		expect(resolveToVault("/etc/passwd", "/Users/me/vault", vault)).toBeNull();
	});

	it("returns null for a relative path that resolves outside vault", () => {
		expect(resolveToVault("../../etc/passwd", "/Users/me/vault", vault)).toBeNull();
	});
});

describe("buildAtToken (`@` mention insertion)", () => {
	it("converts to a path relative to cwd", () => {
		expect(buildAtToken("/Users/me/vault/docs/design.md", "/Users/me/vault", undefined)).toBe("docs/design.md");
	});

	it("keeps the absolute path when it falls outside cwd", () => {
		expect(buildAtToken("/Users/me/vault/docs/design.md", "/other/project", undefined)).toBe(
			"/Users/me/vault/docs/design.md"
		);
	});

	it("appends #L{from}-{to} (1-based) for a multi-line selection", () => {
		expect(buildAtToken("/v/docs/design.md", "/v", { from: 9, to: 19 })).toBe("docs/design.md#L10-20");
	});

	it("does not append a line range for a single-line selection", () => {
		expect(buildAtToken("/v/docs/design.md", "/v", { from: 4, to: 4 })).toBe("docs/design.md");
	});

	it("wraps a path containing whitespace in quotes", () => {
		expect(buildAtToken("/v/docs/my notes.md", "/v", undefined)).toBe('"docs/my notes.md"');
	});
});

describe("selectionLineRange", () => {
	it("returns a range only when the selection spans multiple lines", () => {
		const editor = { getCursor: (side: "from" | "to") => ({ line: side === "from" ? 2 : 5 }) };
		expect(selectionLineRange(editor)).toEqual({ from: 2, to: 5 });
	});

	it("returns undefined when it's the same line", () => {
		const editor = { getCursor: () => ({ line: 3 }) };
		expect(selectionLineRange(editor)).toBeUndefined();
	});
});

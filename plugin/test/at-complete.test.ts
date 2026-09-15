import { describe, expect, it } from "vitest";
import { applyCompletion, findAtQuery, relPathFor } from "../src/at-complete";

describe("findAtQuery（D-22）", () => {
	it("行頭の @ から検索語を切り出す", () => {
		expect(findAtQuery("@des", 4)).toEqual({ start: 0, query: "des" });
	});

	it("空白の直後の @ を対象にする", () => {
		const text = "see @docs/de and";
		expect(findAtQuery(text, 12)).toEqual({ start: 4, query: "docs/de" });
	});

	it("@ の直後（検索語が空）でも対象", () => {
		expect(findAtQuery("hi @", 4)).toEqual({ start: 3, query: "" });
	});

	it("空白をまたぐと対象外", () => {
		expect(findAtQuery("@docs a", 7)).toBeNull();
	});

	it("メールアドレスのような語中の @ は対象外", () => {
		expect(findAtQuery("foo@bar", 7)).toBeNull();
	});

	it("@ が無ければ null", () => {
		expect(findAtQuery("plain text", 5)).toBeNull();
	});

	it("カーソルが @ の途中にあれば、そこまでを検索語にする", () => {
		expect(findAtQuery("@abcdef", 3)).toEqual({ start: 0, query: "ab" });
	});
});

describe("applyCompletion", () => {
	it("@検索語 を @パス＋空白に置き換え、直後にカーソル", () => {
		const out = applyCompletion("see @de now", 4, 7, "docs/design.md");
		expect(out.text).toBe("see @docs/design.md  now");
		expect(out.cursor).toBe(4 + "@docs/design.md ".length);
	});

	it("末尾でも置き換える", () => {
		const out = applyCompletion("@", 0, 1, "a.md");
		expect(out).toEqual({ text: "@a.md ", cursor: 6 });
	});
});

describe("relPathFor", () => {
	it("cwd が vault なら vault 相対のまま", () => {
		expect(relPathFor("/v", "docs/design.md", "/v")).toBe("docs/design.md");
	});

	it("cwd が vault の下なら ../ で辿る", () => {
		expect(relPathFor("/v", "docs/design.md", "/v/sub")).toBe("../docs/design.md");
	});

	it("cwd が vault の外なら絶対パス", () => {
		expect(relPathFor("/v", "docs/design.md", "/other")).toBe("/v/docs/design.md");
	});

	it("空白を含めば引用符で囲む", () => {
		expect(relPathFor("/v", "my notes/a b.md", "/v")).toBe('"my notes/a b.md"');
	});
});

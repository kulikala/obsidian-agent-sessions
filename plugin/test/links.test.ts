import { describe, expect, it } from "vitest";
import { buildAtToken, findPathCandidates, resolveToVault, selectionLineRange } from "../src/links";

describe("findPathCandidates（§6.7）", () => {
	it("行番号付きの相対パスを拾う", () => {
		const out = findPathCandidates("エラー: docs/design.md:10 を見て");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ text: "docs/design.md:10", path: "docs/design.md", line: 10 });
	});

	it("./ で始まる相対パスを拾う", () => {
		const out = findPathCandidates("参照: ./a/b.md はここ");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ text: "./a/b.md", path: "./a/b.md", line: undefined });
	});

	it("行:桁付きの絶対パスを拾う", () => {
		const out = findPathCandidates("/abs/vault/x.md:3:4 でエラー");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ text: "/abs/vault/x.md:3:4", path: "/abs/vault/x.md", line: 3 });
	});

	it("URL は候補に含めない", () => {
		const out = findPathCandidates("詳細は https://example.com/docs/design.md:10 を参照");
		expect(out).toHaveLength(0);
	});

	it("文中の URL とパスが両方あれば、パスだけ拾う", () => {
		const out = findPathCandidates("https://example.com/a.html を見た後 docs/design.md を開く");
		expect(out).toHaveLength(1);
		expect(out[0].path).toBe("docs/design.md");
	});

	it("末尾の句読点を候補に含めない", () => {
		const out = findPathCandidates("見て docs/design.md。次へ");
		expect(out).toHaveLength(1);
		expect(out[0].text).toBe("docs/design.md");
	});

	it("拡張子の無い語は候補にしない", () => {
		const out = findPathCandidates("これは README ではない");
		expect(out).toHaveLength(0);
	});

	it("開始・終了位置は文字単位のオフセット", () => {
		const out = findPathCandidates("見て docs/design.md ね");
		expect(out[0].start).toBe(3);
		expect(out[0].end).toBe(3 + "docs/design.md".length);
	});
});

describe("resolveToVault（§6.7）", () => {
	const vault = "/Users/me/vault";

	it("vault 配下の絶対パスは vault 相対にする", () => {
		expect(resolveToVault("/Users/me/vault/docs/design.md", "/Users/me/vault", vault)).toBe("docs/design.md");
	});

	it("cwd からの相対パスを vault 相対にする", () => {
		expect(resolveToVault("design.md", "/Users/me/vault/docs", vault)).toBe("docs/design.md");
	});

	it("`..` を含む相対パスを正規化する", () => {
		expect(resolveToVault("../docs/design.md", "/Users/me/vault/sub", vault)).toBe("docs/design.md");
	});

	it("vault の外の絶対パスは null", () => {
		expect(resolveToVault("/etc/passwd", "/Users/me/vault", vault)).toBeNull();
	});

	it("vault の外へ出る相対パスは null", () => {
		expect(resolveToVault("../../etc/passwd", "/Users/me/vault", vault)).toBeNull();
	});
});

describe("buildAtToken（§6.7 `@` 挿入）", () => {
	it("cwd からの相対パスにする", () => {
		expect(buildAtToken("/Users/me/vault/docs/design.md", "/Users/me/vault", undefined)).toBe("docs/design.md");
	});

	it("cwd の外なら絶対パスのまま", () => {
		expect(buildAtToken("/Users/me/vault/docs/design.md", "/other/project", undefined)).toBe(
			"/Users/me/vault/docs/design.md"
		);
	});

	it("複数行選択なら #L{from}-{to}（1 始まり）を付ける", () => {
		expect(buildAtToken("/v/docs/design.md", "/v", { from: 9, to: 19 })).toBe("docs/design.md#L10-20");
	});

	it("1 行だけの選択には行範囲を付けない", () => {
		expect(buildAtToken("/v/docs/design.md", "/v", { from: 4, to: 4 })).toBe("docs/design.md");
	});

	it("空白を含むパスは引用符で囲む", () => {
		expect(buildAtToken("/v/docs/my notes.md", "/v", undefined)).toBe('"docs/my notes.md"');
	});
});

describe("selectionLineRange", () => {
	it("複数行にまたがるときだけ範囲を返す", () => {
		const editor = { getCursor: (side: "from" | "to") => ({ line: side === "from" ? 2 : 5 }) };
		expect(selectionLineRange(editor)).toEqual({ from: 2, to: 5 });
	});

	it("同じ行なら undefined", () => {
		const editor = { getCursor: () => ({ line: 3 }) };
		expect(selectionLineRange(editor)).toBeUndefined();
	});
});

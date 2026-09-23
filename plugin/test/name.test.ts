import { describe, expect, it } from "vitest";
import { composeName, listCategories } from "../src/name";
import { splitName } from "../src/tree";

describe("composeName", () => {
	it("カテゴリと名前を ': ' で組み立てる", () => {
		expect(composeName("スキル開発", "セッション管理")).toBe("スキル開発: セッション管理");
	});

	it("カテゴリが空なら名前だけ", () => {
		expect(composeName("", "セッション管理")).toBe("セッション管理");
	});

	it("カテゴリが空白だけでも名前だけ", () => {
		expect(composeName("   ", "セッション管理")).toBe("セッション管理");
	});

	it("名前が空ならカテゴリがあっても空文字", () => {
		expect(composeName("スキル開発", "")).toBe("");
		expect(composeName("スキル開発", "   ")).toBe("");
	});

	it("前後の空白を落とす", () => {
		expect(composeName(" スキル開発 ", " セッション管理 ")).toBe("スキル開発: セッション管理");
	});

	it("両方空なら空文字", () => {
		expect(composeName("", "")).toBe("");
	});
});

describe("composeName と splitName の往復", () => {
	it("カテゴリ有り", () => {
		const composed = composeName("RIM", "議事メモ作成");
		expect(splitName(composed)).toEqual(["RIM", "議事メモ作成"]);
	});

	it("カテゴリ無し", () => {
		const composed = composeName("", "酔い酒鮨庵");
		expect(splitName(composed)).toEqual([null, "酔い酒鮨庵"]);
	});
});

describe("listCategories", () => {
	it("名前からカテゴリを拾い、重複無く辞書順にする", () => {
		expect(
			listCategories(["RIM: 議事メモ作成", "RIM: 更新", "ZERO: 提案", "単独のセッション", null, "", "ZERO: 続き"])
		).toEqual(["RIM", "ZERO"]);
	});

	it("カテゴリが無ければ空配列", () => {
		expect(listCategories(["単独", null, undefined, ""])).toEqual([]);
	});

	it("五十音順に並べる", () => {
		expect(listCategories(["う: a", "あ: b", "い: c"])).toEqual(["あ", "い", "う"]);
	});
});

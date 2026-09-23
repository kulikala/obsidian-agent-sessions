import { describe, expect, it } from "vitest";
import { composeName, filterCategories, listCategories, tokenizeNameInput } from "../src/name";
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

describe("tokenizeNameInput（T-70：命名ダイアログの単一入力欄）", () => {
	it("半角 `:` はその時点で区切り（続く空白は要らない）", () => {
		expect(tokenizeNameInput("カテゴリ:名前")).toEqual({ category: "カテゴリ", rest: "名前" });
	});

	it("半角 `:` の後に空白が有っても区切りは同じ（空白は落とす）", () => {
		expect(tokenizeNameInput("カテゴリ: 名前")).toEqual({ category: "カテゴリ", rest: "名前" });
		expect(tokenizeNameInput("カテゴリ: ")).toEqual({ category: "カテゴリ", rest: "" });
	});

	it("全角 `：` は直後に空白が来て初めて区切り", () => {
		expect(tokenizeNameInput("カテゴリ： 名前")).toEqual({ category: "カテゴリ", rest: "名前" });
	});

	it("全角 `：` の直後に空白が無ければ、まだ区切らない（null）", () => {
		expect(tokenizeNameInput("カテゴリ：名前")).toBeNull();
	});

	it("コロンが無ければ null（まだカテゴリを入力中）", () => {
		expect(tokenizeNameInput("カテゴリ")).toBeNull();
		expect(tokenizeNameInput("")).toBeNull();
	});

	it("カテゴリ側の前後の空白は落とす", () => {
		expect(tokenizeNameInput(" カテゴリ :名前")).toEqual({ category: "カテゴリ", rest: "名前" });
	});
});

describe("filterCategories（T-70）", () => {
	it("部分一致・大小無視で絞り込む", () => {
		expect(filterCategories(["RIM", "ZERO", "rim2"], "rim")).toEqual(["RIM", "rim2"]);
	});

	it("空の問い合わせは全件をそのまま返す", () => {
		expect(filterCategories(["RIM", "ZERO"], "")).toEqual(["RIM", "ZERO"]);
		expect(filterCategories(["RIM", "ZERO"], "   ")).toEqual(["RIM", "ZERO"]);
	});

	it("一致が無ければ空配列", () => {
		expect(filterCategories(["RIM", "ZERO"], "no-match")).toEqual([]);
	});
});

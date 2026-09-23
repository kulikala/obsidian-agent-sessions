// 名前の組み立て・カテゴリ候補（純関数、D-63）。ダイアログの「カテゴリ」「名前」2 欄と
// `splitName`（`tree.ts`）を行き来する。

import { splitName } from "./tree";

/**
 * カテゴリと名前から `"カテゴリ: 名前"` を組み立てる（`splitName` の逆）。
 * 名前が空なら（カテゴリだけでも）空文字を返す——名前の無いセッションと同じ扱い。
 * カテゴリが空なら名前だけ。前後の空白はどちらも落とす。
 */
export function composeName(category: string, name: string): string {
	const trimmedName = name.trim();
	if (!trimmedName) {
		return "";
	}
	const trimmedCategory = category.trim();
	if (!trimmedCategory) {
		return trimmedName;
	}
	return `${trimmedCategory}: ${trimmedName}`;
}

/** 名前の並び（`Row.name` 相当）から、既存のカテゴリ候補を重複無く辞書順で作る。 */
export function listCategories(names: (string | null | undefined)[]): string[] {
	const set = new Set<string>();
	for (const name of names) {
		if (!name) {
			continue;
		}
		const [category] = splitName(name);
		if (category) {
			set.add(category);
		}
	}
	return [...set].sort((a, b) => a.localeCompare(b, "ja"));
}

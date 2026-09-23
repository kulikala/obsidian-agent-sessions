// 名前の組み立て・カテゴリ候補（純関数、D-63・T-70）。ダイアログの 1 つの入力欄と
// `splitName`（`tree.ts`）を行き来する。

import { t } from "./i18n";
import { splitName } from "./tree";

/**
 * タブ見出しに出す表示名（T-72）。`Row.name`（または `TerminalView` の控え）があればそれ、
 * 無ければ「無題 <id8>」。`terminal.ts` の `getDisplayText()` と `main.ts` の deferred タブ
 * 直しの両方で使う——どちらも同じ規則で名前を決めるため。
 */
export function sessionDisplayName(name: string | null | undefined, id: string): string {
	return name || t("common.untitled", { id: id.slice(0, 8) });
}

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

export interface NameInputToken {
	category: string;
	rest: string;
}

/** 全角コロンの直後に空白が来て初めて区切りと認める（IME の変換途中で `：` だけが
 * 先に入ることがあるため）。半角 `:` は確定した時点で区切り（続く空白は要らない）。 */
const FULL_WIDTH_COLON_SPACE_RE = /：\s/;

/**
 * 命名ダイアログの単一入力欄の生テキストから「カテゴリ: 名前」の区切りを見つける
 * （T-70）。半角 `:` が有れば、その時点で区切り（前がカテゴリ、後ろが名前）。無ければ
 * 全角 `：` の直後に空白が来た時点で区切る。どちらも無ければ `null`（まだカテゴリを
 * 入力中——呼出側は候補を出し続ける）。区切り文字自身（コロン・空白）は前後どちらにも残さない。
 */
export function tokenizeNameInput(text: string): NameInputToken | null {
	const halfIdx = text.indexOf(":");
	if (halfIdx >= 0) {
		return { category: text.slice(0, halfIdx).trim(), rest: text.slice(halfIdx + 1).replace(/^\s+/, "") };
	}
	const fullMatch = FULL_WIDTH_COLON_SPACE_RE.exec(text);
	if (fullMatch) {
		return {
			category: text.slice(0, fullMatch.index).trim(),
			rest: text.slice(fullMatch.index + fullMatch[0].length),
		};
	}
	return null;
}

/** カテゴリ入力中の候補：`categories` を部分一致・大小無視で絞り込む（空なら全件）。 */
export function filterCategories(categories: string[], query: string): string[] {
	const q = query.trim().toLowerCase();
	if (!q) {
		return categories;
	}
	return categories.filter((c) => c.toLowerCase().includes(q));
}

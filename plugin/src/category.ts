// カテゴリ名から表示色を決める（T-70）。カテゴリ → パレット番号の割当は `sessions.json` の
// `categoryColors`（`store.ts`）に保存し、一度決めたら変えない——サイドとマネージャーで
// 同じカテゴリが常に同じ色になる。チップの背景・文字色は色相だけを変え、彩度・明度は
// 固定にする（呼出側が `hsl({hue} 40% 50% / 0.18)` の背景・`hsl({hue} 45% 60%)` の文字にする）。
// `obsidian` には依存しない（純関数。テストは test/category.test.ts）。

export const PALETTE_SIZE = 12;
const HUE_STEP = 360 / PALETTE_SIZE;

/** パレット番号（0〜11）の実際の色相角度（0〜330、30 刻み）。 */
export function paletteHueDeg(index: number): number {
	const normalized = ((index % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
	return normalized * HUE_STEP;
}

/**
 * `category` に割り当てるパレット番号を返す。`colors`（カテゴリ名→番号）に既にあれば、
 * それを不変のまま返す。無ければ新規割当：まだ使われていない番号のうち最小のもの。
 * 12 個すべて使われていたら、使用回数が最も少ない番号（同数なら番号が小さいほう）。
 * `colors` はその場で書き換える（呼出側が `Store.categoryColors` をそのまま渡す想定）。
 */
export function assignCategoryColor(colors: Record<string, number>, category: string): number {
	const existing = colors[category];
	if (existing !== undefined) {
		return existing;
	}
	const counts = new Array<number>(PALETTE_SIZE).fill(0);
	for (const index of Object.values(colors)) {
		if (Number.isInteger(index) && index >= 0 && index < PALETTE_SIZE) {
			counts[index]++;
		}
	}
	let chosen = counts.indexOf(0);
	if (chosen === -1) {
		chosen = counts.indexOf(Math.min(...counts));
	}
	colors[category] = chosen;
	return chosen;
}

/**
 * `categories` それぞれに（`colors` に無ければ）番号を割り当てる。1 つでも新規に
 * 割り当てたら真を返す（呼出側はそのときだけ `sessions.json` に書き戻せばよい）。
 */
export function ensureCategoryColors(colors: Record<string, number>, categories: string[]): boolean {
	let changed = false;
	for (const category of categories) {
		if (colors[category] === undefined) {
			assignCategoryColor(colors, category);
			changed = true;
		}
	}
	return changed;
}

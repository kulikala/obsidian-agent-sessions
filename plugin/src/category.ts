// カテゴリ名から表示色を決める（D-65）。カテゴリ＝名前の `: ` より前（`tree.ts` の
// `splitName` と同じ）。チップの背景・文字色は色相だけを変え、彩度・明度は固定にする
// （呼出側が `hsl({hue} 40% 50% / 0.18)` の背景・`hsl({hue} 45% 60%)` の文字にする）。
// `obsidian` には依存しない（純関数。テストは test/category.test.ts）。

const HUE_BUCKETS = 12;
const HUE_STEP = 360 / HUE_BUCKETS;

/** 文字コードを畳み込むだけの簡易ハッシュ。同じ文字列は常に同じ値。 */
function hashString(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) {
		h = (h * 31 + name.charCodeAt(i)) | 0;
	}
	return Math.abs(h);
}

/** `name` の色相の通し番号（0〜11）。実際の角度は `categoryHue(name) * 30`。 */
export function categoryHue(name: string): number {
	return hashString(name) % HUE_BUCKETS;
}

/** `categoryHue` を実際の色相角度（0〜330、30 刻み）にする。 */
export function categoryHueDeg(name: string): number {
	return categoryHue(name) * HUE_STEP;
}

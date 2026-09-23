// カテゴリのチップ 1 つの描画（T-70）。サイド（`views/rows.ts`）・マネージャー
// （`views/manager.ts`）・命名ダイアログ（`modals.ts`）で共通の見た目にするための、
// DOM を組み立てるだけの小さな関数。`modals.ts` と `views/rows.ts` の両方から使うため
// 循環 import を避けてここに独立させる（`rows.ts` は `modals.ts` の `RenameSessionModal` を、
// `modals.ts` はチップの描画を、互いに要る）。

import { paletteHueDeg } from "./category";

/** 色は `colorIndex`（`SessionIndex.categoryColorIndex` のパレット番号）が決める。 */
export function renderCategoryChip(container: HTMLElement, category: string, colorIndex: number): HTMLElement {
	const chip = container.createSpan({ cls: "agent-sessions-row-chip", text: category });
	chip.style.setProperty("--as-chip-hue", String(paletteHueDeg(colorIndex)));
	return chip;
}

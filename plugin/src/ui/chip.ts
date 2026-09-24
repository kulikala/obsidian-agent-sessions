// Renders a single category chip. A small DOM-building function shared by the side panel
// (`views/rows.ts`), the manager (`views/manager.ts`), and the naming dialog (`modals.ts`) so
// they all look the same. Kept in its own module, separate from `modals.ts` and `views/rows.ts`,
// to avoid a circular import between them (`rows.ts` needs `modals.ts`'s `RenameSessionModal`,
// and `modals.ts` needs the chip renderer — each would need the other).

import { paletteHueDeg } from "../sessions/category";

/** The color comes from `colorIndex` (a palette slot from `SessionIndex.categoryColorIndex`). */
export function renderCategoryChip(container: HTMLElement, category: string, colorIndex: number): HTMLElement {
	const chip = container.createSpan({ cls: "agent-sessions-row-chip", text: category });
	chip.style.setProperty("--as-chip-hue", String(paletteHueDeg(colorIndex)));
	return chip;
}

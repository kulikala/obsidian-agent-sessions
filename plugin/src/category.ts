// Picks a display color for a category name. The category → palette-slot assignment is stored
// in `sessions.json`'s `categoryColors` (`store.ts`) and never changes once made — so the same
// category always gets the same color in both the side panel and the manager. Chips vary only
// hue; saturation and lightness are fixed (callers use `hsl({hue} 40% 50% / 0.18)` for the
// background and `hsl({hue} 45% 60%)` for the text). No dependency on `obsidian` (pure
// functions; tested in test/category.test.ts).

export const PALETTE_SIZE = 12;
const HUE_STEP = 360 / PALETTE_SIZE;

/** The actual hue angle (0-330, in 30-degree steps) for a palette slot (0-11). */
export function paletteHueDeg(index: number): number {
	const normalized = ((index % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
	return normalized * HUE_STEP;
}

/**
 * Returns the palette slot assigned to `category`. If `colors` (category name → slot) already
 * has one, returns it unchanged. Otherwise assigns a new one: the lowest-numbered slot not yet
 * in use, or — once all 12 are in use — whichever slot is used least often (ties go to the
 * lower number). Mutates `colors` in place (callers are expected to pass `Store.categoryColors` directly).
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
 * Assigns a slot to each of `categories` that doesn't already have one in `colors`. Returns
 * true if anything new was assigned (callers only need to write back to `sessions.json` then).
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

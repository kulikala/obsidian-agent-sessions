// Building names and category suggestions (pure functions). Bridges the naming dialog's single
// input field and `splitName` (`tree.ts`).

import { t } from "./i18n";
import { splitName } from "./tree";

/**
 * The display name shown in a tab header. Uses `Row.name` (or `TerminalView`'s own copy of it)
 * if there is one, otherwise "Untitled <id8>". Used both by `terminal.ts`'s `getDisplayText()`
 * and by `main.ts`'s deferred-tab fixup, so both derive the name the same way.
 */
export function sessionDisplayName(name: string | null | undefined, id: string): string {
	return name || t("common.untitled", { id: id.slice(0, 8) });
}

/**
 * Builds `"Category: Name"` from a category and a name (the inverse of `splitName`). Returns an
 * empty string if the name is empty, even with a category given — treated the same as a
 * nameless session. With no category, returns just the name. Trims both.
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

/** Builds a deduplicated, alphabetically sorted list of existing category candidates from a list of names (`Row.name`-shaped). */
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

/** Only recognizes a full-width colon as the separator once it's followed by a space (during
 * IME composition, `：` alone can land before the rest is confirmed). A half-width `:` is a
 * separator as soon as it's typed (no trailing space needed). */
const FULL_WIDTH_COLON_SPACE_RE = /：\s/;

/**
 * Finds the "Category: Name" split point in the naming dialog's single input field's raw text.
 * A half-width `:` is the split point as soon as it appears (category before, name after).
 * Otherwise, a full-width `：` followed by a space is the split point. If neither is present,
 * returns `null` (the category is still being typed — the caller keeps showing suggestions).
 * The separator itself (colon and space) is dropped from both sides.
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

/** Suggestions while typing a category: filters `categories` by case-insensitive substring match (returns everything if `query` is empty). */
export function filterCategories(categories: string[], query: string): string[] {
	const q = query.trim().toLowerCase();
	if (!q) {
		return categories;
	}
	return categories.filter((c) => c.toLowerCase().includes(q));
}

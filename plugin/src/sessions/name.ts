// Building names and category suggestions (pure functions). Bridges the naming dialog's single
// input field and `splitName` (`tree.ts`).

import { t, type MessageKey } from "../i18n";
import { asAgentId } from "../settings";
import { splitName } from "./tree";

/** What `sessionDisplayName` needs — a `Row` already has all four fields, so it can be passed
 * directly; `TerminalView` keeps its own small cached copies of `name`/`label` for the same
 * shape (`refreshName()`). */
export interface DisplayNameInput {
	name?: string | null;
	label?: string | null;
	agent: string;
	id: string;
}

/** "New {agent's display name} session" — shown when neither `name` nor `label` has anything
 * real yet (`common.newSession.<agent>`, i18n; an unrecognized agent id falls back to Claude's,
 * same as `asAgentId`). */
const NEW_SESSION_KEY: Record<ReturnType<typeof asAgentId>, MessageKey> = {
	claude: "common.newSession.claude",
	codex: "common.newSession.codex",
};

/**
 * The display name shown wherever a session needs one — tab title, side panel row, manager row,
 * detail pane, notifications, row menu, archive entries (T-106): `name` (`/rename`, or Claude
 * Code's/Codex's own title) if there is one, otherwise `label` (the auto-derived name — usually
 * the first prompt, truncated) if that's real content, otherwise "New Claude Code session"/
 * "New Codex session" (by agent). The session's own `id` is never shown as its name — a `label`
 * that happens to equal `id` (Python couldn't extract anything real from this session, so it
 * fell back to the id itself) is treated the same as an empty one, not real content.
 */
export function sessionDisplayName(session: DisplayNameInput): string {
	if (session.name) {
		return session.name;
	}
	if (session.label && session.label !== session.id) {
		return session.label;
	}
	return t(NEW_SESSION_KEY[asAgentId(session.agent)]);
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

/**
 * Suggestions while typing a category: case-insensitive prefix matches first (in their original
 * order), then case-insensitive substring matches that aren't already a prefix match (also in
 * their original order). Returns everything, unfiltered, if `query` is empty.
 */
export function filterCategories(categories: string[], query: string): string[] {
	const q = query.trim().toLowerCase();
	if (!q) {
		return categories;
	}
	const prefix: string[] = [];
	const substring: string[] = [];
	for (const c of categories) {
		const lower = c.toLowerCase();
		if (lower.startsWith(q)) {
			prefix.push(c);
		} else if (lower.includes(q)) {
			substring.push(c);
		}
	}
	return [...prefix, ...substring];
}

/**
 * The label "Move to category" attaches a category prefix to: the name's own label if the
 * session has already been named (`splitName`'s second element), otherwise the row's
 * auto-derived label (the first prompt, truncated) — never `sessionDisplayName`'s "New Claude
 * Code session"/"New Codex session" fallback, which isn't real content to categorize. Empty when
 * there's nothing yet to attach a category to (the caller disables the action in that case
 * rather than inventing a label).
 */
export function categorizableLabel(row: { name: string | null; label: string | null }): string {
	if (row.name) {
		return splitName(row.name)[1];
	}
	return row.label ?? "";
}

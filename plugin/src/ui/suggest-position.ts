// Pure positioning math for the category-suggestion dropdown (`modals.ts`'s `buildCategorySuggest`,
// T-104(e)). Kept separate from `modals.ts` (which imports `obsidian` eagerly and so can't be
// unit-tested directly) purely so this part is.

export interface SuggestAnchorRect {
	left: number;
	width: number;
	top: number;
	bottom: number;
}

export interface SuggestPosition {
	left: number;
	width: number;
	/** Exactly one of these is non-null: `top` (below the anchor, the usual case) or `bottom`
	 * (above it, when flipped) — both are plain CSS pixel values for a `position: fixed` element. */
	top: number | null;
	bottom: number | null;
}

/**
 * Where to place the dropdown, below `anchor` by `margin` unless there isn't `maxHeight` of room
 * left in the viewport below it *and* there's more room above than below — in which case it
 * flips to sit above the anchor instead. `maxHeight` is the dropdown's own CSS `max-height` (not
 * its current, possibly-smaller content height), so a flip decision doesn't change as the list is
 * filtered while already open.
 */
export function computeSuggestPosition(
	anchor: SuggestAnchorRect,
	viewportHeight: number,
	maxHeight: number,
	margin = 4
): SuggestPosition {
	const spaceBelow = viewportHeight - anchor.bottom - margin;
	const spaceAbove = anchor.top - margin;
	const flip = spaceBelow < maxHeight && spaceAbove > spaceBelow;
	return {
		left: anchor.left,
		width: anchor.width,
		top: flip ? null : anchor.bottom + margin,
		bottom: flip ? viewportHeight - anchor.top + margin : null,
	};
}

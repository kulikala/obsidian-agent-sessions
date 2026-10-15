// Keeping a scrolled list where the user left it while its content is rebuilt.

interface Scrollable {
	scrollTop: number;
	scrollLeft: number;
}

/** Runs `rebuild` and puts `el`'s scroll position back afterwards: emptying a list shortens it for a
 * moment, and the browser clamps the position to the shorter content. */
export function keepScroll<T>(el: Scrollable, rebuild: () => T): T {
	const top = el.scrollTop;
	const left = el.scrollLeft;
	const result = rebuild();
	el.scrollTop = top;
	el.scrollLeft = left;
	return result;
}

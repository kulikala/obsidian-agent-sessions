// Text helpers shared by the checks: Japanese detection, quoted spans, comments, globs and lines.

/** Kana, kanji and CJK punctuation (the ideographic comma, full stop, corner brackets and the
 * like): what counts as Japanese text. */
export const JAPANESE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;
const JAPANESE_G = new RegExp(JAPANESE.source, "g");
/** Kana and kanji without punctuation (the katakana middle dot is punctuation): the letters the
 * spacing rule is about. */
export const JAPANESE_LETTER = /[\u3040-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;

export function lines(text) {
	return text.split(/\r?\n/);
}

/** `*` matches within one path segment, `**` across segments. */
export function globToRegExp(glob) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
			i += glob[i + 2] === "/" ? 2 : 1;
		} else if (c === "*") {
			re += "[^/]*";
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

export function matchesAny(file, globs) {
	return globs.some((g) => globToRegExp(g).test(file));
}

const QUOTE_PAIRS = [
	['"', '"'],
	["`", "`"],
	["\u300c", "\u300d"],
	["\u300e", "\u300f"],
	["\u201c", "\u201d"],
];

/** The [start, end) spans of a line that sit inside quotes: straight double quotes, backticks,
 * corner brackets, curly double quotes, and single quotes when asked. */
export function quotedSpans(line, { singleQuotes = false } = {}) {
	const pairs = singleQuotes ? [...QUOTE_PAIRS, ["'", "'"]] : QUOTE_PAIRS;
	const spans = [];
	for (const [open, close] of pairs) {
		// A straight quote opened on an earlier line throws the pairing off by one, so those are
		// paired from the first and from the second occurrence alike.
		const starts = open === close ? [line.indexOf(open), line.indexOf(open, line.indexOf(open) + 1)] : [line.indexOf(open)];
		for (const first of starts) {
			let from = first;
			while (from >= 0) {
				const start = line.indexOf(open, from);
				if (start < 0) break;
				const end = line.indexOf(close, start + 1);
				if (end < 0) break;
				spans.push([start, end + 1]);
				from = end + 1;
			}
		}
	}
	return spans;
}

/**
 * Where the comment of each line starts (its index, or -1 for none), following block comments
 * (`/* … *\/`, and Python's triple-quoted docstrings) across lines. Strings are not parsed, so a
 * comment marker inside a string can mislead it; the language rule only needs it to be close.
 */
export function commentStarts(textLines, ext) {
	const python = ext === "py" || ext === "sh";
	let inBlock = false;
	return textLines.map((line) => {
		let from = -1;
		let i = 0;
		if (inBlock) from = 0;
		while (i < line.length) {
			if (inBlock) {
				const close = line.indexOf(python ? '"""' : "*/", i);
				if (close < 0) return from;
				inBlock = false;
				i = close + (python ? 3 : 2);
				continue;
			}
			if (python) {
				const hash = line.indexOf("#", i);
				const doc = line.indexOf('"""', i);
				if (doc >= 0 && (hash < 0 || doc < hash)) {
					if (from < 0) from = doc;
					inBlock = true;
					i = doc + 3;
					continue;
				}
				return hash >= 0 && from < 0 ? hash : from;
			}
			const lineComment = /(^|[\s;,(){}])\/\/(?!\/)/.exec(line.slice(i));
			const block = line.indexOf("/*", i);
			const lc = lineComment ? i + lineComment.index + lineComment[1].length : -1;
			if (block >= 0 && (lc < 0 || block < lc)) {
				if (from < 0) from = block;
				inBlock = true;
				i = block + 2;
				continue;
			}
			return lc >= 0 && from < 0 ? lc : from;
		}
		return from;
	});
}

/** The positions of the Japanese characters of a line. */
export function japaneseIndexes(line) {
	const out = [];
	for (const m of line.matchAll(JAPANESE_G)) out.push(m.index);
	return out;
}

export function inSpans(index, spans) {
	return spans.some(([s, e]) => index >= s && index < e);
}

/** Masks fenced code blocks of a Markdown text with empty lines, keeping the line numbers. */
export function maskFences(text) {
	let inFence = false;
	return lines(text).map((l) => {
		if (/^\s*(```|~~~)/.test(l)) {
			inFence = !inFence;
			return "";
		}
		return inFence ? "" : l;
	});
}

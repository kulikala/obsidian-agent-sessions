// One pass over every text file of the tree: privacy and secrets, the language rule, the
// user-visible denylist, leftover debugging, and file sizes.

import path from "node:path";

import { isBinary } from "../git.mjs";
import { scanLine } from "../privacy.mjs";
import { commentStarts, inSpans, japaneseIndexes, lines, maskFences, matchesAny, quotedSpans } from "../text.mjs";

const CODE_EXT = new Set(["ts", "tsx", "js", "mjs", "cjs", "py", "css", "sh"]);

/**
 * The Japanese a line holds against the language rule: none in files that are Japanese by
 * design or on an allowed line; elsewhere only quoted (or in a Markdown code block), and in code
 * only quoted inside a comment. `comment` is where the line's comment starts (-1 for none), and
 * `fenced` says the line sits in a Markdown code block. Returns the 1-based column of the first
 * offending character, or 0.
 */
export function languageViolation(file, line, config, { comment = -1, fenced = false } = {}) {
	let masked = line;
	for (const word of config.language.japaneseWords) masked = masked.split(word).join(" ".repeat(word.length));
	const indexes = japaneseIndexes(masked);
	if (indexes.length === 0) return 0;
	if (matchesAny(file, config.language.japaneseFiles.map((f) => f.path))) return 0;
	if (config.language.japaneseLines.some((l) => l.path === file && line.includes(l.contains))) return 0;
	if (fenced) return 0;
	const ext = path.extname(file).slice(1);
	const spans = quotedSpans(line, { singleQuotes: ext === "py" });
	const isCode = isCodeFile(file);
	for (const i of indexes) {
		const quoted = inSpans(i, spans);
		const ok = isCode ? quoted && comment >= 0 && i > comment : quoted;
		if (!ok) return i + 1;
	}
	return 0;
}

export function loadDenylist(entries) {
	return entries.map((e) => ({ ...e, re: new RegExp(e.pattern, e.flags || "") }));
}

function isCodeFile(file) {
	return CODE_EXT.has(path.extname(file).slice(1)) || /^bin\//.test(file);
}

const DEBUG_RE = /\bconsole\.(log|debug|trace)\(|^\s*debugger;/;
const ONLY_RE = /\b(describe|it|test|suite)\.only\(/;

export function checkTree({ tree, config, denylist, privacy, report }) {
	const secretsExempt = config.secrets.exempt;
	const files = tree.list();
	let scanned = 0;
	for (const { path: file, size } of files) {
		if (size > config.hygiene.largeFileBytes && !matchesAny(file, config.hygiene.largeFileExempt)) {
			report.fail("hygiene", file, `${(size / 1048576).toFixed(1)} MB, over the 1 MB limit outside docs/images`, "keep large files out of the repository, or shrink them");
		}
		const buffer = tree.read(file);
		if (!buffer || isBinary(buffer)) continue;
		scanned++;
		const text = buffer.toString("utf8");
		const userVisible = matchesAny(file, config.userVisible.files);
		const pluginSrc = file.startsWith("plugin/src/");
		const testFile = /(^|\/)(test|tests)\//.test(file) || /\.test\.[cm]?[jt]s$/.test(file);
		const secrets = !matchesAny(file, secretsExempt);
		const textLines = lines(text);
		const ext = /^bin\//.test(file) ? "py" : path.extname(file).slice(1);
		const comments = isCodeFile(file) ? commentStarts(textLines, ext) : textLines.map(() => -1);
		const unfenced = file.endsWith(".md") ? maskFences(text) : textLines;
		textLines.forEach((line, i) => {
			const where = `${file}:${i + 1}`;
			for (const f of scanLine(line, privacy, { secrets })) report.fail(f.check, where, f.message, f.fix);
			const col = languageViolation(file, line, config, { comment: comments[i], fenced: unfenced[i] !== line });
			if (col) {
				report.fail(
					"language",
					`${where}:${col}`,
					"Japanese outside the files that hold it",
					"write it in English; quote a Japanese example (\"…\" or `…`); or, if the program needs it, add the line to language.japaneseLines in tools/audit/config.json",
				);
			}
			if (userVisible) {
				for (const d of denylist) {
					if (d.re.test(line)) report.fail("denylist", where, `says "${line.match(d.re)[0]}"`, `use "${d.use}" (${d.why})`);
				}
			}
			if (pluginSrc && DEBUG_RE.test(line) && !matchesAny(file, config.hygiene.consoleAllowed)) {
				const c = comments[i];
				const m = DEBUG_RE.exec(line);
				if (c < 0 || m.index < c) report.fail("hygiene", where, "leftover debugging (console.log/debug/trace or debugger)", "remove it; use console.warn/error for what a user should be able to report");
			}
			if (testFile && ONLY_RE.test(line)) report.fail("hygiene", where, "a focused test (.only) skips the rest of the suite", "remove .only");
		});
	}
	return { files: files.length, scanned };
}

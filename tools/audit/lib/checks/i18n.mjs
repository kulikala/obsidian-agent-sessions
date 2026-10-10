// The plugin's and the program's locales: the same keys in English and Japanese, the same
// placeholders per key, no Japanese in English, and the spacing rule in Japanese.

import { spawnSync } from "node:child_process";

import { JAPANESE, JAPANESE_LETTER, lines } from "../text.mjs";

/** The object literal a TypeScript locale exports, evaluated as plain JavaScript. */
export function parseTsLocale(source) {
	const m = /export const \w+\s*(?::[^=]+)?=\s*(\{[\s\S]*?\n\})(?:\s+as const)?;/.exec(source);
	if (!m) throw new Error("no exported object literal");
	return new Function(`return (${m[1]});`)();
}

const PY_LOAD = `
import ast, json, sys
tree = ast.parse(sys.stdin.read())
for node in tree.body:
    if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "MESSAGES" for t in node.targets):
        print(json.dumps(ast.literal_eval(node.value)))
        break
`;

/** A Python locale's MESSAGES dict, read by Python's own parser. */
export function parsePyLocale(source) {
	const r = spawnSync("python3", ["-I", "-c", PY_LOAD], { input: source, encoding: "utf8" });
	if (r.status !== 0 || !r.stdout.trim()) throw new Error(r.stderr.trim() || "no MESSAGES dict");
	return JSON.parse(r.stdout);
}

/** A string's placeholders: `plain` ({n}, {n:,}) carry a value; `plural` ({count|one|other}) only
 * choose a word form, which a language without plurals leaves out. */
export function placeholders(text) {
	const plain = new Set();
	const plural = new Set();
	for (const m of text.matchAll(/\{(\w+)([|:][^}]*)?\}/g)) (m[2]?.startsWith("|") ? plural : plain).add(m[1]);
	return { plain, plural, all: new Set([...plain, ...plural]) };
}

/** Whether two strings of one key take the same values: every value one shows, the other knows. */
export function placeholdersMatch(a, b) {
	const pa = placeholders(a);
	const pb = placeholders(b);
	return [...pa.plain].every((n) => pb.all.has(n)) && [...pb.plain].every((n) => pa.all.has(n)) && [...pb.all].every((n) => pa.all.has(n));
}

/**
 * Where a Japanese string misses the half-width space between Japanese and Latin text. Letters
 * are failures; a digit is fine next to a counter (`5時間`, `最大30件`) and a warning elsewhere.
 * Placeholders, inline code, URLs and Markdown link targets are left out.
 */
export function spacingProblems(text, counters) {
	const masked = text
		.replace(/`[^`]*`/g, (s) => "\u0000".repeat(s.length))
		.replace(/\]\([^)]*\)/g, (s) => "]" + "\u0000".repeat(s.length - 1))
		.replace(/https?:\/\/\S+/g, (s) => "\u0000".repeat(s.length))
		.replace(/\{[^}]*\}/g, (s) => "\u0000".repeat(s.length));
	const out = [];
	for (let i = 0; i + 1 < masked.length; i++) {
		const a = masked[i];
		const b = masked[i + 1];
		const aj = JAPANESE_LETTER.test(a);
		const bj = JAPANESE_LETTER.test(b);
		if ((aj && /[A-Za-z]/.test(b)) || (/[A-Za-z]/.test(a) && bj)) {
			out.push({ index: i, level: "fail", text: text.slice(Math.max(0, i - 6), i + 8) });
		} else if (/\d/.test(a) && bj) {
			if (!counters.includes(b)) out.push({ index: i, level: "warn", text: text.slice(Math.max(0, i - 6), i + 8) });
		} else if (aj && /\d/.test(b)) {
			const after = /^[\d,.]+(.)/.exec(masked.slice(i + 1));
			if (after && counters.includes(after[1])) continue;
			out.push({ index: i, level: "warn", text: text.slice(Math.max(0, i - 6), i + 8) });
		}
	}
	return out;
}

function keyLine(source, key) {
	const needle = [`"${key}"`, `'${key}'`];
	const i = lines(source).findIndex((l) => needle.some((n) => l.includes(n)));
	return i + 1;
}

function compareLocales({ report, enFile, jaFile, en, ja, enSource, jaSource, counters }) {
	for (const key of Object.keys(en)) {
		if (!(key in ja)) report.fail("i18n", `${jaFile}`, `missing key "${key}"`, `add it with its Japanese text (en: "${String(en[key]).slice(0, 60)}")`);
		if (JAPANESE.test(String(en[key]))) report.fail("i18n", `${enFile}:${keyLine(enSource, key)}`, `Japanese in the English string "${key}"`, "write it in English");
	}
	for (const key of Object.keys(ja)) {
		const where = `${jaFile}:${keyLine(jaSource, key)}`;
		if (!(key in en)) {
			report.fail("i18n", where, `key "${key}" is not in ${enFile}`, "remove it, or add the English string");
			continue;
		}
		if (!placeholdersMatch(String(en[key]), String(ja[key]))) {
			const list = (t) => [...placeholders(t).all].sort().join(", ") || "none";
			report.fail("i18n", where, `placeholders differ for "${key}": en ${list(String(en[key]))} / ja ${list(String(ja[key]))}`, "use the same placeholders in both languages (a plural-only one may be left out)");
		}
		for (const p of spacingProblems(String(ja[key]), counters)) {
			const message = `no half-width space between Japanese and ${p.level === "fail" ? "Latin letters" : "a digit"} in "${key}": …${p.text}…`;
			if (p.level === "fail") report.fail("i18n", where, message, "put a half-width space between them");
			else report.warn("i18n", where, message, "add a space unless the digit belongs to the Japanese word");
		}
	}
}

export function checkI18n({ tree, config, report }) {
	const counters = config.spacing.counters;
	const read = (p) => tree.read(p)?.toString("utf8");
	const pairs = [
		["plugin/src/i18n/locales/en.ts", "plugin/src/i18n/locales/ja.ts", parseTsLocale],
		["agentsessions/i18n/locales/en.py", "agentsessions/i18n/locales/ja.py", parsePyLocale],
	];
	for (const [enFile, jaFile, parse] of pairs) {
		const enSource = read(enFile);
		const jaSource = read(jaFile);
		if (!enSource || !jaSource) {
			report.fail("i18n", enSource ? jaFile : enFile, "locale file missing");
			continue;
		}
		let en;
		let ja;
		try {
			en = parse(enSource);
			ja = parse(jaSource);
		} catch (err) {
			report.fail("i18n", jaFile, `could not read the locales: ${err.message}`);
			continue;
		}
		compareLocales({ report, enFile, jaFile, en, ja, enSource, jaSource, counters });
	}
	// README.ja.md: the same spacing rule for its prose (headings, paragraphs, lists, alt text).
	const readme = read("README.ja.md");
	if (readme) {
		let fence = false;
		lines(readme).forEach((line, i) => {
			if (/^\s*```/.test(line)) fence = !fence;
			if (fence) return;
			for (const p of spacingProblems(line, counters)) {
				const message = `no half-width space between Japanese and ${p.level === "fail" ? "Latin letters" : "a digit"}: …${p.text}…`;
				if (p.level === "fail") report.fail("i18n", `README.ja.md:${i + 1}`, message, "put a half-width space between them");
				else report.warn("i18n", `README.ja.md:${i + 1}`, message, "add a space unless the digit belongs to the Japanese word");
			}
		});
	}
}

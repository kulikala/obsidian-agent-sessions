// The documents: every relative link and anchor resolves, every picture exists, and README.md
// and README.ja.md have the same sections with the same pictures and links (docs/readme-guide.md).

import path from "node:path";

import { lines, maskFences, matchesAny } from "../text.mjs";

/** GitHub's anchor for a heading: lower case, punctuation dropped (but - and _), spaces to -. */
export function slug(heading) {
	return heading
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/`/g, "")
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
		.replace(/ /g, "-");
}

/** The headings of a Markdown text (outside code fences): level, text, line, anchor. */
export function headings(text) {
	const seen = new Map();
	const out = [];
	maskFences(text).forEach((line, i) => {
		const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (!m) return;
		const base = slug(m[2]);
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		out.push({ level: m[1].length, text: m[2], line: i + 1, anchor: n === 0 ? base : `${base}-${n}` });
	});
	return out;
}

/** The links and pictures of a Markdown text (outside code), with their line numbers. */
export function links(text) {
	const out = [];
	maskFences(text).forEach((raw, i) => {
		const line = raw.replace(/`[^`]*`/g, (s) => " ".repeat(s.length));
		for (const m of line.matchAll(/(!?)\[(?:[^\][]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
			out.push({ image: m[1] === "!", target: m[2], line: i + 1 });
		}
		for (const m of line.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) out.push({ image: true, target: m[1], line: i + 1 });
		const ref = /^\s*\[[^\]]+\]:\s*(\S+)/.exec(line);
		if (ref) out.push({ image: false, target: ref[1], line: i + 1 });
	});
	return out;
}

function explicitAnchors(text) {
	return [...text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)].map((m) => m[1]);
}

export function checkDocs({ tree, config, report }) {
	const all = tree.list().map((f) => f.path);
	const fileSet = new Set(all);
	const dirSet = new Set(all.flatMap((p) => p.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
	const anchorCache = new Map();
	const anchorsOf = (file) => {
		if (!anchorCache.has(file)) {
			const text = tree.read(file)?.toString("utf8") ?? "";
			anchorCache.set(file, new Set([...headings(text).map((h) => h.anchor), ...explicitAnchors(text)]));
		}
		return anchorCache.get(file);
	};
	const docs = all.filter((p) => matchesAny(p, config.docs.files));
	let count = 0;
	for (const file of docs) {
		const text = tree.read(file).toString("utf8");
		for (const link of links(text)) {
			const { target } = link;
			if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
			count++;
			const where = `${file}:${link.line}`;
			const [rawPath, anchor] = target.split("#");
			const decoded = decodeURIComponent(rawPath);
			const resolved = rawPath === "" ? file : path.posix.normalize(path.posix.join(path.posix.dirname(file), decoded)).replace(/\/$/, "");
			if (rawPath !== "" && !fileSet.has(resolved) && !dirSet.has(resolved)) {
				report.fail("docs", where, `${link.image ? "picture" : "link"} target does not exist: ${target}`, "fix the path, or add the file");
				continue;
			}
			if (anchor && resolved.endsWith(".md") && fileSet.has(resolved) && !anchorsOf(resolved).has(decodeURIComponent(anchor))) {
				report.fail("docs", where, `no heading for the anchor #${anchor} in ${resolved}`, "link to an existing heading; anchors other pages link to stay stable (docs/readme-guide.md)");
			}
		}
	}
	checkMirror({ tree, config, report });
	return { docs: docs.length, links: count };
}

function sections(text) {
	const hs = headings(text);
	const body = lines(text);
	return hs.map((h, i) => {
		const end = i + 1 < hs.length ? hs[i + 1].line - 1 : body.length;
		const part = body.slice(h.line, end).join("\n");
		const ls = links(part);
		return {
			...h,
			images: ls.filter((l) => l.image).map((l) => path.posix.basename(l.target)),
			links: ls
				.filter((l) => !l.image)
				.map((l) => (l.target.startsWith("#") ? "#" : l.target.replace(/README\.ja\.md/, "README.md")))
				.sort(),
		};
	});
}

/** README.md and README.ja.md: the same headings at the same levels, each with the same pictures
 * (by file name: the Japanese ones where they exist) and the same links (an anchor within the page
 * counts as one link, since the headings it points at are translated). */
export function checkMirror({ tree, config, report }) {
	const [enFile, jaFile] = config.docs.mirror;
	const en = sections(tree.read(enFile)?.toString("utf8") ?? "");
	const ja = sections(tree.read(jaFile)?.toString("utf8") ?? "");
	const n = Math.max(en.length, ja.length);
	for (let i = 0; i < n; i++) {
		const e = en[i];
		const j = ja[i];
		if (!e || !j) {
			const extra = e ?? j;
			report.fail("docs", `${e ? enFile : jaFile}:${extra.line}`, `section "${extra.text}" has no counterpart in ${e ? jaFile : enFile}`, "add the section to both READMEs");
			break;
		}
		if (e.level !== j.level) {
			report.fail("docs", `${jaFile}:${j.line}`, `"${j.text}" is level ${j.level}, its counterpart "${e.text}" (${enFile}:${e.line}) is level ${e.level}`, "mirror the section structure");
			break;
		}
		if (e.images.join("|") !== j.images.join("|")) {
			report.fail("docs", `${jaFile}:${j.line}`, `pictures differ from "${e.text}" (${enFile}:${e.line}): en ${e.images.join(", ") || "none"} / ja ${j.images.join(", ") || "none"}`, "show the same pictures (the Japanese ones under ja/ where they exist)");
		}
		if (e.links.join("|") !== j.links.join("|")) {
			const onlyEn = e.links.filter((l) => !j.links.includes(l));
			const onlyJa = j.links.filter((l) => !e.links.includes(l));
			report.fail("docs", `${jaFile}:${j.line}`, `links differ from "${e.text}" (${enFile}:${e.line}): only en ${onlyEn.join(", ") || "-"} / only ja ${onlyJa.join(", ") || "-"}`, "link the same pages and anchors in both");
		}
	}
}

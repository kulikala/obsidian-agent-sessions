import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { messageProblems } from "../lib/checks/commits.mjs";
import { headings, links, slug } from "../lib/checks/docs.mjs";
import { parseTsLocale, placeholders, placeholdersMatch, spacingProblems } from "../lib/checks/i18n.mjs";
import { languageViolation } from "../lib/checks/tree.mjs";
import { privacyContext, scanLine } from "../lib/privacy.mjs";
import { commentStarts, globToRegExp, quotedSpans } from "../lib/text.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(HERE, "..", "config.json"), "utf8"));
// The "local user" of these tests is made up; the real one is read from the machine at run time.
const ctx = privacyContext({ repo: ".", names: ["samwise", "Sam Example"], origin: { owner: "samwise", repo: "demo-plugin" }, config });
const kinds = (line, options) => scanLine(line, ctx, options).map((f) => f.check);
// What the audit must catch is put together at run time, so this file passes the audit itself.
const join = (...parts) => parts.join("");

test("home folders: placeholders pass, the local user and unknown names fail", () => {
	assert.deepEqual(kinds("cwd=/Users/alex/vault and /home/sam/x"), []);
	assert.deepEqual(kinds(String.raw`C:\Users\alex\AppData and C:/Users/sam/x`), []);
	assert.deepEqual(kinds("/Users/$USER/x, /home/<name>/y, /Users/.../z, ~/vault"), []);
	assert.deepEqual(kinds(String.raw`C:\\Users\\JANEDO~1\\x`), []);
	assert.deepEqual(kinds("/custom/codex/home/config.toml"), []);
	assert.deepEqual(kinds(join("/Users/", "samwise/vault")), ["privacy", "privacy"]);
	assert.deepEqual(kinds(join("/home/", "robin/vault")), ["privacy"]);
});

test("email addresses: only no-reply and example addresses pass", () => {
	assert.deepEqual(kinds("Co-Authored-By: Claude <noreply@anthropic.com>"), []);
	assert.deepEqual(kinds("123+samwise@users.noreply.github.com, pat@example.org"), []);
	assert.deepEqual(kinds(join("alex@", "gmail.com")), ["privacy"]);
	assert.match(scanLine(join("alex@", "gmail.com"), ctx)[0].message, /Gmail/);
	assert.deepEqual(kinds(join("robin@", "corp.example.co")), ["privacy"]);
	assert.deepEqual(kinds("@xterm/xterm@5.5.0"), []);
});

test("the local user's names fail, except in the repository's public URLs", () => {
	assert.deepEqual(kinds("written by Sam Example"), ["privacy"]);
	assert.deepEqual(kinds("ask samwise"), ["privacy"]);
	assert.deepEqual(kinds("https://github.com/samwise/demo-plugin and samwise/demo-plugin"), []);
	assert.deepEqual(kinds("samwisely"), []);
});

test("secrets fail unless the file is exempt", () => {
	const key = join("AKIA", "Q".repeat(16));
	assert.deepEqual(kinds(`key ${key}`), ["secrets"]);
	assert.deepEqual(kinds(`key ${key}`, { secrets: false }), []);
	assert.deepEqual(kinds(join("sk-ant-", "api03-", "x".repeat(30))), ["secrets"]);
	assert.deepEqual(kinds("sk-short"), []);
	assert.deepEqual(kinds(join("sk_", "live_", "a1".repeat(12))), ["secrets"]);
	assert.deepEqual(kinds(join("rk_", "live_", "a1".repeat(12))), ["secrets"]);
	assert.deepEqual(kinds(join("xox", "b-1234-", "abcdefghij")), ["secrets"]);
	assert.deepEqual(kinds(join("xapp-", "1-", "A1B2C3D4E5F6")), ["secrets"]);
	assert.deepEqual(kinds(join("postgres://alex:", "S3cr3t!@localhost:5432/app")), ["secrets"]);
	assert.deepEqual(kinds(join("https://sam:", "hunter2@db.example.com/x")), ["secrets"]);
	assert.deepEqual(kinds("https://alex:<token>@example.com and https://example.com:8080/x"), []);
});

test("commit messages: English, with Claude's two trailer lines last", () => {
	const trailers = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_abc123";
	assert.deepEqual(messageProblems(`Add a check\n\nBody.\n\n${trailers}`), []);
	assert.deepEqual(messageProblems("Merge branch 'feature/x'"), []);
	assert.deepEqual(messageProblems("A human commit without trailers"), []);
	assert.equal(messageProblems(`Add a check\n\n${trailers}\nSigned-off-by: Alex`).length, 1);
	assert.equal(messageProblems("Add a check\n\nClaude-Session: https://claude.ai/code/session_abc").length, 1);
	assert.match(messageProblems(`Name it \u300c\u5229\u7528\u300d\n\n${trailers}`)[0].message, /Japanese/);
	assert.match(messageProblems(`Use the full\uff1acolon\n\n${trailers}`)[0].message, /Japanese/);
});

test("language: Japanese only where a file holds it, quoted in docs, quoted in a comment in code", () => {
	const ja = "\u65e5\u672c\u306e\u6587";
	assert.equal(languageViolation("plugin/src/i18n/locales/ja.ts", `"k": "${ja}",`, config), 0);
	assert.equal(languageViolation("plugin/test/x.test.ts", ja, config), 0);
	assert.ok(languageViolation("docs/usage.md", `Press ${ja} now`, config) > 0);
	assert.equal(languageViolation("docs/usage.md", `Shown as "${ja}" in Japanese`, config), 0);
	assert.equal(languageViolation("docs/usage.md", `Shown as \`${ja}\``, config), 0);
	assert.equal(languageViolation("docs/design.md", ja, config, { fenced: true }), 0);
	assert.ok(languageViolation("plugin/src/a.ts", `const s = "${ja}";`, config, { comment: -1 }) > 0);
	assert.equal(languageViolation("plugin/src/a.ts", `// e.g. "${ja}"`, config, { comment: 0 }), 0);
	assert.ok(languageViolation("plugin/src/a.ts", `// e.g. ${ja}`, config, { comment: 0 }) > 0);
	assert.equal(languageViolation("README.md", "**English | [\u65e5\u672c\u8a9e](README.ja.md)**", config), 0);
});

test("quoted spans survive a quote opened on the line before", () => {
	const line = ` * <time>" on the next day (ja "\u660e\u65e5 3:46", en "tomorrow")`;
	const i = line.indexOf("\u660e");
	assert.ok(quotedSpans(line).some(([s, e]) => i >= s && i < e));
});

test("comments are followed across lines", () => {
	assert.deepEqual(commentStarts(["a /* b", "c", "d */ e", "f // g", "h"], "ts"), [2, 0, 0, 2, -1]);
	assert.deepEqual(commentStarts(['"""doc', "body", '"""', "x = 1  # note"], "py"), [0, 0, 0, 7]);
});

test("globs", () => {
	assert.ok(globToRegExp("tools/*/test/**").test("tools/audit/test/a.test.mjs"));
	assert.ok(globToRegExp("docs/*.md").test("docs/usage.md"));
	assert.ok(!globToRegExp("docs/*.md").test("docs/x/usage.md"));
	assert.ok(globToRegExp("agentsessions/skills/**/*.md").test("agentsessions/skills/a/SKILL.md"));
});

test("locales: parsed, placeholders compared, a plural-only placeholder may be left out", () => {
	assert.deepEqual(parseTsLocale('export const en = {\n\t"a": "x {n}",\n} as const;'), { a: "x {n}" });
	assert.deepEqual(parseTsLocale('export const ja: Partial<Record<K, string>> = {\n\t"a": "y",\n};'), { a: "y" });
	assert.deepEqual([...placeholders("{n} {count|token|tokens}").plain], ["n"]);
	assert.ok(placeholdersMatch("{n} {count|token|tokens}", "{n} \u30c8\u30fc\u30af\u30f3"));
	assert.ok(!placeholdersMatch("{n} files", "\u30d5\u30a1\u30a4\u30eb"));
	assert.ok(!placeholdersMatch("{n} files", "{m} \u30d5\u30a1\u30a4\u30eb"));
});

test("spacing: Latin letters next to Japanese fail, digits before counters pass", () => {
	const counters = config.spacing.counters;
	const level = (s) => spacingProblems(s, counters).map((p) => p.level);
	assert.deepEqual(level("Claude Code \u3092\u958b\u304f"), []);
	assert.deepEqual(level("Claude Code\u3092\u958b\u304f"), ["fail"]);
	assert.deepEqual(level("Claude Code\u30fbCodex"), []);
	assert.deepEqual(level("5\u6642\u9593\u3068\u6700\u592730\u4ef6"), []);
	assert.deepEqual(level("\u5168\u90e830"), ["warn"]);
	assert.deepEqual(level("{n}\u30c8\u30fc\u30af\u30f3 `ls`\u3067"), []);
});

test("docs: GitHub anchors, links and pictures", () => {
	assert.equal(slug("What \"Stretch your usage limit\" sends"), "what-stretch-your-usage-limit-sends");
	assert.equal(slug("Release (maintainers)"), "release-maintainers");
	assert.equal(slug("1. Automated tests"), "1-automated-tests");
	assert.equal(slug("\u300c\u5229\u7528\u67a0\u300d\u3067\u9001\u308b"), "\u5229\u7528\u67a0\u3067\u9001\u308b");
	assert.deepEqual(
		headings("# A\n```\n# not\n```\n## A").map((h) => h.anchor),
		["a", "a-1"],
	);
	assert.deepEqual(
		links("See [usage](docs/usage.md#a) and ![pic](docs/x.png) but not `[x](y)`.").map((l) => [l.image, l.target]),
		[
			[false, "docs/usage.md#a"],
			[true, "docs/x.png"],
		],
	);
});

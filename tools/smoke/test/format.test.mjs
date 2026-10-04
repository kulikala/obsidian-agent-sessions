import assert from "node:assert/strict";
import { test } from "node:test";

import { replaceHome, resultStem, scrubHome, timestamp, toMarkdown } from "../lib/format.mjs";
import { targetResult } from "../lib/results.mjs";

test("replaceHome covers macOS, Linux and Windows homes", () => {
	assert.equal(replaceHome("/Users/someone/projects/x"), "~/projects/x");
	assert.equal(replaceHome("/home/agent/as-test"), "~/as-test");
	assert.equal(replaceHome("C:/Users/agent/Documents"), "~/Documents");
	assert.equal(replaceHome("C:\\Users\\agent\\Documents"), "~\\Documents");
	assert.equal(replaceHome("see /root/.agents now"), "see ~/.agents now");
});

test("replaceHome also takes homes it was told about, slash style aside", () => {
	assert.equal(replaceHome("/opt/me/x and /opt/me", ["/opt/me"]), "~/x and ~");
	assert.equal(replaceHome("D:/people/me/x", ["D:\\people\\me"]), "~/x");
});

test("replaceHome leaves other paths alone", () => {
	assert.equal(replaceHome("/usr/local/bin/python3"), "/usr/local/bin/python3");
	assert.equal(replaceHome("/rooted/path"), "/rooted/path");
});

test("scrubHome walks objects and arrays", () => {
	const out = scrubHome({ a: ["/Users/x/y", 3], b: { c: "/home/z/w" }, d: null });
	assert.deepEqual(out, { a: ["~/y", 3], b: { c: "~/w" }, d: null });
});

test("timestamp and resultStem", () => {
	const d = new Date(2026, 9, 4, 7, 8, 9);
	assert.equal(timestamp(d), "20261004-070809");
	assert.equal(resultStem("mac os/1", d), "mac_os_1-20261004-070809");
});

test("toMarkdown shows the verdict, environment and both stages, escaping pipes", () => {
	const result = targetResult({
		target: "macos",
		startedAt: "2026-10-04T00:00:00.000Z",
		env: { os: "Darwin 25", python: "Python 3.12" },
		run: [{ name: "3 start", status: "pass", ms: 12, message: "a|b" }],
		verify: [{ name: "v1", status: "fail", ms: 5, message: "gone" }],
	});
	const md = toMarkdown(result);
	assert.match(md, /^# Smoke test: macos/);
	assert.match(md, /Result: \*\*FAIL\*\* \(1 pass, 1 fail, 0 skipped\)/);
	assert.match(md, /- python: Python 3\.12/);
	assert.match(md, /\| 3 start \| pass \| 12 ms \| a\\\|b \|/);
	assert.match(md, /\| v1 \| FAIL \| 5 ms \| gone \|/);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { expandTemplate, isWindowsPath, mkdirCommand, parseTargets, psQuote, selectTargets, shQuote } from "../lib/targets.mjs";

const target = (over = {}) => ({
	push: "vm push {files} {dest}",
	pluginDir: "/p",
	workDir: "/w",
	exec: "vm ssh {command}",
	restartObsidian: "vm obsidian",
	cdpPort: 9222,
	...over,
});
const file = (targets) => JSON.stringify({ _comment: "x", targets });

test("parseTargets keeps order and defaults tunnel to empty", () => {
	const t = parseTargets(file({ b: target(), a: target({ tunnel: "vm tunnel" }) }));
	assert.deepEqual(Object.keys(t), ["b", "a"]);
	assert.equal(t.b.tunnel, "");
	assert.equal(t.a.tunnel, "vm tunnel");
	assert.equal(t.a.name, "a");
});

test("parseTargets names what is wrong", () => {
	assert.throws(() => parseTargets("{"), /not valid JSON/);
	assert.throws(() => parseTargets("{}"), /"targets"/);
	assert.throws(() => parseTargets(file({ x: target({ cdpPort: "9222" }) })), /cdpPort/);
	assert.throws(() => parseTargets(file({ x: { ...target(), pluginDir: undefined } })), /lacks "pluginDir"/);
	assert.throws(() => parseTargets(file({ x: target({ push: "vm push" }) })), /\{files\}/);
	assert.throws(() => parseTargets(file({ x: target({ exec: "vm ssh" }) })), /\{command\}/);
});

test("the real targets file layout parses", () => {
	const t = parseTargets(
		file({
			windows: target({ pluginDir: "C:/Users/agent/x", workDir: "C:/Users/agent/y", exec: "vm.sh ssh {command}", cdpPort: 9222 }),
		})
	);
	assert.equal(t.windows.cdpPort, 9222);
});

test("selectTargets", () => {
	const t = parseTargets(file({ a: target(), b: target() }));
	assert.deepEqual(selectTargets(t).map((x) => x.name), ["a", "b"]);
	assert.deepEqual(selectTargets(t, "b").map((x) => x.name), ["b"]);
	assert.throws(() => selectTargets(t, "c"), /no target "c" \(have: a, b\)/);
});

test("shQuote and psQuote", () => {
	assert.equal(shQuote("a b"), "'a b'");
	assert.equal(shQuote("it's"), `'it'\\''s'`);
	assert.equal(psQuote("it's"), "'it''s'");
});

test("expandTemplate quotes files, dest and command, in one pass", () => {
	assert.equal(expandTemplate("vm push {files} {dest}", { files: ["/a b/main.js", "/c/x.css"], dest: "/d e" }), "vm push '/a b/main.js' '/c/x.css' '/d e'");
	assert.equal(expandTemplate("vm ssh {command}", { command: "echo '{dest}'" }), `vm ssh 'echo '\\''{dest}'\\'''`);
	assert.throws(() => expandTemplate("x {command}", {}), /needs \{command\}/);
});

test("mkdirCommand follows the target's shell", () => {
	assert.equal(isWindowsPath("C:/Users/a"), true);
	assert.equal(isWindowsPath("/home/a"), false);
	assert.equal(mkdirCommand("/home/a b"), "mkdir -p '/home/a b'");
	assert.equal(mkdirCommand("C:/Users/a b"), "New-Item -ItemType Directory -Force -Path 'C:/Users/a b' | Out-Null");
});

test("before is optional, a string, and defaults to absent", () => {
	assert.equal(parseTargets(file({ a: target() })).a.before, undefined);
	assert.equal(parseTargets(file({ a: target({ before: "vm ssh stop" }) })).a.before, "vm ssh stop");
	assert.throws(() => parseTargets(file({ a: target({ before: 3 }) })), /"before" must be a string/);
});

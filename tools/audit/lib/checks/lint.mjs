// The checks Obsidian's community plugin review runs (eslint-plugin-obsidianmd), the same command as
// CI: `npm run lint` in plugin/. Any error or warning fails.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function tail(text, n = 40) {
	return text.split("\n").slice(-n).join("\n");
}

export function checkLint({ repo, report, log }) {
	const plugin = path.join(repo, "plugin");
	if (!fs.existsSync(path.join(plugin, "node_modules"))) {
		report.fail("lint", "plugin/node_modules", "not installed", "run `cd plugin && npm ci` first, or pass --skip-tests");
		return;
	}
	log("audit: eslint…");
	const started = Date.now();
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const r = spawnSync(npm, ["run", "--silent", "lint"], { cwd: plugin, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" });
	const seconds = ((Date.now() - started) / 1000).toFixed(0);
	if (r.status !== 0) {
		report.fail("lint", "eslint", `failed after ${seconds} s:\n${tail(`${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim())}`, "run it on its own: (cd plugin && npm run lint)");
	} else {
		log(`audit: eslint passed (${seconds} s)`);
	}
}

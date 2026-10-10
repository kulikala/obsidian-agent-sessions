// The build and the test suites, the same commands as CI: esbuild into a scratch file (never
// plugin/main.js, which a development vault may load), vitest, tsc and Python's unittest.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tail(text, n = 40) {
	return text.split("\n").slice(-n).join("\n");
}

export function checkBuild({ repo, report, log }) {
	const plugin = path.join(repo, "plugin");
	if (!fs.existsSync(path.join(plugin, "node_modules"))) {
		report.fail("build", "plugin/node_modules", "not installed", "run `cd plugin && npm ci` first, or pass --skip-tests");
		return;
	}
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sessions-audit-"));
	const npx = process.platform === "win32" ? "npx.cmd" : "npx";
	const steps = [
		{ name: "esbuild", cwd: plugin, cmd: process.execPath, args: ["esbuild.config.mjs", "production"], env: { AGENT_SESSIONS_OUTFILE: path.join(scratch, "main.js") } },
		{ name: "tsc", cwd: plugin, cmd: npx, args: ["tsc", "-noEmit", "-skipLibCheck"] },
		{ name: "vitest", cwd: plugin, cmd: npx, args: ["vitest", "run"] },
		{ name: "unittest", cwd: repo, cmd: "python3", args: ["-W", "error", "-m", "unittest", "discover", "-s", "tests", "-t", "."] },
	];
	try {
		for (const step of steps) {
			log(`audit: ${step.name}…`);
			const started = Date.now();
			const r = spawnSync(step.cmd, step.args, {
				cwd: step.cwd,
				env: { ...process.env, ...step.env },
				encoding: "utf8",
				maxBuffer: 256 * 1024 * 1024,
			});
			const seconds = ((Date.now() - started) / 1000).toFixed(0);
			if (r.status !== 0) {
				report.fail("build", step.name, `failed after ${seconds} s:\n${tail(`${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim())}`, `run it on its own: (cd ${path.relative(repo, step.cwd) || "."} && ${path.basename(step.cmd)} ${step.args.join(" ")})`);
			} else {
				log(`audit: ${step.name} passed (${seconds} s)`);
			}
		}
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

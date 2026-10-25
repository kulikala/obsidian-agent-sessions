#!/usr/bin/env node
// Runs a Python script with the checkout's Python: `.venv/bin/python3` (on Windows,
// `.venv\Scripts\python.exe`) when it exists, else `python3` from PATH.
//
//   node tools/audit/run-python.mjs SCRIPT [ARG...]
//
// The script path is taken relative to the current folder; its exit code is this command's.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pythonCommand } from "./lib/python.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = "usage: node tools/audit/run-python.mjs SCRIPT [ARG...]";

const [script, ...args] = process.argv.slice(2);
if (!script) {
	console.error(USAGE);
	process.exit(2);
}
const repo = path.resolve(HERE, "../..");
const r = spawnSync(pythonCommand(repo), [path.resolve(script), ...args], { stdio: "inherit" });
if (r.error) {
	console.error(`run-python: ${r.error.message}`);
	process.exit(2);
}
process.exit(r.status ?? 2);

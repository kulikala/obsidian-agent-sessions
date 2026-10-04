#!/usr/bin/env node
// Smoke test runner (the host side). For each target in the targets file: push the built plugin
// and the fake agent, restart Obsidian with DevTools, drive `inject.js` over CDP (run, leaving the
// fake session running), restart Obsidian again, drive the verify stage, and write the results.
//
//   node tools/smoke/run.mjs --build-dir plugin [--target NAME] [--targets FILE] [--local]
//
// See README.md. Node 22 or newer, nothing to install.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { connectPage, sleep } from "../screenshots/cdp.mjs";
import { resultStem, scrubHome, replaceHome, toMarkdown } from "./lib/format.mjs";
import { decideLeftovers } from "./lib/leftovers.mjs";
import { failedStep, oneLine, skipAll, targetResult } from "./lib/results.mjs";
import { expandTemplate, mkdirCommand, parseTargets, selectTargets } from "./lib/targets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const DEFAULT_TARGETS = path.join(HERE, "targets.json");
const RESULTS_DIR = path.join(HERE, "results");
const PLUGIN_ID = "agent-sessions";
const VERIFY_STEPS = ["v1 session survived the restart", "v2 tab reattaches with replay", "v3 input after reattach", "v4 end and clean up"];

const USAGE = `usage: node tools/smoke/run.mjs --build-dir DIR [--target NAME] [--targets FILE] [--local] [--cdp-port N]

  --build-dir DIR   the built plugin (main.js, manifest.json, styles.css); required
  --target NAME     run one target of the targets file (default: all, in file order)
  --targets FILE    the targets file (default tools/smoke/targets.json)
  --local           this machine is the target: copy, and restart Obsidian by hand
  --cdp-port N      with --local: Obsidian's DevTools port (default 9222)`;

function log(message) {
	process.stderr.write(`${message}\n`);
}

function parseArgs(argv) {
	const opts = { buildDir: null, target: null, targets: DEFAULT_TARGETS, local: false, cdpPort: 9222, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			if (i + 1 >= argv.length) {
				throw new Error(`${arg} needs a value`);
			}
			return argv[++i];
		};
		if (arg === "--build-dir") opts.buildDir = value();
		else if (arg === "--target") opts.target = value();
		else if (arg === "--targets") opts.targets = value();
		else if (arg === "--cdp-port") opts.cdpPort = Number(value());
		else if (arg === "--local") opts.local = true;
		else if (arg === "--help" || arg === "-h") opts.help = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	return opts;
}

function expandHome(p) {
	return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

// ---- Running commands on the host --------------------------------------------------------

/** Runs a command line through `sh`, resolving with { code, out }. */
function sh(command, { timeoutMs = 180000, label = command } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`timed out after ${timeoutMs / 1000}s: ${label}`));
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out });
		});
	});
}

async function shOk(command, what, opts) {
	const { code, out } = await sh(command, opts);
	if (code !== 0) {
		throw new Error(`${what} failed (exit ${code}): ${out.trim().slice(-400)}`);
	}
	return out;
}

/** Starts the target's tunnel. It may exit at once (it set something up) or keep running (it is the tunnel). */
async function startTunnel(target, state) {
	if (state.tunnel) {
		state.tunnel.kill();
		state.tunnel = null;
	}
	if (!target.tunnel) {
		return;
	}
	const child = spawn("sh", ["-c", target.tunnel], { stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (out += d));
	const exited = await Promise.race([new Promise((resolve) => child.on("close", (code) => resolve(code))), sleep(4000).then(() => "running")]);
	if (exited === "running") {
		state.tunnel = child;
	} else if (exited !== 0) {
		throw new Error(`the tunnel command failed (exit ${exited}): ${out.trim().slice(-400)}`);
	}
}

function ask(question) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	return new Promise((resolve) => rl.question(question, () => (rl.close(), resolve())));
}

// ---- Driving Obsidian ----------------------------------------------------------------------

const PLUGIN_LOADED = `!!(window.app && app.plugins && app.plugins.plugins && app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}])`;

async function openPage(port) {
	const page = await connectPage(port, { timeoutMs: 120000 });
	await page.waitFor(PLUGIN_LOADED, { timeoutMs: 90000, what: `the ${PLUGIN_ID} plugin to load` });
	return page;
}

function injected(injectSource, call) {
	return `globalThis.__smokeDecideLeftovers = ${decideLeftovers.toString()};\n${injectSource}\n;globalThis.__agentSessionsSmoke.${call}`;
}

async function callInjected(page, injectSource, call) {
	const result = await page.evaluate(injected(injectSource, call));
	if (!result || !Array.isArray(result.steps)) {
		throw new Error(`the injected code returned no steps: ${JSON.stringify(result)?.slice(0, 300)}`);
	}
	return result;
}

// ---- One target ----------------------------------------------------------------------------

function buildFiles(buildDir) {
	const find = (name, fallbacks) => [buildDir, ...fallbacks].map((d) => path.join(d, name)).find((p) => fs.existsSync(p)) ?? null;
	const main = find("main.js", []);
	const manifest = find("manifest.json", [path.join(REPO, "plugin")]);
	const styles = find("styles.css", [path.join(REPO, "plugin")]);
	if (!main) {
		throw new Error(`no main.js in ${buildDir}; build the plugin first (cd plugin && npm run build) and pass --build-dir`);
	}
	if (!manifest) {
		throw new Error(`no manifest.json in ${buildDir}`);
	}
	return [main, manifest, ...(styles ? [styles] : [])];
}

async function pushFiles(target, files, dest) {
	if (target.local) {
		fs.mkdirSync(dest, { recursive: true });
		for (const file of files) {
			fs.copyFileSync(file, path.join(dest, path.basename(file)));
		}
		return;
	}
	await shOk(expandTemplate(target.exec, { command: mkdirCommand(dest) }), `creating ${dest}`);
	await shOk(expandTemplate(target.push, { files, dest }), `pushing to ${dest}`);
}

async function restartObsidian(target, state) {
	if (target.local) {
		log(`  Quit Obsidian, then start it again with DevTools on port ${target.cdpPort}, e.g.`);
		log(`    Obsidian --remote-debugging-port=${target.cdpPort}      (macOS: open -a Obsidian --args --remote-debugging-port=${target.cdpPort})`);
		await ask("  Press Enter once Obsidian is up again... ");
		return;
	}
	await shOk(target.restartObsidian, "restarting Obsidian");
	await startTunnel(target, state);
}

async function runTarget(target, ctx) {
	const started = new Date();
	const state = { tunnel: null };
	const out = { target: target.name, startedAt: started.toISOString(), env: null, run: [], verify: [], error: null };
	let page = null;
	let keptId = null;
	try {
		const files = buildFiles(ctx.buildDir);
		log(`[${target.name}] pushing ${files.map((f) => path.basename(f)).join(", ")} and fake_agent.py`);
		if (target.local) {
			if (!(await reachable(target.cdpPort))) {
				log(`  No DevTools on port ${target.cdpPort} yet.`);
				await restartObsidian(target, state);
			}
			page = await openPage(target.cdpPort);
			const base = await page.evaluate(`app.vault.adapter.getBasePath()`);
			const dir = await page.evaluate(`app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].manifest.dir`);
			target.pluginDir = path.join(base, dir);
			target.workDir = path.join(os.homedir(), ".agents", "sessions", "smoke", "bin");
			page.close();
			page = null;
			log(`  copying over ${target.pluginDir} (the plugin installed in this vault)`);
		}
		await pushFiles(target, files, target.pluginDir);
		await pushFiles(target, [path.join(HERE, "fake_agent.py")], target.workDir);
		if (target.before) {
			log(`[${target.name}] before: ${target.before}`);
			await shOk(target.before, "the \"before\" command");
		}

		log(`[${target.name}] restarting Obsidian`);
		await restartObsidian(target, state);
		page = await openPage(target.cdpPort);
		log(`[${target.name}] run`);
		const run = await callInjected(page, ctx.injectSource, `run(${JSON.stringify({ mode: "keep", workDir: target.workDir })})`);
		out.run = run.steps;
		out.env = run.steps.find((s) => s.data && s.data.os)?.data ?? null;
		keptId = run.kept ? run.kept.id : null;
		page.close();
		page = null;

		if (!keptId) {
			out.verify = skipAll(VERIFY_STEPS, run.steps.some((s) => s.status === "fail") ? "the run failed" : "no session was kept");
		} else {
			log(`[${target.name}] restarting Obsidian to check the session survives`);
			await restartObsidian(target, state);
			page = await openPage(target.cdpPort);
			log(`[${target.name}] verify`);
			const verify = await callInjected(page, ctx.injectSource, `verify(${JSON.stringify(run.kept)})`);
			out.verify = verify.steps;
			keptId = null;
			page.close();
			page = null;
		}
	} catch (err) {
		out.error = err.message;
		log(`[${target.name}] ${err.message}`);
		if (out.run.length === 0) {
			out.run = [failedStep("runner", err.message)];
		}
		if (out.verify.length === 0) {
			out.verify = skipAll(VERIFY_STEPS, "not reached");
		}
		if (keptId) {
			await sweepLeftover(target, state, ctx, page, out);
		}
	} finally {
		try {
			page?.close();
		} catch {
			// Already closed.
		}
		state.tunnel?.kill();
	}
	return targetResult(out);
}

async function reachable(port) {
	try {
		await fetch(`http://127.0.0.1:${port}/json/version`);
		return true;
	} catch {
		return false;
	}
}

/** The run left a session behind and the verify stage could not run: end it, best effort. */
async function sweepLeftover(target, state, ctx, page, out) {
	try {
		page ??= await openPage(target.cdpPort);
		const swept = await callInjected(page, ctx.injectSource, "sweep()");
		out.verify = out.verify.map((s) => ({ ...s, message: `${s.message}; the kept session was ended afterwards (${swept.steps[0]?.message ?? ""})` }));
		page.close();
	} catch (err) {
		log(`[${target.name}] could not end the kept session: ${err.message}; run the next smoke test to sweep it (step 0)`);
		out.verify = out.verify.map((s) => ({ ...s, message: `${s.message}; the kept session may still be running` }));
	}
}

// ---- Results ---------------------------------------------------------------------------------

function writeResult(result) {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const stem = resultStem(result.target);
	const homes = [os.homedir()];
	const clean = scrubHome(result, homes);
	const json = path.join(RESULTS_DIR, `${stem}.json`);
	const md = path.join(RESULTS_DIR, `${stem}.md`);
	fs.writeFileSync(json, `${JSON.stringify(clean, null, 2)}\n`);
	fs.writeFileSync(md, replaceHome(toMarkdown(clean), homes));
	return md;
}

// ---- Main ------------------------------------------------------------------------------------

async function main() {
	const major = Number(process.versions.node.split(".")[0]);
	if (major < 22) {
		throw new Error(`Node 22 or newer is needed (this is ${process.versions.node}); the DevTools client uses the built-in WebSocket`);
	}
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(USAGE);
		return 0;
	}
	if (!opts.buildDir) {
		throw new Error(`--build-dir is required (the built plugin: main.js, manifest.json, styles.css).\n${USAGE}`);
	}
	const buildDir = path.resolve(opts.buildDir);
	if (!fs.existsSync(path.join(buildDir, "main.js"))) {
		throw new Error(`no main.js in ${buildDir}; build the plugin first (cd plugin && npm run build) and pass --build-dir`);
	}
	let targets;
	if (opts.local) {
		targets = [{ name: "local", local: true, cdpPort: opts.cdpPort }];
	} else {
		const file = expandHome(opts.targets);
		let text;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch (err) {
			throw new Error(`cannot read the targets file ${file}: ${err.message}`);
		}
		targets = selectTargets(parseTargets(text), opts.target);
	}
	const injectSource = fs.readFileSync(path.join(HERE, "inject.js"), "utf8");
	const ctx = { buildDir, injectSource };

	let failed = false;
	for (const target of targets) {
		const result = await runTarget(target, ctx);
		const md = writeResult(result);
		console.log(`${oneLine(result)}  -> ${path.relative(REPO, md)}`);
		failed ||= !result.ok;
	}
	return failed ? 1 : 0;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(`error: ${err.message}`);
		process.exit(2);
	}
);

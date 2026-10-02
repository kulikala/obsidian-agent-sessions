#!/usr/bin/env node
// Takes the README screenshots: launches a separate Obsidian with its own profile, home
// directory, and vault, loads the built plugin into it, feeds it the scenario through a stand-in
// CLI and daemon, and captures each scene to docs/images/. Nothing outside the sandbox is read or
// written, and no real agent is started. See README.md next to this file.

import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPage, sleep } from "./cdp.mjs";
import { startFakeDaemon } from "./fake-daemon.mjs";
import { cwdOf, LIMITS, NOTES, SESSIONS } from "./scenario.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PLUGIN_DIR = join(REPO, "plugin");
const OUT_DIR = join(REPO, "docs", "images");
const WINDOW = { width: 1600, height: 1100 };
const SIDEBAR_WIDTH = 420;

const OBSIDIAN_BIN =
	process.env.OBSIDIAN_BIN ||
	{
		darwin: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
		linux: "obsidian",
		win32: join(process.env.LOCALAPPDATA ?? "", "Programs", "Obsidian", "Obsidian.exe"),
	}[process.platform];

const keep = process.argv.includes("--keep");

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, "\t"));
}

function freePort() {
	return new Promise((res) => {
		const srv = createServer().listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => res(port));
		});
	});
}

// ---- Sandbox ------------------------------------------------------------------------------

function buildSandbox(root, now) {
	const home = join(root, "home");
	const userData = join(root, "profile");
	const vault = join(root, "vault");
	const runtime = join(home, ".agents", "sessions");
	const sessions = SESSIONS.map((s) => ({ ...s, cwd: cwdOf(s) }));

	for (const [path, text] of Object.entries(NOTES)) {
		mkdirSync(dirname(join(vault, path)), { recursive: true });
		writeFileSync(join(vault, path), text);
	}

	// Obsidian: this profile knows exactly one vault, opened in the default dark theme.
	writeJson(join(userData, "obsidian.json"), {
		vaults: { a5d0c0ffee000001: { path: vault, ts: now * 1000, open: true } },
	});
	writeJson(join(vault, ".obsidian", "appearance.json"), { theme: "obsidian" });
	writeJson(join(vault, ".obsidian", "app.json"), { promptDelete: false });
	writeJson(join(vault, ".obsidian", "community-plugins.json"), ["agent-sessions"]);

	// The plugin: copies of the built files, so the sandbox never writes into the repo.
	const pluginDir = join(vault, ".obsidian", "plugins", "agent-sessions");
	mkdirSync(pluginDir, { recursive: true });
	for (const f of ["main.js", "manifest.json", "styles.css"]) {
		copyFileSync(join(PLUGIN_DIR, f), join(pluginDir, f));
	}

	// The stand-in CLI.
	const statePath = join(root, "state.json");
	const logPath = join(root, "unhandled.log");
	writeJson(statePath, { now, sessions, limits: LIMITS, logPath });
	const cli = join(home, "bin", "agent-sessions");
	mkdirSync(dirname(cli), { recursive: true });
	writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, "fake-cli.mjs")}" "${statePath}" "$@"\n`);
	chmodSync(cli, 0o755);

	writeJson(join(pluginDir, "data.json"), {
		language: "en",
		notifyOnIdle: true,
		// Keeps the welcome guide from opening over the scenes.
		onboardingShownVersion: "screenshots",
		onboardingOnUpdate: false,
		agentSessionsPath: cli,
		agents: {
			claude: { enabled: true, path: "/usr/bin/true", env: "" },
			codex: { enabled: true, path: "/usr/bin/true", env: "" },
		},
		sideDetailHeight: 250,
		managerAnalysisHeight: 380,
	});

	// sessions.json: archived entries live here, not in the scan.
	writeJson(join(vault, ".agents", "sessions", "sessions.json"), {
		version: 1,
		folded: [],
		archived: sessions.filter((s) => s.archived).map((s) => ({ id: s.id, name: s.name, agent: s.agent })),
		pendingRenames: {},
		sessions: {},
		categoryColors: {},
	});

	// Claude Code's own files: the running-session ledger and the statusLine snapshots.
	mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
	mkdirSync(join(runtime, "status"), { recursive: true });
	mkdirSync(join(runtime, "compacted"), { recursive: true });
	writeFileSync(join(runtime, "events.log"), "");
	const fiveEnd = now + Math.round((5 - LIMITS.claude.fiveHour.elapsedHours) * 3600);
	const sevenEnd = now + Math.round((7 - LIMITS.claude.sevenDay.elapsedDays) * 86400);
	for (const s of sessions.filter((x) => x.agent === "claude")) {
		writeJson(join(runtime, "status", `${s.id}.json`), {
			model: { display_name: s.model },
			effort: s.effort,
			context_window: { used_percentage: s.ctx ?? null },
			rate_limits: {
				five_hour: { used_percentage: LIMITS.claude.fiveHour.used, resets_at: fiveEnd },
				seven_day: { used_percentage: LIMITS.claude.sevenDay.used, resets_at: sevenEnd },
			},
		});
		if (s.compacted) {
			writeJson(join(runtime, "compacted", `${s.id}.json`), {});
		}
	}
	for (const s of sessions) {
		if (s.registry) {
			setRegistry(home, s, s.registry);
		}
	}

	return { home, userData, vault, runtime, sessions, logPath };
}

/** Writes one `~/.claude/sessions/<pid>.json` record. The pid must be alive, so it's ours. */
function setRegistry(home, s, status) {
	const index = SESSIONS.findIndex((x) => x.id === s.id);
	writeJson(join(home, ".claude", "sessions", `${index + 1}.json`), {
		pid: process.pid,
		sessionId: s.id,
		cwd: cwdOf(s),
		status,
		updatedAt: Date.now(),
		...(status === "waiting" ? { waitingFor: s.waitingFor } : {}),
		...(s.rc ? { bridgeSessionId: `bridge-${index}` } : {}),
	});
}

// ---- Scenes -------------------------------------------------------------------------------

const PLUGIN = "app.plugins.plugins['agent-sessions']";

/** The main-area leaf showing session `id`'s terminal. */
const leafOf = (id) =>
	`app.workspace.getLeavesOfType('agent-sessions-terminal').find((l) => l.view.id === ${JSON.stringify(id)})`;

async function front(page, id) {
	await page.evaluate(`(async () => {
		const leaf = ${leafOf(id)};
		await app.workspace.revealLeaf(leaf);
		app.workspace.setActiveLeaf(leaf, { focus: true });
	})()`);
}

async function clearNotices(page) {
	await page.evaluate(`document.querySelectorAll('.notice').forEach((n) => n.remove())`);
}

async function capture(page, name) {
	await sleep(1200);
	mkdirSync(OUT_DIR, { recursive: true });
	const file = join(OUT_DIR, `${name}.png`);
	writeFileSync(file, await page.screenshot());
	console.log(`  wrote ${file}`);
}

async function run() {
	if (!existsSync(join(PLUGIN_DIR, "main.js"))) {
		throw new Error("plugin/main.js is missing — run `npm run build` in plugin/ first");
	}
	const now = Math.floor(Date.now() / 1000);
	const root = mkdtempSync(join(tmpdir(), "as-shots-"));
	const box = buildSandbox(root, now);
	const daemon = startFakeDaemon(join(box.runtime, "daemon.sock"), box.sessions, now);
	const port = await freePort();
	const obsidian = spawn(
		OBSIDIAN_BIN,
		[`--user-data-dir=${box.userData}`, `--remote-debugging-port=${port}`, "--use-mock-keychain"],
		{ env: { ...process.env, HOME: box.home, USERPROFILE: box.home }, stdio: "ignore" }
	);
	const errors = [];
	let page;
	let failed = false;
	try {
		page = await connectPage(port);
		await page.waitFor("window.app?.workspace?.layoutReady", { what: "Obsidian's workspace" });

		// English UI and community plugins on; both take effect on reload.
		await page.evaluate(`(async () => {
			localStorage.setItem('language', 'en');
			await app.plugins.setEnable(true);
			location.reload();
		})()`).catch(() => undefined);
		await sleep(1500);
		await page.waitFor(`window.app?.workspace?.layoutReady && !!${PLUGIN}`, { what: "the plugin to load" });
		await page.collectErrors(errors);
		await page.setViewport(WINDOW.width, WINDOW.height);

		// Layout: no file explorer, the side panel on the right, the terminal tabs in the middle.
		const tabs = box.sessions.filter((s) => s.tab).map((s) => ({ id: s.id, agent: s.agent, cwd: s.cwd }));
		const tabIds = tabs.map((t) => t.id);
		await page.evaluate(`(async () => {
			app.workspace.leftSplit.collapse();
			await app.commands.executeCommandById('agent-sessions:open-side-panel');
			for (const t of ${JSON.stringify(tabs)}) {
				await ${PLUGIN}.openSession(t.id, { agent: t.agent, cwd: t.cwd });
			}
			for (const leaf of app.workspace.getLeavesOfType('empty')) {
				leaf.detach();
			}
			app.workspace.rightSplit.setSize(${SIDEBAR_WIDTH});
		})()`);
		// A tab only attaches once it has a size, i.e. once it has been shown.
		for (const id of tabIds) {
			await front(page, id);
			await page.waitFor(`${leafOf(id)}?.view.attached`, { what: `tab ${id} to attach` });
		}

		// A session finishes in the background: its tab turns "Needs review".
		const checkout = box.sessions.find((s) => s.transcript === "claude-checkout");
		const flips = box.sessions.filter((s) => s.flipToIdle);
		await front(page, checkout.id);
		await sleep(1000);
		for (const s of flips) {
			setRegistry(box.home, s, "idle");
		}
		await sleep(1500);
		await clearNotices(page);

		await page.evaluate(`app.workspace.rightSplit.setSize(${SIDEBAR_WIDTH})`);
		console.log("Scenes:");
		await capture(page, "overview");

		await page.evaluate(`(async () => {
			app.workspace.rightSplit.collapse();
			await app.commands.executeCommandById('agent-sessions:open-manager');
		})()`);
		await capture(page, "manager");

		// Codex asking for approval in front, while a Claude session's idle notice comes in.
		await page.evaluate(`(async () => {
			for (const leaf of app.workspace.getLeavesOfType('agent-sessions-manager')) leaf.detach();
			app.workspace.rightSplit.expand();
			app.workspace.rightSplit.setSize(${SIDEBAR_WIDTH});
		})()`);
		const limiter = box.sessions.find((s) => s.transcript === "codex-limiter");
		await front(page, limiter.id);
		for (const s of flips) {
			setRegistry(box.home, s, "busy");
		}
		await sleep(1200);
		for (const s of flips) {
			setRegistry(box.home, s, "idle");
		}
		await page.waitFor(`document.querySelector('.notice')`, { what: "the idle notice" });
		await capture(page, "codex");
	} catch (err) {
		failed = true;
		if (page) {
			writeFileSync(join(root, "failure.png"), await page.screenshot().catch(() => Buffer.alloc(0)));
		}
		throw err;
	} finally {
		page?.close();
		obsidian.kill();
		daemon.close();
		const unhandled = existsSync(box.logPath) ? readFileSync(box.logPath, "utf8").trim() : "";
		if (unhandled) {
			console.log(`Stand-in CLI calls with no canned answer:\n${unhandled}`);
		}
		if (errors.length) {
			console.log(`Errors in Obsidian's console:\n${[...new Set(errors)].join("\n")}`);
		}
		if (keep || failed) {
			console.log(`Sandbox kept at ${root}`);
		} else {
			await sleep(500);
			rmSync(root, { recursive: true, force: true });
		}
	}
}

run().then(
	() => process.exit(0),
	(err) => {
		console.error(err);
		process.exit(1);
	}
);

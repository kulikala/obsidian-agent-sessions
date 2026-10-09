#!/usr/bin/env node
// Takes the README screenshots: launches a separate Obsidian with its own profile, home
// directory, and vault, loads the built plugin into it, feeds it the scenario through a stand-in
// CLI and daemon, and captures each scene to docs/images/. Nothing outside the sandbox is read or
// written, and no real agent is started. `--onboarding` shoots the welcome guide's scenes instead
// (docs/onboarding/<lang>/<scene>.png). See README.md next to this file.

import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPage, sleep } from "./cdp.mjs";
import { efficiencyReply } from "./efficiency.mjs";
import { startFakeDaemon } from "./fake-daemon.mjs";
import { cwdOf, LIMITS, scenarioFor } from "./scenario.mjs";
import { LANGUAGES, readOnboardingScenes } from "./scenes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PLUGIN_DIR = join(REPO, "plugin");
const OUT_DIR = join(REPO, "docs", "images");
/** Where the README scenes of the run in progress go: docs/images/ for English, docs/images/<lang>/ otherwise. */
let readmeOutDir = OUT_DIR;
const ONBOARDING_DIR = join(REPO, "docs", "onboarding");
const WINDOW = { width: 1600, height: 1100 };
// The onboarding images: 16:10, Obsidian's default light theme. Rendered at 2x (the terminal
// needs it to lay out right) and captured at half scale, i.e. 1x pixels.
const ONBOARDING_WINDOW = { width: 1600, height: 1000 };
const SIDEBAR_WIDTH = 420;

const OBSIDIAN_BIN =
	process.env.OBSIDIAN_BIN ||
	{
		darwin: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
		linux: "obsidian",
		win32: join(process.env.LOCALAPPDATA ?? "", "Programs", "Obsidian", "Obsidian.exe"),
	}[process.platform];

const keep = process.argv.includes("--keep");
const onboarding = process.argv.includes("--onboarding");
// `--efficiency` shoots the token efficiency dialog's four screens (efficiency-empty, -analyzing,
// -result, -previous), in the dark and the light theme.
const efficiencyOnly = process.argv.includes("--efficiency");
// `--dialogs` shoots the per-session dialogs opened from a row's menu, in the dark and the light theme.
const dialogsOnly = process.argv.includes("--dialogs");
// `--detail-state` shoots only the side panel's detail pane for one session per state (add `--light` for the light theme).
const detailStateOnly = process.argv.includes("--detail-state");
// `--rc` shoots the side panel's Remote Control toggle (off, starting, listening, down) with its tooltip, in the dark and the light theme.
const rcOnly = process.argv.includes("--rc");
const lightTheme = process.argv.includes("--light");
// `--loop` shoots the side panel with scheduled work: a session with a schedule, and one whose tab
// turned "Scheduled run finished" after a scheduled turn ended in the background.
const loopOnly = process.argv.includes("--loop");
// `--out DIR` writes the README set's images there (DIR/<lang>/ for a language other than English).
const outArg = process.argv.indexOf("--out");
const README_OUT = outArg >= 0 ? resolve(process.argv[outArg + 1]) : OUT_DIR;
const langArg = process.argv.indexOf("--lang");
const languages = langArg >= 0 ? [process.argv[langArg + 1]] : LANGUAGES;
if (languages.some((l) => !LANGUAGES.includes(l))) {
	throw new Error(`--lang takes ${LANGUAGES.join(" or ")}`);
}

// The built plugin to load: --plugin-js PATH or AGENT_SESSIONS_PLUGIN_JS, else plugin/main.js.
const pluginJsArg = process.argv.indexOf("--plugin-js");
const PLUGIN_JS = resolve(
	(pluginJsArg >= 0 ? process.argv[pluginJsArg + 1] : process.env.AGENT_SESSIONS_PLUGIN_JS) || join(PLUGIN_DIR, "main.js")
);

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

/** `--loop`: which sandbox sessions have scheduled work (the migration session's last turn was a scheduled one). */
const LOOP_PATCH = {
	"claude-docs": {
		scheduledTurn: true,
		schedule: { jobs: [{ cron: "*/30 * * * *", human: "Every 30 minutes", nextMinutes: 24 }] },
	},
	"claude-infra": {
		schedule: { jobs: [{ cron: "0 9 * * *", human: "Every day at 9:00", nextMinutes: 190 }], wakeupMinutes: 12 },
	},
};

/** The side panel with the hovered session's detail, for the scheduled and the finished-run rows. */
async function loopScenes(page, box, look) {
	console.log("Scenes:");
	await clearNotices(page);
	for (const [transcript, name] of [["claude-docs", "looped"], ["claude-infra", "schedule"]]) {
		const id = box.sessions.find((s) => s.transcript === transcript).id;
		await page.hover(`.agent-sessions-row[data-session-id=${JSON.stringify(id)}]`);
		await page.waitFor(`document.querySelector('.agent-sessions-detail')?.dataset.rowId === ${JSON.stringify(id)}`, { what: `the ${name} detail` });
		await sleep(400);
		await capture(page, `loop-${name}`, await unionOf(page, [".workspace-split.mod-right-split"]));
	}
}

/** `look`: { lang, light, scenario } — the UI language, the theme, and the words (scenarioFor). */
function buildSandbox(root, now, look) {
	const home = join(root, "home");
	const userData = join(root, "profile");
	const vault = join(root, "vault");
	const runtime = join(home, ".agents", "sessions");
	const sessions = look.scenario.sessions.map((s) => ({ ...s, ...(loopOnly ? LOOP_PATCH[s.transcript] : {}), cwd: cwdOf(s) }));

	for (const [path, text] of Object.entries(look.scenario.notes)) {
		mkdirSync(dirname(join(vault, path)), { recursive: true });
		writeFileSync(join(vault, path), text);
	}

	// Obsidian: this profile knows exactly one vault, opened in the default dark or light theme.
	writeJson(join(userData, "obsidian.json"), {
		vaults: { a5d0c0ffee000001: { path: vault, ts: now * 1000, open: true } },
	});
	writeJson(join(vault, ".obsidian", "appearance.json"), { theme: look.light ? "moonstone" : "obsidian" });
	// Menus drawn in the page (macOS would otherwise use native ones, out of reach of the script).
	writeJson(join(vault, ".obsidian", "app.json"), { promptDelete: false, nativeMenus: false });
	writeJson(join(vault, ".obsidian", "community-plugins.json"), ["agent-sessions"]);

	// The plugin: copies of the built files, so the sandbox never writes into the repo.
	const pluginDir = join(vault, ".obsidian", "plugins", "agent-sessions");
	mkdirSync(pluginDir, { recursive: true });
	copyFileSync(PLUGIN_JS, join(pluginDir, "main.js"));
	for (const f of ["manifest.json", "styles.css"]) {
		copyFileSync(join(PLUGIN_DIR, f), join(pluginDir, f));
	}

	// The stand-in CLI.
	const statePath = join(root, "state.json");
	const logPath = join(root, "unhandled.log");
	writeJson(statePath, { now, sessions, limits: LIMITS, logPath, lang: look.lang });
	const cli = join(home, "bin", "agent-sessions");
	mkdirSync(dirname(cli), { recursive: true });
	writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, "fake-cli.mjs")}" "${statePath}" "$@"\n`);
	chmodSync(cli, 0o755);

	// "Organize names and categories" asks the Claude Code CLI for its suggestions; this stand-in
	// answers with the canned ones from the scenario, in Claude Code's stream-json shape.
	const claudeBin = join(home, "bin", "claude");
	writeJson(join(root, "organize.json"), look.scenario.suggestions);
	writeJson(join(root, "efficiency.json"), efficiencyReply(look.lang));
	writeFileSync(
		claudeBin,
		`#!/bin/sh\nexec "${process.execPath}" "${join(HERE, "fake-claude.mjs")}" "${join(root, "organize.json")}" "${join(root, "efficiency.json")}"\n`
	);
	chmodSync(claudeBin, 0o755);

	writeJson(join(pluginDir, "data.json"), {
		language: look.lang,
		notifyOnIdle: true,
		// Keeps the welcome guide from opening over the scenes.
		onboardingShownVersion: "screenshots",
		onboardingOnUpdate: false,
		// Development builds only: the guide reads its pictures from this folder instead of GitHub.
		...(look.imageBase ? { onboardingImageBase: look.imageBase } : {}),
		agentSessionsPath: cli,
		agents: {
			claude: { enabled: true, path: claudeBin, env: "" },
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
			setRegistry(home, sessions.map((x) => x.id), s, s.registry);
		}
	}

	return { home, userData, vault, runtime, sessions, ids: sessions.map((x) => x.id), logPath };
}

/** Writes one `~/.claude/sessions/<pid>.json` record. The pid must be alive, so it's ours. */
function setRegistry(home, ids, s, status) {
	const index = ids.indexOf(s.id);
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

/** `clip`, when given, is the part of the window to keep (CSS pixels); else the whole window. */
async function capture(page, name, clip) {
	await sleep(1200);
	mkdirSync(readmeOutDir, { recursive: true });
	const file = join(readmeOutDir, `${name}.png`);
	writeFileSync(file, await page.screenshot(clip));
	console.log(`  wrote ${file}`);
}

// ---- The README's scenes ------------------------------------------------------------------

async function readmeScenes(page, box, look) {
	const flips = box.sessions.filter((s) => s.flipToIdle);
	console.log("Scenes:");
	await capture(page, "overview");

	await page.evaluate(`(async () => {
		app.workspace.rightSplit.collapse();
		await app.commands.executeCommandById('agent-sessions:open-manager');
	})()`);
	await capture(page, "manager");

	// Session analytics for the checkout session, over the manager: the whole session, framed
	// to the dialog with a little of the dimmed window around it.
	const checkout = box.sessions.find((s) => s.transcript === "claude-checkout");
	await page.evaluate(`${PLUGIN}.showUsage(${JSON.stringify(checkout.id)})`);
	await page.waitFor(`document.querySelector('.agent-sessions-usage-table tbody tr')`, { what: "the session analytics" });
	const dialog = await unionOf(page, [".agent-sessions-usage-modal"]);
	const margin = 24;
	await capture(page, "analytics", {
		x: Math.max(0, dialog.x - margin),
		y: Math.max(0, dialog.y - margin),
		width: Math.min(look.window.width, dialog.width + 2 * margin),
		height: Math.min(look.window.height, dialog.height + 2 * margin),
	});
	await pressEscape(page);
	await page.waitFor(`!document.querySelector('.modal')`, { what: "the session analytics to close" });

	// The activity calendar, on the last full week (the current one may be nearly empty).
	await page.evaluate(`(async () => {
		for (const leaf of app.workspace.getLeavesOfType('agent-sessions-manager')) leaf.detach();
		await app.commands.executeCommandById('agent-sessions:open-activity');
	})()`);
	await page.waitFor(`document.querySelector('.agent-sessions-activity-nav')`, { what: "the calendar" });
	await page.click(`.agent-sessions-activity [aria-label=${JSON.stringify(msg(look.lang, "activity.prev"))}]`);
	await sleep(1500);
	await page.waitFor(`document.querySelector('.agent-sessions-activity-block')`, { what: "the previous period's blocks" });
	// Open the details of one block of a session the sandbox knows (the block's turns above, the session below).
	const known = box.sessions.find((x) => x.agent === "claude");
	await page.evaluate(`(() => {
		const blocks = [...document.querySelectorAll('.agent-sessions-activity-block')].filter((b) => b.dataset.sessionId === ${JSON.stringify(known.id)});
		(blocks.sort((a, b) => b.offsetHeight - a.offsetHeight)[0] ?? document.querySelector('.agent-sessions-activity-block')).click();
	})()`);
	await sleep(1500);
	// One row's response unfolded, to show what the disclosure holds.
	await page.evaluate(`document.querySelector('.agent-sessions-activity-turn-reply')?.setAttribute('open', '')`);
	await capture(page, "calendar");
	await page.evaluate(`app.workspace.getLeavesOfType('agent-sessions-activity').forEach((l) => l.detach())`);

	// Codex asking for approval in front, while a Claude session's idle notice comes in.
	await page.evaluate(`(async () => {
		for (const leaf of app.workspace.getLeavesOfType('agent-sessions-manager')) leaf.detach();
		app.workspace.rightSplit.expand();
		app.workspace.rightSplit.setSize(${SIDEBAR_WIDTH});
	})()`);
	const limiter = box.sessions.find((s) => s.transcript === "codex-limiter");
	await front(page, limiter.id);
	for (const s of flips) {
		setRegistry(box.home, box.ids, s, "busy");
	}
	await sleep(1200);
	for (const s of flips) {
		setRegistry(box.home, box.ids, s, "idle");
	}
	await page.waitFor(`document.querySelector('.notice')`, { what: "the idle notice" });
	await capture(page, "codex");

	// The welcome guide, on its first page.
	await clearNotices(page);
	await page.evaluate(`${PLUGIN}.openOnboarding()`);
	await page.waitFor(`document.querySelector('.agent-sessions-onboarding')`, { what: "the welcome guide" });
	// The language step has no picture, so the README shows the next step with its picture loaded
	// (from the folder served in `run`; needs a development build of the plugin).
	await sleep(800);
	await page.evaluate(`[...document.querySelectorAll('.agent-sessions-onboarding button')].find((b) => b.textContent.trim() === ${JSON.stringify(msg(look.lang, 'action.next'))}).click()`);
	await sleep(1500);
	await page.waitFor(`(() => { const img = document.querySelector('.agent-sessions-onboarding img'); return !!img && img.complete && img.naturalWidth > 0; })()`, { what: "the guide's picture" });
	await capture(page, "welcome");
	await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))`);
	await page.waitFor(`!document.querySelector('.agent-sessions-onboarding')`, { what: "the welcome guide to close" });

	await openOrganizeResult(page, look);
	await capture(page, "organize");
}


/**
 * The per-session dialogs, opened through the side panel row's `⋯` menu (so the shot is what a
 * user gets): rename, move to category, change model, end session, and the analytics.
 */
async function dialogScenes(page, box, look) {
	const checkout = box.sessions.find((s) => s.transcript === "claude-checkout");
	const theme = look.light ? "light" : "dark";
	const openFromMenu = async (key) => {
		const row = `.agent-sessions-side .agent-sessions-row[data-session-id=${JSON.stringify(checkout.id)}]`;
		await page.evaluate(`document.querySelector(${JSON.stringify(row)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1400, clientY: 300 }))`);
		const title = msg(look.lang, key);
		await page.waitFor(`[...document.querySelectorAll('.menu .menu-item-title')].some((e) => e.textContent === ${JSON.stringify(title)})`, { what: `the "${title}" menu item` });
		await page.evaluate(`[...document.querySelectorAll('.menu .menu-item')].find((e) => e.querySelector('.menu-item-title')?.textContent === ${JSON.stringify(title)}).click()`);
	};
	const shoot = async (name) => {
		await page.waitFor(`document.querySelector('.modal .agent-sessions-dialog-target')`, { what: `the ${name} dialog` });
		await capture(page, `dialog-${name}-${theme}`, await dialogClip(page, look, ".modal"));
		await pressEscape(page);
		await page.waitFor(`!document.querySelector('.modal')`, { what: `the ${name} dialog to close` });
	};
	console.log("Scenes:");
	await openFromMenu("action.rename");
	await shoot("rename");
	await openFromMenu("action.moveToCategory");
	await shoot("move");
	await openFromMenu("action.changeModel");
	await shoot("model");
	await openFromMenu("action.endSession");
	await shoot("end");
	await page.evaluate(`${PLUGIN}.showUsage(${JSON.stringify(checkout.id)})`);
	await page.waitFor(`document.querySelector('.agent-sessions-usage-table tbody tr')`, { what: "the session analytics" });
	await shoot("usage");
	// A narrow dialog: the name is cut with an ellipsis, the chip stays whole.
	await openFromMenu("action.moveToCategory");
	await page.evaluate(`(() => { const m = document.querySelector('.modal'); m.style.width = '300px'; })()`);
	await shoot("move-narrow");
}

/** The dialog's own box with a little of the dimmed window around it. */
async function dialogClip(page, look, selector) {
	const dialog = await unionOf(page, [selector]);
	const margin = 24;
	return {
		x: Math.max(0, dialog.x - margin),
		y: Math.max(0, dialog.y - margin),
		width: Math.min(look.window.width, dialog.width + 2 * margin),
		height: Math.min(look.window.height, dialog.height + 2 * margin),
	};
}

/**
 * Token efficiency, in its four screens: not analysed yet, an analysis half-way (the stand-in
 * `claude` takes a moment per check), the result just made with its first issue open, and a saved
 * result opened again a day later, with sessions started since.
 */
async function efficiencyScenes(page, box, look) {
	console.log("Scenes:");
	const theme = look.light ? "light" : "dark";
	const dialog = ".agent-sessions-efficiency";
	const open = async () => {
		await page.evaluate(`app.commands.executeCommandById('agent-sessions:analyze-token-efficiency')`);
		await page.waitFor(`document.querySelector('${dialog} .agent-sessions-efficiency-pane')`, { what: "the efficiency dialog" });
	};
	await clearNotices(page);
	await open();
	await page.waitFor(`document.querySelector('${dialog} .agent-sessions-efficiency-go button')`, { what: "the empty screen" });
	await capture(page, `efficiency-empty-${theme}`, await dialogClip(page, look, dialog));

	await page.evaluate(`document.querySelector('${dialog} .agent-sessions-efficiency-go button').click()`);
	await page.waitFor(
		`document.querySelectorAll('${dialog} .agent-sessions-efficiency-pt.is-ok, ${dialog} .agent-sessions-efficiency-pt.is-issue').length >= 3 && document.querySelector('${dialog} .agent-sessions-efficiency-pt.is-running')`,
		{ what: "the analysis half-way" }
	);
	await capture(page, `efficiency-analyzing-${theme}`, await dialogClip(page, look, dialog));

	await page.waitFor(`document.querySelector('${dialog} .agent-sessions-efficiency-summary')`, { what: "the result", timeoutMs: 60_000 });
	await page.evaluate(`document.querySelector('${dialog} button.agent-sessions-efficiency-pt-row').click()`);
	await capture(page, `efficiency-result-${theme}`, await dialogClip(page, look, dialog));

	// The saved result, as if made a day ago: the sessions active since then are new to it.
	await pressEscape(page);
	await page.waitFor(`!document.querySelector('${dialog}')`, { what: "the dialog to close" });
	const saved = join(box.runtime, "efficiency", "last-claude.json");
	const result = JSON.parse(readFileSync(saved, "utf8"));
	result.savedAt -= 86_400;
	result.sessionIds = result.sessionIds.slice(0, 2);
	writeFileSync(saved, JSON.stringify(result));
	await open();
	await page.waitFor(`document.querySelector('${dialog} .agent-sessions-efficiency-summary')`, { what: "the saved result" });
	await capture(page, `efficiency-previous-${theme}`, await dialogClip(page, look, dialog));
}

/** The detail pane of one session per state the sandbox shows, framed to the pane. */
async function detailStateScenes(page, box, look) {
	console.log("Scenes:");
	await clearNotices(page);
	const states = await page.evaluate(`(() => {
		const seen = {};
		for (const row of document.querySelectorAll('.agent-sessions-row')) {
			const mark = row.querySelector('.agent-sessions-row-mark');
			const cls = [...(mark?.classList ?? [])].find((c) => c.startsWith('agent-sessions-status-'));
			if (cls && !seen[cls]) seen[cls] = row.dataset.sessionId;
		}
		return seen;
	})()`);
	for (const [cls, id] of Object.entries(states)) {
		const state = cls.replace("agent-sessions-status-", "");
		await page.hover(`.agent-sessions-row[data-session-id=${JSON.stringify(id)}]`);
		await page.waitFor(`document.querySelector('.agent-sessions-detail')?.dataset.rowId === ${JSON.stringify(id)}`, { what: `the ${state} detail` });
		await sleep(400);
		await capture(page, `detail-${state}`, await unionOf(page, [".agent-sessions-detail"]));
	}
}

/**
 * The Remote Control toggle in each state. The stand-in daemon runs no server, so the state is set on
 * the plugin's toggle directly, with its daemon refreshes held off.
 */
async function rcScenes(page, box, look) {
	const theme = look.light ? "light" : "dark";
	const control = `${PLUGIN}.rcServer`;
	await page.evaluate(`${control}.sync = () => undefined`);
	const server = `{ id: "rc-server", agent: "claude", cwd: "", pid: 1, startedAt: 0, clients: 0, exited: null, exitedAt: null }`;
	const states = {
		off: `${PLUGIN}.settings.rcServerEnabled = false; c.daemon = null; c.signal = null;`,
		starting: `${PLUGIN}.settings.rcServerEnabled = true; c.daemon = ${server}; c.signal = null;`,
		listening: `${PLUGIN}.settings.rcServerEnabled = true; c.daemon = ${server}; c.signal = "ready";`,
		down: `${PLUGIN}.settings.rcServerEnabled = true; c.daemon = null; c.signal = null;`,
	};
	console.log("Scenes:");
	await clearNotices(page);
	for (const [state, set] of Object.entries(states)) {
		await page.evaluate(`(() => { const c = ${control}; ${set} c.update(); })()`);
		// The real pointer moving onto it doesn't bring Obsidian's tooltip up in the sandbox's window;
		// mouse events dispatched on the element do (all as `MouseEvent`: a synthetic `PointerEvent` leaves it down).
		await page.hover(".agent-sessions-side .agent-sessions-rc-toggle");
		await page.evaluate(`(() => {
			const e = document.querySelector('.agent-sessions-side .agent-sessions-rc-toggle');
			const r = e.getBoundingClientRect();
			const at = { clientX: r.x + 5, clientY: r.y + 5 };
			e.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, ...at }));
			e.dispatchEvent(new MouseEvent('pointerenter', at));
			e.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, ...at }));
			e.dispatchEvent(new MouseEvent('mouseenter', at));
			e.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...at }));
		})()`);
		await page.waitFor(`document.querySelector('.tooltip')`, { what: `the ${state} tooltip` });
		await sleep(300);
		const area = await unionOf(page, [".agent-sessions-side .agent-sessions-nav", ".tooltip"]);
		const margin = 16;
		await capture(page, `rc-${state}-${theme}`, {
			x: Math.max(0, area.x - margin),
			y: Math.max(0, area.y - margin),
			width: Math.min(look.window.width, area.width + 2 * margin),
			height: Math.min(look.window.height, area.height + 2 * margin),
		});
		await page.evaluate(`document.querySelectorAll('.tooltip').forEach((t) => t.remove())`);
	}
}

/**
 * "Organize names and categories": every session already has a category, so the "only unnamed"
 * switch goes off; the stand-in claude answers; one row is unticked and given a comment.
 */
async function openOrganizeResult(page, look) {
	await sleep(500);
	await page.click(`.agent-sessions-nav [aria-label=${JSON.stringify(msg(look.lang, "action.more"))}]`);
	await page.waitFor(`document.querySelector('.menu')`, { what: "the more menu" });
	await page.evaluate(`[...document.querySelectorAll('.menu-item')].find((i) => i.textContent.includes(${JSON.stringify(msg(look.lang, "action.organize"))})).click()`);
	await page.waitFor(`document.querySelector('.agent-sessions-organize .checkbox-container')`, { what: "the organize dialog" });
	await page.evaluate(`document.querySelector('.agent-sessions-organize .checkbox-container').click()`);
	await page.evaluate(`[...document.querySelectorAll('.agent-sessions-organize button')].find((b) => b.textContent.includes(${JSON.stringify(msg(look.lang, "organize.suggest"))})).click()`);
	await page.waitFor(`document.querySelector('.agent-sessions-organize-row:not(.is-header)')`, { what: "the organize results" });
	await page.evaluate(`(() => {
		const rows = [...document.querySelectorAll('.agent-sessions-organize-row:not(.is-header)')];
		const target = rows.find((r) => r.textContent.includes(${JSON.stringify(look.scenario.organizeCategory)}));
		target.querySelector('.agent-sessions-round-check').click();
		const comment = target.querySelector('.agent-sessions-organize-comment');
		comment.value = ${JSON.stringify(look.scenario.comment)};
		comment.dispatchEvent(new Event('input', { bubbles: true }));
		// Bring the comment into view: in a smaller window it sits below the list's fold.
		comment.scrollIntoView({ block: "nearest" });
	})()`);
}

// ---- The welcome guide's scenes -----------------------------------------------------------

/** A UI string in `lang`, read from the plugin's own locale file so labels never drift. */
function msg(lang, key) {
	const source = readFileSync(join(PLUGIN_DIR, "src", "i18n", "locales", `${lang}.ts`), "utf8");
	const line = source.split("\n").find((l) => l.trimStart().startsWith(`${JSON.stringify(key)}:`));
	const match = line && /:\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/.exec(line);
	if (!match) {
		throw new Error(`no string ${key} in ${lang}.ts`);
	}
	return JSON.parse(match[1]);
}

/** The 16:10 box of at least `minWidth` that holds `rect` with some context around it. */
function frameAround(rect, viewport, minWidth = 800, margin = 40) {
	const ratio = ONBOARDING_WINDOW.width / ONBOARDING_WINDOW.height;
	const width = Math.min(viewport.width, Math.max(minWidth, (rect.height + 2 * margin) * ratio, rect.width + 2 * margin));
	const height = width / ratio;
	const x = Math.round(Math.min(Math.max(rect.x + rect.width / 2 - width / 2, 0), viewport.width - width));
	const y = Math.round(Math.min(Math.max(rect.y + rect.height / 2 - height / 2, 0), viewport.height - height));
	return { x, y, width: Math.round(width), height: Math.round(height) };
}

/** The union of the bounding boxes of everything matching `selectors` that is on screen. */
function unionOf(page, selectors) {
	return page.evaluate(`(() => {
		const boxes = ${JSON.stringify(selectors)}
			.flatMap((sel) => [...document.querySelectorAll(sel)])
			.map((el) => el.getBoundingClientRect())
			.filter((r) => r.width > 0 && r.height > 0);
		if (!boxes.length) return null;
		const x = Math.min(...boxes.map((r) => r.left));
		const y = Math.min(...boxes.map((r) => r.top));
		return {
			x, y,
			width: Math.max(...boxes.map((r) => r.right)) - x,
			height: Math.max(...boxes.map((r) => r.bottom)) - y,
		};
	})()`);
}

const changed = [];

/** Writes docs/onboarding/<lang>/<scene>.png only when its bytes differ from what is there. */
function writeScene(lang, scene, png) {
	const file = join(ONBOARDING_DIR, lang, `${scene}.png`);
	const same = existsSync(file) && readFileSync(file).equals(png);
	if (!same) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, png);
		changed.push(file);
	}
	console.log(`  ${same ? "same " : "wrote"} ${lang}/${scene}.png  ${Math.round(statSync(file).size / 1024)} KB`);
}

async function pressEscape(page) {
	await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))`);
	await sleep(300);
}

async function onboardingScenes(page, box, look) {
	const { lang } = look;
	const viewport = ONBOARDING_WINDOW;
	const wanted = new Set(readOnboardingScenes());
	const shoot = async (scene, rect) => {
		if (!wanted.delete(scene)) {
			throw new Error(`scene ${scene} is not in ONBOARDING_SCENES`);
		}
		await sleep(900);
		writeScene(lang, scene, await page.screenshot(rect ? frameAround(rect, viewport) : { x: 0, y: 0, ...viewport }, 1 / look.scale));
	};
	const menuOf = (name) =>
		`[...document.querySelectorAll('.agent-sessions-row')].find((r) => r.textContent.includes(${JSON.stringify(name.split(': ')[1])}))`;
	const openRowMenu = async (name) => {
		await page.evaluate(`(() => {
			const row = ${menuOf(name)};
			row.scrollIntoView({ block: "nearest" });
			row.querySelector('.agent-sessions-row-menu-btn').setAttribute('data-shot', '1');
		})()`);
		await page.hover(`[data-shot="1"]`);
		await sleep(200);
		await page.click(`[data-shot="1"]`);
		await page.evaluate(`document.querySelector('[data-shot]')?.removeAttribute('data-shot')`);
		await page.waitFor(`document.querySelector('.menu')`, { what: "the row menu" });
		await sleep(300);
	};
	const menuItem = (key) => `[...document.querySelectorAll('.menu-item')].find((i) => i.textContent.includes(${JSON.stringify(msg(lang, key))}))`;
	const sessions = box.sessions;
	const checkout = sessions.find((s) => s.transcript === "claude-checkout");
	const infra = sessions.find((s) => s.transcript === "claude-infra");

	console.log(`Onboarding scenes (${lang}):`);
	await clearNotices(page);
	await front(page, checkout.id);
	await shoot("overview");

	// The side panel: the top of the list with the nav row and a strip of the terminal.
	await shoot("side-panel", { x: 1180, y: 0, width: 420, height: 0 });

	// The row's ⋯ menu.
	await openRowMenu(checkout.name);
	await shoot("row-menu", await unionOf(page, [".menu"]));
	await pressEscape(page);

	// The same menu with "Restart session" under the pointer.
	await openRowMenu(infra.name);
	await page.evaluate(`(${menuItem("action.restartSession")}).setAttribute('data-shot', '1')`);
	await page.hover(`[data-shot="1"]`);
	await sleep(600);
	// The tooltip would cover the items below the highlighted one.
	await page.evaluate(`document.querySelectorAll('.tooltip').forEach((n) => n.remove())`);
	await shoot("restart", await unionOf(page, [".menu"]));
	await page.evaluate(`document.querySelector('[data-shot]')?.removeAttribute('data-shot')`);
	await pressEscape(page);

	// Move to category: the dialog with the category suggestions open.
	await openRowMenu(checkout.name);
	await page.evaluate(`${menuItem("action.moveToCategory")}.click()`);
	await page.waitFor(`document.querySelector('.modal .agent-sessions-name-input-field')`, { what: "the move dialog" });
	await page.click(`.modal .agent-sessions-name-input-field`);
	await sleep(500);
	await shoot("move-category", await unionOf(page, [".modal", ".suggestion-container"]));
	await pressEscape(page);
	await page.waitFor(`!document.querySelector('.modal')`, { what: "the move dialog to close" });

	// New session: the dialog with a name half typed.
	await page.click(`.agent-sessions-nav [aria-label=${JSON.stringify(msg(lang, "action.newSession"))}]`);
	await page.waitFor(`document.querySelector('.modal .agent-sessions-name-input-field')`, { what: "the new session dialog" });
	await page.click(`.modal .agent-sessions-name-input-field`);
	await page.type(look.scenario.newSessionName);
	await sleep(300);
	await shoot("new-session", await unionOf(page, [".modal"]));
	await pressEscape(page);
	await page.waitFor(`!document.querySelector('.modal')`, { what: "the new session dialog to close" });

	// The built-in editor under the terminal. A Claude prompt file (claude-prompt-*) gets the model and effort dropdowns.
	const draft = join(box.vault, ".agents", "claude-prompt-draft.md");
	writeFileSync(draft, look.scenario.editorDraft);
	await front(page, checkout.id);
	await page.evaluate(`(() => {
		const view = ${leafOf(checkout.id)}.view;
		window.__editorResult = view.openEditor(${JSON.stringify(draft)}, ${JSON.stringify(checkout.cwd)});
	})()`);
	await page.waitFor(`getComputedStyle(document.querySelector('.agent-sessions-terminal-editor')).display !== 'none'`, { what: "the editor pane" });
	await sleep(600);
	await shoot("editor", await unionOf(page, [".workspace-tabs.mod-active"]));
	await page.evaluate(`${leafOf(checkout.id)}.view.cancelEditor()`);
	await sleep(500);

	// Organize: the result view.
	await openOrganizeResult(page, look);
	await shoot("organize", await unionOf(page, [".agent-sessions-organize"]));
	await pressEscape(page);
	await page.waitFor(`!document.querySelector('.modal')`, { what: "the organize dialog to close" });

	// The install dialog, with a made-up plan so no path of this machine shows.
	await page.evaluate(`(() => {
		${PLUGIN}.planBackendInstall = async () => ({
			python: { path: "/usr/bin/python3", version: "3.12.4" },
			location: { dir: "/Users/demo/.local/share/agent-sessions" },
		});
		${PLUGIN}.openInstallBackend();
	})()`);
	await page.waitFor(`document.querySelector('.agent-sessions-install-plan')`, { what: "the install plan" });
	// Open "Details" so the picture shows where the program goes and what it adds.
	await page.evaluate(`document.querySelector('.agent-sessions-install-details').open = true`);
	await shoot("install", await unionOf(page, [".modal"]));
	await pressEscape(page);
	await page.waitFor(`!document.querySelector('.modal')`, { what: "the install dialog to close" });

	// Settings → the agents section, with made-up program paths.
	await page.evaluate(`(() => {
		const agents = ${PLUGIN}.settings.agents;
		window.__realPaths = { claude: agents.claude.path, codex: agents.codex.path };
		Object.assign(agents.claude, { path: ${JSON.stringify("/Users/demo/.local/bin/claude")} });
		Object.assign(agents.codex, { path: ${JSON.stringify("/opt/homebrew/bin/codex")} });
		// Settings open in a window of their own by default, out of reach of this page.
		app.setting.shouldUsePopout = () => false;
		app.setting.open();
		return 0;
	})()`);
	await page.waitFor(`document.querySelector('.modal.mod-settings')`, { what: "the settings dialog" });
	await sleep(800);
	await page.evaluate(`(app.setting.openTabById(${PLUGIN}.manifest.id), 0)`);
	await page.waitFor(`document.querySelector('.agent-sessions-settings-agent')`, { what: "the agents settings" });
	await page.evaluate(`(() => {
		const heading = [...document.querySelectorAll('.setting-item-heading .setting-item-name')].find((n) => n.textContent === ${JSON.stringify(msg(lang, "settings.agents.heading"))});
		heading.scrollIntoView({ block: "start" });
	})()`);
	await shoot("agents", await unionOf(page, [".modal.mod-settings"]));
	await page.evaluate(`(() => {
		app.setting.close();
		const agents = ${PLUGIN}.settings.agents;
		agents.claude.path = window.__realPaths.claude;
		agents.codex.path = window.__realPaths.codex;
	})()`);
	await sleep(300);

	// The session manager with its usage view.
	await page.evaluate(`(async () => {
		app.workspace.rightSplit.collapse();
		await app.commands.executeCommandById('agent-sessions:open-manager');
	})()`);
	await shoot("manager");

	if (wanted.size) {
		throw new Error(`no code shoots: ${[...wanted].join(", ")}`);
	}
}

// ---- One Obsidian run ---------------------------------------------------------------------

/**
 * Launches the sandbox in `look` (language, theme, viewport), lays out the workspace, and hands
 * the window to `scenes(page, box, look)`.
 */
async function withObsidian(look, scenes) {
	if (!existsSync(PLUGIN_JS)) {
		throw new Error(`${PLUGIN_JS} is missing — build the plugin first (see README.md next to this file)`);
	}
	const now = Math.floor(Date.now() / 1000);
	const root = mkdtempSync(join(tmpdir(), "as-shots-"));
	look.scenario = await scenarioFor(look.lang);
	const box = buildSandbox(root, now, look);
	const daemon = startFakeDaemon(join(box.runtime, "daemon.sock"), box.sessions, now, { lang: look.lang, light: look.light });
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

		// The UI language and community plugins on; both take effect on reload.
		await page.evaluate(`(async () => {
			localStorage.setItem('language', ${JSON.stringify(look.lang)});
			await app.plugins.setEnable(true);
			location.reload();
		})()`).catch(() => undefined);
		await sleep(1500);
		await page.waitFor(`window.app?.workspace?.layoutReady && !!${PLUGIN}`, { what: "the plugin to load" });
		await page.collectErrors(errors);
		await page.setViewport(look.window.width, look.window.height, look.scale);

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
			setRegistry(box.home, box.ids, s, "idle");
		}
		await sleep(1500);
		await clearNotices(page);
		await page.evaluate(`app.workspace.rightSplit.setSize(${SIDEBAR_WIDTH})`);

		await scenes(page, box, look);
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

async function run() {
	if (onboarding) {
		for (const lang of languages) {
			await withObsidian({ lang, light: true, window: ONBOARDING_WINDOW, scale: 2 }, onboardingScenes);
		}
		console.log(changed.length ? `Changed:\n${changed.map((f) => `  ${f}`).join("\n")}` : "No image changed.");
	} else {
		// Serves docs/onboarding/ for the welcome guide's picture.
		const server = createHttpServer((req, res) => {
			try {
				const body = readFileSync(join(ONBOARDING_DIR, decodeURIComponent(new URL(req.url, "http://x").pathname)));
				res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" }).end(body);
			} catch {
				res.writeHead(404).end();
			}
		});
		await new Promise((done) => server.listen(0, "127.0.0.1", done));
		const imageBase = `http://127.0.0.1:${server.address().port}`;
		try {
			for (const lang of languages) {
				readmeOutDir = lang === "en" ? README_OUT : join(README_OUT, lang);
				if (dialogsOnly || rcOnly || efficiencyOnly) {
					for (const light of [false, true]) {
						await withObsidian({ lang, light, window: WINDOW, scale: 2, imageBase }, rcOnly ? rcScenes : efficiencyOnly ? efficiencyScenes : dialogScenes);
					}
					continue;
				}
				await withObsidian({ lang, light: lightTheme, window: WINDOW, scale: 2, imageBase }, detailStateOnly ? detailStateScenes : loopOnly ? loopScenes : readmeScenes);
			}
		} finally {
			server.close();
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

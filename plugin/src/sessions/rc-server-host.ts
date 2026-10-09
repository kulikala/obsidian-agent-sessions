// The Remote Control server's ties to the daemon, the settings and the workspace
// (`RcServerControl`'s `RcServerDeps`). The server runs in the vault folder, under the daemon id
// `RC_SERVER_ID`, with the same environment as a Claude Code tab.

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { Notice, Platform } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { loginEnv, resolveAgentBinary, withBinDirOnPath } from "../backend/backend";
import { DaemonClient, ensureDaemon } from "../backend/daemon-client";
import { t } from "../i18n";
import { parseEnvLines } from "../settings";
import { ConfirmModal } from "../ui/modals";
import type { DaemonSession } from "../types";
import { buildRcServerArgv, findRcServer, parseProcessLinks, RC_SERVER_ID, rcSessionsAtWork } from "./rc-server";
import { RcServerControl, type RcServerWatch } from "./rc-server-control";

/** The size the server starts at, and the size its output watch asks for: the daemon sizes a PTY to
 * the smallest attached client, so an open tab's own size wins. */
const SERVER_COLS = 120;
const SERVER_ROWS = 40;

export function createRcServerControl(plugin: AgentSessionsPlugin): RcServerControl {
	return new RcServerControl({
		enabled: () => plugin.settings.rcServerEnabled,
		setEnabled: async (on) => {
			plugin.settings.rcServerEnabled = on;
			await plugin.saveSettings();
		},
		launch: (autoMode) => launch(plugin, autoMode),
		kill: async () => {
			const client = new DaemonClient(plugin.sockPath());
			await client.connect();
			try {
				await client.hello("plugin");
				await client.kill(RC_SERVER_ID);
			} finally {
				client.close();
			}
		},
		watch: (onOutput, onExit) => watch(plugin, onOutput, onExit),
		sessionsAtWork: async (serverPid) => {
			if (Platform.isWin) {
				return 0;
			}
			const links = parseProcessLinks(await psLinks());
			return rcSessionsAtWork(serverPid, links, plugin.index.registry.all().values());
		},
		confirmStop: (atWork) =>
			new Promise<boolean>((resolve) => {
				let confirmed = false;
				const modal = new ConfirmModal(plugin.app, t("confirm.rcServerStop.message", { count: atWork }), t("action.rcServerStop"), () => {
					confirmed = true;
				});
				const close = modal.onClose.bind(modal);
				modal.onClose = () => {
					close();
					resolve(confirmed);
				};
				modal.open();
			}),
		revealTerminal: () => void openRcServerTerminal(plugin),
		fail: (message) => new Notice(t("notice.rcServerFailed", { error: message })),
		announce: (event) =>
			new Notice(event === "listening" ? t("notice.rcServerListening", { folder: basename(plugin.vaultPath()) }) : t("notice.rcServerDown"), 8000),
	});
}

/** Opens the server's terminal tab, or brings it to the front. */
export function openRcServerTerminal(plugin: AgentSessionsPlugin): Promise<unknown> {
	return plugin.openSession(RC_SERVER_ID, { agent: "claude", cwd: plugin.vaultPath() });
}

/** Starts the server unless one already runs, and returns its daemon session. */
async function launch(plugin: AgentSessionsPlugin, autoMode: boolean): Promise<DaemonSession | null> {
	const settings = plugin.settings.agents.claude;
	const bin = await resolveAgentBinary("claude", settings.path, Platform.isMacOS);
	const launchEnv = await loginEnv(Platform.isMacOS);
	const env = withBinDirOnPath(
		{
			...launchEnv,
			...(await plugin.editorEnv("claude", launchEnv)),
			AGENT_SESSIONS_VAULT: plugin.vaultPath(),
			...parseEnvLines(settings.env),
		},
		bin
	);
	const client = await ensureDaemon(plugin.sockPath(), plugin.agentSessionsPath());
	try {
		await client.hello("plugin");
		const before = findRcServer(((await client.list()).sessions as DaemonSession[] | undefined) ?? []);
		if (before?.exited === null) {
			return before;
		}
		if (before) {
			await client.forget(RC_SERVER_ID).catch(() => undefined);
		}
		const res = await client.start({
			id: RC_SERVER_ID,
			agent: "claude",
			cwd: plugin.vaultPath(),
			argv: buildRcServerArgv(bin, autoMode),
			env,
			cols: SERVER_COLS,
			rows: SERVER_ROWS,
		});
		if (!res.ok && res.error !== "exists") {
			throw new Error(t("error.startFailed", { error: String(res.message ?? res.error ?? "unknown") }));
		}
		return findRcServer(((await client.list()).sessions as DaemonSession[] | undefined) ?? []);
	} finally {
		client.close();
	}
}

/** Attaches to the server for its output. The daemon replays what it kept first. */
async function watch(plugin: AgentSessionsPlugin, onOutput: (text: string) => void, onExit: () => void): Promise<RcServerWatch> {
	const client = await ensureDaemon(plugin.sockPath(), plugin.agentSessionsPath());
	let closing = false;
	let ended = false;
	const end = (): void => {
		if (!closing && !ended) {
			ended = true;
			onExit();
		}
	};
	const decode = (buf: Buffer): void => onOutput(buf.toString("utf8"));
	client.on("data", decode);
	client.on("replay", decode);
	client.on("exit", (id: string) => {
		if (id === RC_SERVER_ID) {
			end();
		}
	});
	client.on("close", end);
	client.on("error", (err: Error) => console.warn("agent-sessions: rc-server socket", err));
	try {
		await client.hello("plugin");
		const res = await client.attach(RC_SERVER_ID, SERVER_COLS, SERVER_ROWS);
		if (!res.ok) {
			throw new Error(res.error ?? "attach");
		}
	} catch (err) {
		closing = true;
		client.close();
		throw err;
	}
	return {
		close: () => {
			closing = true;
			client.close();
		},
	};
}

function psLinks(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("ps", ["-A", "-o", "pid=,ppid="], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
			if (err) {
				reject(err);
			} else {
				resolve(stdout);
			}
		});
	});
}

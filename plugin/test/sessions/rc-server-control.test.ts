import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RcServerControl, type RcServerDeps } from "../../src/sessions/rc-server-control";
import { RC_SERVER_ID } from "../../src/sessions/rc-server";
import type { DaemonSession } from "../../src/types";

function server(over: Partial<DaemonSession> = {}): DaemonSession {
	return { id: RC_SERVER_ID, agent: "claude", cwd: "/v", pid: 100, startedAt: 1, clients: 0, exited: null, exitedAt: null, ...over };
}

interface Harness {
	control: RcServerControl;
	deps: RcServerDeps;
	launch: ReturnType<typeof vi.fn>;
	kill: ReturnType<typeof vi.fn>;
	confirmStop: ReturnType<typeof vi.fn>;
	revealTerminal: ReturnType<typeof vi.fn>;
	/** Sends output from the server to the current watch. */
	output(text: string): void;
	/** Ends the server, as the daemon's `exit` event does. */
	exit(): void;
	settings: { enabled: boolean };
}

function harness(opts: { enabled?: boolean; atWork?: number; confirm?: boolean; launched?: DaemonSession } = {}): Harness {
	const settings = { enabled: opts.enabled ?? false };
	let onOutput: (text: string) => void = () => undefined;
	let onExit: () => void = () => undefined;
	const launch = vi.fn(async () => opts.launched ?? server());
	const kill = vi.fn(async () => undefined);
	const confirmStop = vi.fn(async () => opts.confirm ?? true);
	const revealTerminal = vi.fn();
	const deps: RcServerDeps = {
		enabled: () => settings.enabled,
		setEnabled: async (on) => {
			settings.enabled = on;
		},
		launch,
		kill,
		watch: async (out, exit) => {
			onOutput = out;
			onExit = exit;
			return { close: () => undefined };
		},
		sessionsAtWork: async () => opts.atWork ?? 0,
		confirmStop,
		revealTerminal,
		fail: () => undefined,
	};
	return {
		control: new RcServerControl(deps),
		deps,
		launch,
		kill,
		confirmStop,
		revealTerminal,
		output: (text) => onOutput(text),
		exit: () => onExit(),
		settings,
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

describe("RcServerControl: never starts by itself", () => {
	it("is down, and starts nothing, when the plugin loads with the toggle on and no server", () => {
		const h = harness({ enabled: true });
		h.control.sync([]);
		expect(h.control.state()).toBe("down");
		expect(h.launch).not.toHaveBeenCalled();
	});

	it("starts nothing when the daemon lists an ended server, however often it refreshes", () => {
		const h = harness({ enabled: true });
		for (let i = 0; i < 5; i++) {
			h.control.sync([server({ exited: 1, exitedAt: 9 })]);
		}
		expect(h.control.state()).toBe("down");
		expect(h.launch).not.toHaveBeenCalled();
	});

	it("starts nothing when a running server ends", async () => {
		const h = harness({ enabled: true });
		h.control.sync([server()]);
		await settle();
		h.output("…/code?environment=env_1");
		expect(h.control.state()).toBe("listening");
		h.exit();
		await settle();
		expect(h.control.state()).toBe("down");
		h.control.sync([]);
		expect(h.launch).not.toHaveBeenCalled();
	});

	it("starts nothing on a settings change", () => {
		const h = harness({ enabled: false });
		h.settings.enabled = true;
		h.control.settingsChanged();
		expect(h.control.state()).toBe("down");
		expect(h.launch).not.toHaveBeenCalled();
	});
});

describe("RcServerControl: who may start the server", () => {
	const src = (file: string) => fs.readFileSync(path.join(__dirname, "..", "..", "src", file), "utf8");
	const starts = /rcServer\.(click|startFromTerminal)\(/g;

	it("only the toggle's click handlers and the terminal tab's start button call it", () => {
		expect(src("main.ts").match(starts)).toBeNull();
		expect(src("sessions/rc-server-host.ts").match(starts)).toBeNull();
		expect(src("views/side.ts").match(starts)).toEqual(["rcServer.click(", "rcServer.click("]);
		expect(src("views/terminal.ts").match(starts)).toEqual(["rcServer.startFromTerminal("]);
	});
});

describe("RcServerControl: clicks", () => {
	it("turns on and starts in auto mode from off", async () => {
		const h = harness();
		await h.control.click();
		expect(h.settings.enabled).toBe(true);
		expect(h.launch).toHaveBeenCalledWith(true);
		expect(h.control.state()).toBe("starting");
		h.output("space for QR code");
		expect(h.control.state()).toBe("listening");
	});

	it("wakes a down server and stays on", async () => {
		const h = harness({ enabled: true });
		h.control.sync([]);
		await h.control.click();
		expect(h.launch).toHaveBeenCalledTimes(1);
		expect(h.settings.enabled).toBe(true);
		expect(h.control.state()).toBe("starting");
	});

	it("stops a listening server without asking when no session works", async () => {
		const h = harness({ enabled: true });
		h.control.sync([server()]);
		await settle();
		await h.control.click();
		expect(h.confirmStop).not.toHaveBeenCalled();
		expect(h.kill).toHaveBeenCalledTimes(1);
		expect(h.settings.enabled).toBe(false);
		expect(h.control.state()).toBe("off");
	});

	it("asks before stopping a server whose sessions work, and keeps it when declined", async () => {
		const h = harness({ enabled: true, atWork: 2, confirm: false });
		h.control.sync([server()]);
		await settle();
		await h.control.click();
		expect(h.confirmStop).toHaveBeenCalledWith(2);
		expect(h.kill).not.toHaveBeenCalled();
		expect(h.settings.enabled).toBe(true);
	});

	it("stops after the confirmation", async () => {
		const h = harness({ enabled: true, atWork: 1, confirm: true });
		h.control.sync([server()]);
		await settle();
		await h.control.click();
		expect(h.kill).toHaveBeenCalledTimes(1);
		expect(h.control.state()).toBe("off");
	});
});

describe("RcServerControl: the terminal tab's start button", () => {
	it("starts a stopped server, turning the toggle on", async () => {
		const h = harness();
		await h.control.startFromTerminal();
		expect(h.launch).toHaveBeenCalledTimes(1);
		expect(h.settings.enabled).toBe(true);
		expect(h.control.running()).toBe(true);
	});

	it("leaves a running server alone", async () => {
		const h = harness({ enabled: true });
		h.control.sync([server()]);
		await settle();
		await h.control.startFromTerminal();
		expect(h.launch).not.toHaveBeenCalled();
		expect(h.kill).not.toHaveBeenCalled();
	});
});

describe("RcServerControl: the terminal", () => {
	it("brings the terminal to the front once when a started server asks a question", async () => {
		const h = harness();
		await h.control.click();
		h.output("Enable Remote Control? (y/n) ");
		expect(h.revealTerminal).toHaveBeenCalledTimes(1);
		expect(h.control.asking()).toBe(true);
		h.output("y\n/code?environment=env_1");
		h.output("\nTrust this folder? [y/N]");
		expect(h.revealTerminal).toHaveBeenCalledTimes(1);
	});

	it("leaves the terminal hidden when a started server needs no answer", async () => {
		const h = harness();
		await h.control.click();
		h.output("/code?environment=env_1");
		expect(h.revealTerminal).not.toHaveBeenCalled();
	});

	it("leaves the terminal alone for a server already running when the plugin loads", async () => {
		const h = harness({ enabled: true });
		h.control.sync([server()]);
		await settle();
		h.output("Enable Remote Control? (y/n) ");
		expect(h.revealTerminal).not.toHaveBeenCalled();
	});
});

describe("RcServerControl: auto mode refused", () => {
	it("starts again without --permission-mode auto, once", async () => {
		const h = harness();
		await h.control.click();
		h.output("error: option '--permission-mode <mode>' argument 'auto' is invalid.");
		h.exit();
		await settle();
		expect(h.launch).toHaveBeenNthCalledWith(2, false);
		h.output("error: option '--permission-mode <mode>' argument 'auto' is invalid.");
		h.exit();
		await settle();
		expect(h.launch).toHaveBeenCalledTimes(2);
		expect(h.control.state()).toBe("down");
	});

	it("does not start again after any other failure", async () => {
		const h = harness();
		await h.control.click();
		h.output("Workspace not trusted.");
		h.exit();
		await settle();
		expect(h.launch).toHaveBeenCalledTimes(1);
		expect(h.control.state()).toBe("down");
	});
});

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RcServerControl, type RcServerDeps } from "../../src/sessions/rc-server-control";
import { RC_SERVER_ID, type RcPermissionMode } from "../../src/sessions/rc-server";
import type { DaemonSession } from "../../src/types";

function server(over: Partial<DaemonSession> = {}): DaemonSession {
	return { id: RC_SERVER_ID, agent: "claude", cwd: "/v", pid: 100, startedAt: 1, clients: 0, exited: null, exitedAt: null, ...over };
}

interface Harness {
	control: RcServerControl;
	deps: RcServerDeps;
	launch: ReturnType<typeof vi.fn>;
	list: ReturnType<typeof vi.fn>;
	kill: ReturnType<typeof vi.fn>;
	confirmStop: ReturnType<typeof vi.fn>;
	confirmStart: ReturnType<typeof vi.fn>;
	revealTerminal: ReturnType<typeof vi.fn>;
	announce: ReturnType<typeof vi.fn>;
	/** Sends output from the server to the current watch. */
	output(text: string): void;
	/** Ends the server, as the daemon's `exit` event does. */
	exit(): void;
	settings: { enabled: boolean; mode: RcPermissionMode; accepted: RcPermissionMode | null };
}

function harness(
	opts: {
		enabled?: boolean;
		atWork?: number;
		confirm?: boolean;
		launched?: DaemonSession;
		listed?: DaemonSession[];
		unsynced?: boolean;
		mode?: RcPermissionMode;
		/** The accepted mode; the default `"auto"` is a user who has already said yes. */
		accepted?: RcPermissionMode | null;
		/** The answer to the start confirmation. */
		start?: boolean;
	} = {}
): Harness {
	const listed = opts.listed ?? [];
	const list = vi.fn(async () => listed);
	const settings = {
		enabled: opts.enabled ?? false,
		mode: opts.mode ?? "auto",
		accepted: opts.accepted === undefined ? ("auto" as RcPermissionMode) : opts.accepted,
	};
	const confirmStart = vi.fn(async () => opts.start ?? true);
	let onOutput: (text: string) => void = () => undefined;
	let onExit: () => void = () => undefined;
	const launch = vi.fn(async () => opts.launched ?? server());
	const kill = vi.fn(async () => undefined);
	const confirmStop = vi.fn(async () => opts.confirm ?? true);
	const revealTerminal = vi.fn();
	const announce = vi.fn();
	const deps: RcServerDeps = {
		enabled: () => settings.enabled,
		setEnabled: async (on) => {
			settings.enabled = on;
		},
		list,
		mode: () => settings.mode,
		accepted: () => settings.accepted,
		setAccepted: async (mode) => {
			settings.accepted = mode;
		},
		confirmStart,
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
		announce,
	};
	const control = new RcServerControl(deps);
	if (!opts.unsynced) {
		control.sync(listed);
	}
	return {
		list,
		control,
		deps,
		launch,
		kill,
		confirmStop,
		confirmStart,
		revealTerminal,
		announce,
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
		expect(h.launch).toHaveBeenCalledWith("auto");
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

describe("RcServerControl: before the first daemon list", () => {
	it("isn't down, and ignores clicks, until the daemon list comes in", async () => {
		const h = harness({ enabled: true, unsynced: true });
		expect(h.control.state()).toBe("starting");
		await h.control.click();
		expect(h.launch).not.toHaveBeenCalled();
		h.control.sync([]);
		expect(h.control.state()).toBe("down");
		expect(h.announce).not.toHaveBeenCalled();
	});

	it("asks the daemon at once on load, and follows a running server without starting it", async () => {
		const h = harness({ enabled: true, unsynced: true, listed: [server()] });
		await h.control.load();
		await settle();
		expect(h.list).toHaveBeenCalledTimes(1);
		expect(h.control.state()).toBe("starting");
		h.output("https://claude.ai/code?environment=env_1");
		expect(h.control.state()).toBe("listening");
		expect(h.launch).not.toHaveBeenCalled();
		expect(h.announce).not.toHaveBeenCalled();
	});

	it("settles as down on load when the daemon has no server", async () => {
		const h = harness({ enabled: true, unsynced: true });
		await h.control.load();
		expect(h.control.state()).toBe("down");
		expect(h.launch).not.toHaveBeenCalled();
	});
});

describe("RcServerControl: no second server", () => {
	it("follows the server the daemon still runs instead of starting another", async () => {
		const h = harness({ enabled: true });
		expect(h.control.state()).toBe("down");
		h.list.mockResolvedValueOnce([server({ pid: 37637 })]);
		await h.control.click();
		expect(h.launch).not.toHaveBeenCalled();
		expect(h.control.running()).toBe(true);
	});

	it("starts one when the daemon's list has only an ended server", async () => {
		const h = harness({ enabled: true });
		h.list.mockResolvedValueOnce([server({ exited: 1, exitedAt: 9 })]);
		await h.control.click();
		expect(h.launch).toHaveBeenCalledTimes(1);
	});
});

describe("RcServerControl: notices and the link", () => {
	const link = "https://claude.ai/code?environment=env_01AbC-9";

	it("announces once when a clicked start begins listening, and offers its link", async () => {
		const h = harness();
		await h.control.click();
		expect(h.control.link()).toBeNull();
		h.output(`Remote Control  ${link}\nspace for QR code`);
		h.output("space for QR code");
		expect(h.announce.mock.calls).toEqual([["listening"]]);
		expect(h.control.link()).toBe(link);
	});

	it("says nothing when the plugin loads and finds a listening server", async () => {
		const h = harness({ enabled: true });
		h.control.sync([server()]);
		await settle();
		h.output(link);
		expect(h.control.state()).toBe("listening");
		expect(h.announce).not.toHaveBeenCalled();
	});

	it("announces once when a running server stops, and drops the link", async () => {
		const h = harness({ enabled: true });
		h.control.sync([server()]);
		await settle();
		h.output(link);
		h.exit();
		await settle();
		h.control.sync([server({ exited: 1, exitedAt: 9 })]);
		h.control.sync([]);
		expect(h.announce.mock.calls).toEqual([["down"]]);
		expect(h.control.link()).toBeNull();
	});

	it("announces a stop only from listening, not from a server that never listened", async () => {
		const h = harness({ enabled: true });
		h.control.sync([server()]);
		await settle();
		expect(h.control.state()).toBe("starting");
		h.exit();
		await settle();
		expect(h.control.state()).toBe("down");
		expect(h.announce).not.toHaveBeenCalled();
	});

	it("says nothing when on at load without a server, or when turned off", async () => {
		const quiet = harness({ enabled: true });
		quiet.control.sync([]);
		expect(quiet.announce).not.toHaveBeenCalled();
		const off = harness({ enabled: true });
		off.control.sync([server()]);
		await settle();
		await off.control.click();
		off.control.sync([]);
		expect(off.announce).not.toHaveBeenCalled();
	});

	it("doesn't announce a stop when a refused auto mode starts again", async () => {
		const h = harness();
		await h.control.click();
		h.output("error: option '--permission-mode <mode>' argument 'auto' is invalid.");
		h.exit();
		await settle();
		expect(h.announce).not.toHaveBeenCalled();
		h.output(link);
		expect(h.announce.mock.calls).toEqual([["listening"]]);
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

describe("RcServerControl: permission mode and the start confirmation", () => {
	it("starts in the mode the settings name", async () => {
		const h = harness({ mode: "plan", accepted: "plan" });
		await h.control.click();
		expect(h.launch).toHaveBeenCalledWith("plan");
	});

	it("asks the first time, then never again", async () => {
		const h = harness({ accepted: null });
		await h.control.click();
		expect(h.confirmStart).toHaveBeenCalledWith("auto");
		expect(h.settings.accepted).toBe("auto");
		expect(h.launch).toHaveBeenCalledTimes(1);
		await h.control.click();
		h.settings.enabled = false;
		h.control.settingsChanged();
		await h.control.click();
		expect(h.confirmStart).toHaveBeenCalledTimes(1);
		expect(h.launch).toHaveBeenCalledTimes(2);
	});

	it("asks the first time in a mode other than auto too", async () => {
		const h = harness({ mode: "default", accepted: null });
		await h.control.click();
		expect(h.confirmStart).toHaveBeenCalledWith("default");
		expect(h.settings.accepted).toBe("default");
	});

	it("stays off, records nothing and starts nothing when the user cancels", async () => {
		const h = harness({ accepted: null, start: false });
		await h.control.click();
		expect(h.settings.enabled).toBe(false);
		expect(h.settings.accepted).toBeNull();
		expect(h.launch).not.toHaveBeenCalled();
		expect(h.control.state()).toBe("off");
	});

	it("asks again on the next start after the mode changes to auto", async () => {
		const h = harness({ mode: "default", accepted: "default" });
		h.settings.mode = "auto";
		await h.control.click();
		expect(h.confirmStart).toHaveBeenCalledWith("auto");
		expect(h.launch).toHaveBeenCalledWith("auto");
	});

	it("asks before waking a down server whose mode changed to auto", async () => {
		const h = harness({ enabled: true, mode: "auto", accepted: "plan", start: false });
		h.control.sync([]);
		expect(h.control.state()).toBe("down");
		await h.control.click();
		expect(h.confirmStart).toHaveBeenCalledTimes(1);
		expect(h.launch).not.toHaveBeenCalled();
		expect(h.control.state()).toBe("down");
	});

	it("never asks before a stop", async () => {
		const h = harness({ enabled: true, accepted: null });
		h.control.sync([server()]);
		await settle();
		await h.control.click();
		expect(h.confirmStart).not.toHaveBeenCalled();
		expect(h.settings.enabled).toBe(false);
	});

	it("ignores clicks while the confirmation is open", async () => {
		let answer: (yes: boolean) => void = () => undefined;
		const h = harness({ accepted: null });
		h.confirmStart.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)));
		const first = h.control.click();
		await settle();
		await h.control.click();
		expect(h.confirmStart).toHaveBeenCalledTimes(1);
		answer(true);
		await first;
		expect(h.launch).toHaveBeenCalledTimes(1);
	});
});

describe("RcServerControl: auto mode refused", () => {
	it("starts again without --permission-mode auto, once", async () => {
		const h = harness();
		await h.control.click();
		h.output("error: option '--permission-mode <mode>' argument 'auto' is invalid.");
		h.exit();
		await settle();
		expect(h.launch).toHaveBeenNthCalledWith(2, "default");
		h.output("error: option '--permission-mode <mode>' argument 'auto' is invalid.");
		h.exit();
		await settle();
		expect(h.launch).toHaveBeenCalledTimes(2);
		expect(h.control.state()).toBe("down");
	});

	it("does not start again when the refused start was not in auto", async () => {
		const h = harness({ mode: "plan", accepted: "plan" });
		await h.control.click();
		h.output("error: option '--permission-mode <mode>' argument 'auto' is invalid.");
		h.exit();
		await settle();
		expect(h.launch).toHaveBeenCalledTimes(1);
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

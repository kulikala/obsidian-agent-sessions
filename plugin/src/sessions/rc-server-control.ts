// Drives the Remote Control server (`rc-server.ts`) for the side panel's toggle. Only a click starts
// the server: loading the plugin, a refresh of the daemon's list, and the server ending never do. The
// daemon, the settings, and the dialogs come in as `RcServerDeps`, so this runs without Obsidian.

import type { DaemonSession } from "../types";
import {
	findRcServer,
	plainOutput,
	rcServerClick,
	rcServerSignal,
	rcServerState,
	rejectsAutoMode,
	type RcServerSignal,
	type RcServerState,
} from "./rc-server";

/** How much of the server's latest output is kept for reading its signals. */
const OUTPUT_KEEP = 16_000;

/** A watch on the server's output, from `RcServerDeps.watch`. */
export interface RcServerWatch {
	close(): void;
}

export interface RcServerDeps {
	enabled(): boolean;
	setEnabled(on: boolean): Promise<void>;
	/** Starts the server in the daemon (after forgetting an ended one) and returns its daemon
	 * session. `autoMode` adds `--permission-mode auto`. */
	launch(autoMode: boolean): Promise<DaemonSession | null>;
	/** Ends the server. */
	kill(): Promise<void>;
	/** Follows the server's output from the start (the daemon replays what it kept) until `close`. */
	watch(onOutput: (text: string) => void, onExit: () => void): Promise<RcServerWatch>;
	/** How many of the server's sessions are working now. */
	sessionsAtWork(serverPid: number): Promise<number>;
	/** Asks before stopping a server whose sessions are working. */
	confirmStop(atWork: number): Promise<boolean>;
	/** Brings the server's terminal tab to the front. */
	revealTerminal(): void;
	/** Reports a failed start or stop. */
	fail(message: string): void;
}

export class RcServerControl {
	private daemon: DaemonSession | null = null;
	private launching = false;
	private signal: RcServerSignal = null;
	private output = "";
	private watching: RcServerWatch | null = null;
	private watchPending = false;
	/** `--permission-mode auto` was refused this time: started again without it. */
	private autoRefused = false;
	/** Brought the terminal to the front for a question since the last start (a server already
	 * running when the plugin loads keeps its terminal where it is). */
	private revealed = true;
	private current: RcServerState;
	private lastAsking = false;
	private lastRunning = false;
	private listeners = new Set<() => void>();
	private disposed = false;

	constructor(private deps: RcServerDeps) {
		this.current = this.derive();
	}

	state(): RcServerState {
		return this.current;
	}

	/** Whether the daemon runs the server. */
	running(): boolean {
		return this.daemon?.exited === null;
	}

	/** Whether the server waits for an answer in its terminal. */
	asking(): boolean {
		return this.current === "starting" && this.signal === "question";
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	/** The daemon's list after a refresh. Follows a running server's output; never starts one. */
	sync(sessions: readonly DaemonSession[]): void {
		if (this.disposed) {
			return;
		}
		this.daemon = findRcServer(sessions);
		if (this.daemon?.exited === null) {
			void this.ensureWatch();
		} else if (!this.launching) {
			this.closeWatch();
		}
		this.update();
	}

	/** The toggle's settings changed elsewhere (another device's sync, a reset). */
	settingsChanged(): void {
		this.update();
	}

	/** A click on the toggle. */
	async click(): Promise<void> {
		if (this.launching) {
			return;
		}
		switch (rcServerClick(this.current)) {
			case "start":
				await this.deps.setEnabled(true);
				await this.start();
				break;
			case "wake":
				await this.start();
				break;
			case "stop":
				await this.stop();
				break;
		}
	}

	/** The start button in the server's terminal tab: starts the server unless it runs. */
	async startFromTerminal(): Promise<void> {
		if (this.current === "off" || this.current === "down") {
			await this.click();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.closeWatch();
		this.listeners.clear();
	}

	private async start(): Promise<void> {
		if (this.launching) {
			return;
		}
		this.launching = true;
		this.autoRefused = false;
		this.revealed = false;
		this.resetOutput();
		this.closeWatch();
		this.update();
		try {
			this.daemon = await this.deps.launch(true);
			await this.ensureWatch();
		} catch (err) {
			this.deps.fail(err instanceof Error ? err.message : String(err));
		} finally {
			this.launching = false;
			this.update();
		}
	}

	private async stop(): Promise<void> {
		const pid = this.daemon?.exited === null ? this.daemon.pid : null;
		if (pid !== null) {
			const atWork = await this.deps.sessionsAtWork(pid).catch(() => 0);
			if (atWork > 0 && !(await this.deps.confirmStop(atWork))) {
				return;
			}
		}
		await this.deps.setEnabled(false);
		this.closeWatch();
		this.resetOutput();
		this.update();
		if (pid !== null) {
			await this.deps.kill().catch((err) => this.deps.fail(err instanceof Error ? err.message : String(err)));
		}
	}

	private async ensureWatch(): Promise<void> {
		if (this.watching || this.watchPending || this.disposed) {
			return;
		}
		this.watchPending = true;
		this.resetOutput();
		try {
			const watch = await this.deps.watch(
				(text) => this.onOutput(text),
				() => void this.onExit()
			);
			if (this.disposed) {
				watch.close();
				return;
			}
			this.watching = watch;
		} catch {
			// The daemon isn't reachable: the next `sync` tries again.
		} finally {
			this.watchPending = false;
		}
	}

	private closeWatch(): void {
		this.watching?.close();
		this.watching = null;
	}

	private resetOutput(): void {
		this.output = "";
		this.signal = null;
	}

	private onOutput(text: string): void {
		this.output = (this.output + plainOutput(text)).slice(-OUTPUT_KEEP);
		const signal = rcServerSignal(this.output);
		if (signal === this.signal) {
			return;
		}
		this.signal = signal;
		if (signal === "question" && !this.revealed) {
			this.revealed = true;
			this.deps.revealTerminal();
		}
		this.update();
	}

	/** The server ended. Stays down until a click, except right after a start whose
	 * `--permission-mode auto` was refused: that start goes on without it. */
	private async onExit(): Promise<void> {
		this.closeWatch();
		const refused = !this.autoRefused && this.deps.enabled() && rejectsAutoMode(this.output);
		if (this.daemon) {
			this.daemon = { ...this.daemon, exited: this.daemon.exited ?? -1 };
		}
		this.update();
		if (!refused) {
			return;
		}
		this.autoRefused = true;
		this.launching = true;
		this.resetOutput();
		this.update();
		try {
			this.daemon = await this.deps.launch(false);
			await this.ensureWatch();
		} catch (err) {
			this.deps.fail(err instanceof Error ? err.message : String(err));
		} finally {
			this.launching = false;
			this.update();
		}
	}

	private derive(): RcServerState {
		return rcServerState({
			enabled: this.deps.enabled(),
			daemon: this.daemon,
			launching: this.launching,
			signal: this.signal,
		});
	}

	private update(): void {
		const next = this.derive();
		const asking = this.signal === "question";
		const running = this.running();
		if (next === this.current && asking === this.lastAsking && running === this.lastRunning) {
			return;
		}
		this.current = next;
		this.lastAsking = asking;
		this.lastRunning = running;
		for (const cb of [...this.listeners]) {
			cb();
		}
	}
}

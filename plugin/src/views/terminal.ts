// The terminal: one session per tab, tab icon state, and error handling. Connects xterm 5.x to
// `DaemonClient`.

import {
	ItemView,
	Notice,
	Platform,
	setIcon,
	setTooltip,
	type Menu,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";
import * as fs from "node:fs";
import { join } from "node:path";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { BackendError, loginEnv, resolveClaude } from "../backend/backend";
import { DaemonClient, DaemonUnavailableError, ensureDaemon } from "../backend/daemon-client";
import { t } from "../i18n";
import { classifyCtrlKeyNonMac, classifyEnter, resolveEnterAction, sendSequence } from "../terminal/keys";
import { buildAtToken, selectionLineRange, VaultLinkProvider } from "../terminal/links";
import { submitSequence } from "../main";
import type AgentSessionsPlugin from "../main";
import { MarkTracker, type MarkerHandle, type MarkerSource } from "../terminal/marks";
import { RenameSessionModal } from "../ui/modals";
import { sessionDisplayName } from "../sessions/name";
import { VIEW_TYPE_TERMINAL } from "../sessions/open-session";
import type { Padding } from "../settings";
import {
	ALL_TERMINAL_STATUSES,
	STATUS_LABEL_KEY,
	TERMINAL_STATUS_ICON,
	terminalStatus,
	terminalStatusClass,
	type TerminalStatus,
} from "../sessions/terminal-status";
import { readObsidianTheme } from "../terminal/theme";
import type { DaemonSession } from "../types";
import { EditorPane, type EditResult } from "./editor-pane";

export { VIEW_TYPE_TERMINAL };

export interface TerminalState {
	id: string;
	agent: string;
	cwd: string;
	fontSize?: number;
	/** A brand-new session. Stays true until the first `start` completes, and starts with `--session-id`. */
	fresh?: boolean;
}

const PADDING_PX: Record<Padding, number> = { comfortable: 12, compact: 4, none: 0 };
const RESIZE_DEBOUNCE_MS = 50;
/** An `exit` within this long after `start` is treated as a startup failure. */
const EARLY_EXIT_MS = 3000;
const RESUME_FAILURE_PATTERNS = ["No conversation found", "not found"];
const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 40;
/** Min/max for the editor pane's height (%). Acts as a ceiling — the terminal's minimum row count takes priority. */
const EDITOR_HEIGHT_MIN = 10;
const EDITOR_HEIGHT_MAX = 90;
/** Minimum rows left for the terminal while the editor pane is open. */
const TERMINAL_MIN_ROWS = 8;

type ExitReason =
	| { kind: "exited"; code: number; resumeFailed: boolean }
	| { kind: "claude-missing"; message: string }
	| { kind: "daemon-unavailable"; message: string }
	| { kind: "disconnected" }
	| { kind: "error"; message: string };

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export class TerminalView extends ItemView {
	navigation = false;

	private id = "";
	private agent = "claude";
	private cwd = "";
	private fontSize: number | undefined;
	private fresh = false;

	private terminal: Terminal;
	private fit = new FitAddon();
	private bodyEl!: HTMLElement;
	/** The element xterm renders into. Shrinks when the editor pane opens. */
	private termEl!: HTMLElement;
	/** The editor pane. Hidden while closed. */
	private editorEl!: HTMLElement;
	private exitEl!: HTMLElement;
	/** The in-progress edit, if any. Every closing path resolves this. */
	private pendingEdit: EditorPane | null = null;
	private opened = false;
	private closed = false;
	private lastSize = { width: 0, height: 0 };
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;

	private client: DaemonClient | null = null;
	private attaching = false;
	private attached = false;
	private exitReason: ExitReason | null = null;
	private replayChunks: Buffer[] | null = null;
	private startedAt = 0;
	private earlyOutput = "";

	private waiting = false;
	private displayName = "";

	/** Jump: remembers where instructions and responses start. xterm's markers are wrapped by `markerSource()`. */
	private marks: MarkTracker;
	/** The header's three jump buttons. Their tooltips swap out when in fullscreen. */
	private jumpActions: { prev?: HTMLElement; next?: HTMLElement; last?: HTMLElement } = {};

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: AgentSessionsPlugin
	) {
		super(leaf);
		this.terminal = new Terminal({
			fontFamily: plugin.settings.fontFamily,
			fontSize: plugin.settings.fontSize,
			lineHeight: 1.0,
			letterSpacing: 0,
			scrollback: plugin.settings.scrollback,
			allowProposedApi: true,
			macOptionIsMeta: true,
			cursorBlink: true,
		});
		this.marks = new MarkTracker(this.markerSource());
	}

	/** Wraps xterm's `registerMarker` as a `MarkerSource` (`marks.ts` has no dependency on xterm). */
	private markerSource(): MarkerSource {
		return {
			registerMarker: (): MarkerHandle | undefined => {
				const marker = this.terminal.registerMarker(0);
				if (!marker) {
					return undefined;
				}
				return {
					get line() {
						return marker.line;
					},
					get isDisposed() {
						return marker.line === -1;
					},
				};
			},
		};
	}

	getViewType(): string {
		return VIEW_TYPE_TERMINAL;
	}

	getDisplayText(): string {
		return sessionDisplayName(this.displayName, this.id);
	}

	getIcon(): string {
		return this.icon || "square-terminal";
	}

	/** Used by the side panel and manager to find the target for renaming or compacting. */
	get sessionId(): string {
		return this.id;
	}

	/** Writes straight to the PTY, used by `@` insertion. */
	sendCommand(text: string): void {
		this.sendInput(Buffer.from(text, "utf8"));
	}

	/** Writes an already-assembled byte sequence to the PTY, called from `main.ts`'s `sendCommand`. */
	sendBytes(bytes: Buffer): void {
		this.sendInput(bytes);
	}

	/** Whether this tab is attached to the daemon (the condition `main.ts`'s `sendCommand` uses to pick its first route). */
	isAttached(): boolean {
		return !!this.client && this.attached;
	}

	getState(): Record<string, unknown> {
		const state: Record<string, unknown> = { id: this.id, agent: this.agent, cwd: this.getCwd() };
		if (this.fontSize !== undefined) {
			state.fontSize = this.fontSize;
		}
		if (this.fresh) {
			state.fresh = true;
		}
		return state;
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as Partial<TerminalState>;
		const nextId = typeof s.id === "string" ? s.id : "";
		if (this.id && nextId && nextId !== this.id) {
			this.disconnect();
			if (this.exitEl) {
				this.hideExit();
			}
			this.terminal.reset();
		}
		this.id = nextId;
		this.agent = typeof s.agent === "string" && s.agent ? s.agent : "claude";
		this.cwd = typeof s.cwd === "string" ? s.cwd : "";
		this.fontSize = typeof s.fontSize === "number" ? s.fontSize : undefined;
		this.fresh = s.fresh === true;
		await super.setState(state, result);
		this.refreshName();
		this.updateIcon();
		this.applySettings();
		// Don't close self even if another leaf has the same `id`: splitting right/down or
		// duplicating a tab lets multiple views attach to the same session. `openSession` moves
		// to an existing tab, so duplicates can only come from a split.
		this.app.workspace.onLayoutReady(() => {
			if (this.closed) {
				return;
			}
			this.maybeAttach();
		});
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("agent-sessions-terminal");
		this.bodyEl = this.contentEl.createDiv({ cls: "agent-sessions-terminal-body" });
		this.termEl = this.bodyEl.createDiv({ cls: "agent-sessions-terminal-term" });
		this.editorEl = this.bodyEl.createDiv({ cls: "agent-sessions-terminal-editor" });
		this.editorEl.hide();
		this.exitEl = this.contentEl.createDiv({ cls: "agent-sessions-exit" });
		this.exitEl.hide();

		this.terminal.loadAddon(this.fit);
		this.terminal.loadAddon(new Unicode11Addon());
		this.terminal.unicode.activeVersion = "11";
		this.terminal.attachCustomKeyEventHandler((ev) => this.handleKey(ev));
		// While the editor pane is open, don't forward anything to the PTY — including IME-confirmed characters and paste.
		const onData = this.terminal.onData((data) => {
			if (this.pendingEdit) {
				return;
			}
			this.sendInput(Buffer.from(data, "utf8"));
		});
		const onBinary = this.terminal.onBinary((data) => {
			if (this.pendingEdit) {
				return;
			}
			this.sendInput(Buffer.from(data, "binary"));
		});
		const onResize = this.terminal.onResize(({ cols, rows }) => {
			if (this.client && this.attached) {
				void this.client.resize(cols, rows).catch(() => undefined);
			}
		});
		this.register(() => {
			onData.dispose();
			onBinary.dispose();
			onResize.dispose();
		});

		const ro = new ResizeObserver((entries) => {
			const rect = entries[entries.length - 1]?.contentRect;
			if (!rect) {
				return;
			}
			this.lastSize = { width: rect.width, height: rect.height };
			this.scheduleFit();
		});
		ro.observe(this.termEl);
		this.register(() => ro.disconnect());

		this.register(this.plugin.index.onChange(() => this.onIndexChange()));
		this.register(this.plugin.index.registry.onChange(() => this.updateIcon()));
		this.register(this.plugin.index.registry.onIdle((id) => this.onIdle(id)));
		this.register(this.plugin.index.registry.onBusy((id) => this.onBusyMark(id)));
		this.registerEvent(this.plugin.events.on("settings-changed", () => this.applySettings()));
		this.registerEvent(this.app.workspace.on("css-change", () => this.applyTheme()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onFrontChange()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.onFrontChange()));

		const linkProvider = this.terminal.registerLinkProvider(
			new VaultLinkProvider({
				app: this.app,
				terminal: this.terminal,
				cwd: () => this.cwd,
				vaultPath: this.plugin.vaultPath(),
			})
		);
		this.register(() => linkProvider.dispose());

		this.addAction("at-sign", t("action.insertNoteAt"), () => this.insertActiveNoteAt());
		this.jumpActions.prev = this.addAction("arrow-up", t("action.prevInstruction"), () => this.jumpPrev());
		this.jumpActions.next = this.addAction("arrow-down", t("action.nextInstruction"), () => this.jumpNext());
		this.jumpActions.last = this.addAction("corner-right-down", t("action.lastResponse"), () => this.jumpLast());

		this.applySettings();
	}

	async onClose(): Promise<void> {
		this.closed = true;
		this.cancelEditor();
		if (this.resizeTimer) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		this.disconnect();
		this.terminal.dispose();
		// Recompute without this view (disappears if no other view shares the same id).
		this.plugin.refreshTerminalStatus(this.id);
	}

	// ---- Settings and theme ---------------------------------------------------------

	/** Applies font, size (the per-tab value if set), padding, and scrollback, then `fit()`. */
	applySettings(): void {
		const s = this.plugin.settings;
		this.terminal.options.fontFamily = s.fontFamily;
		this.terminal.options.fontSize = this.fontSize ?? s.fontSize;
		this.terminal.options.scrollback = s.scrollback;
		// If the editor pane is open, bring its font in line with the current settings too.
		this.pendingEdit?.applySettings(s.fontFamily, this.fontSize ?? s.fontSize);
		if (this.bodyEl) {
			this.bodyEl.style.setProperty("--as-pad", `${PADDING_PX[s.padding] ?? PADDING_PX.comfortable}px`);
		}
		if (this.editorEl) {
			const pct = Math.min(EDITOR_HEIGHT_MAX, Math.max(EDITOR_HEIGHT_MIN, s.editorHeight));
			this.editorEl.style.setProperty("--as-editor-height", `${pct}%`);
		}
		this.applyTerminalMinHeight();
		this.applyTheme();
		this.applyJumpTooltips();
		this.updateHeader();
		if (this.exitReason) {
			// If the exit screen is showing when the language changes, redraw it.
			this.showExit(this.exitReason);
		}
		this.scheduleFit();
	}

	/** In fullscreen mode (Claude handles its own scrolling), the jump buttons' tooltips describe paging instead. */
	private applyJumpTooltips(): void {
		const full = this.plugin.isFullscreenTui();
		const labels = full
			? { prev: t("action.scrollUp"), next: t("action.scrollDown"), last: t("action.scrollBottom") }
			: { prev: t("action.prevInstruction"), next: t("action.nextInstruction"), last: t("action.lastResponse") };
		for (const key of ["prev", "next", "last"] as const) {
			this.jumpActions[key]?.setAttribute("aria-label", labels[key]);
		}
	}

	/** xterm's cell height (measured by the render service; estimated from fontSize if not yet measured). */
	private cellHeight(): number {
		const core = (this.terminal as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })._core;
		const measured = core?._renderService?.dimensions?.css?.cell?.height;
		if (measured && measured > 0) {
			return measured;
		}
		return Math.ceil((this.fontSize ?? this.plugin.settings.fontSize) * 1.3);
	}

	/** Keeps at least `TERMINAL_MIN_ROWS` rows for the terminal while the editor pane is open. */
	private applyTerminalMinHeight(): void {
		if (!this.termEl) {
			return;
		}
		if (this.pendingEdit) {
			this.termEl.style.minHeight = `${TERMINAL_MIN_ROWS * this.cellHeight()}px`;
		} else {
			this.termEl.style.removeProperty("min-height");
		}
	}

	private applyTheme(): void {
		if (!this.bodyEl) {
			return;
		}
		this.terminal.options.theme = readObsidianTheme(this.bodyEl);
	}

	private setFontSize(next: number): void {
		const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, next));
		this.fontSize = clamped === this.plugin.settings.fontSize ? undefined : clamped;
		this.applySettings();
		this.app.workspace.requestSaveLayout();
	}

	// ---- Sizing -----------------------------------------------------------------

	private scheduleFit(): void {
		if (this.resizeTimer) {
			clearTimeout(this.resizeTimer);
		}
		this.resizeTimer = setTimeout(() => {
			this.resizeTimer = null;
			this.fitNow();
		}, RESIZE_DEBOUNCE_MS);
	}

	private fitNow(): void {
		if (this.closed || this.lastSize.width <= 0 || this.lastSize.height <= 0) {
			return;
		}
		if (!this.opened) {
			this.openTerminal();
		}
		try {
			this.fit.fit();
		} catch (err) {
			console.warn("agent-sessions: fit", err);
		}
		this.maybeAttach();
	}

	/** Mounts xterm into the DOM only once the size is nonzero (opening it while hidden means character width can't be measured). */
	private openTerminal(): void {
		this.terminal.open(this.termEl);
		this.opened = true;
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			this.terminal.loadAddon(webgl);
		} catch (err) {
			console.log("agent-sessions: WebGL unavailable, falling back to canvas", err);
		}
		this.applyTheme();
	}

	// ---- Connecting -------------------------------------------------------------------

	private maybeAttach(): void {
		if (this.id && this.opened && this.lastSize.width > 0 && this.lastSize.height > 0) {
			void this.ensureAttached();
		}
	}

	/** Connects to the daemon: `attach` if `id` already exists there, otherwise `start` then `attach`. */
	async ensureAttached(): Promise<void> {
		if (this.closed || this.attaching || this.client || this.exitReason) {
			return;
		}
		this.attaching = true;
		this.updateIcon();
		try {
			const client = await ensureDaemon(this.plugin.sockPath(), this.plugin.agentSessionsPath());
			if (this.closed) {
				client.close();
				return;
			}
			this.bindClient(client);
			await client.hello("plugin");
			const list = await client.list();
			const sessions = (list.sessions as DaemonSession[] | undefined) ?? [];
			if (!sessions.some((s) => s.id === this.id)) {
				await this.startSession(client, this.fresh);
			}
			await this.attachTo(client);
		} catch (err) {
			this.disconnect();
			this.showExit(this.reasonOf(err));
		} finally {
			this.attaching = false;
			this.updateIcon();
		}
	}

	private reasonOf(err: unknown): ExitReason {
		if (err instanceof DaemonUnavailableError) {
			return { kind: "daemon-unavailable", message: err.message };
		}
		if (err instanceof BackendError) {
			return { kind: "claude-missing", message: err.message };
		}
		return { kind: "error", message: messageOf(err) };
	}

	private bindClient(client: DaemonClient): void {
		this.client = client;
		client.on("data", (buf: Buffer) => this.onOutput(buf));
		client.on("replay", (buf: Buffer) => {
			if (this.replayChunks) {
				this.replayChunks.push(buf);
			} else {
				this.onOutput(buf);
			}
		});
		client.on("replayed", () => this.onReplayed());
		client.on("exit", (id: string, code: number) => {
			if (id === this.id) {
				this.onExit(typeof code === "number" ? code : -1);
			}
		});
		client.on("error", (err: Error) => console.warn("agent-sessions: socket", err));
		client.on("close", () => {
			if (this.client === client) {
				this.client = null;
				this.attached = false;
				if (!this.exitReason && !this.closed) {
					this.showExit({ kind: "disconnected" });
				}
			}
		});
	}

	private async startSession(client: DaemonClient, fresh: boolean): Promise<void> {
		const claude = await resolveClaude(this.plugin.settings.claudePath, Platform.isMacOS);
		// `VISUAL` is for the built-in editor; `EDITOR` is left alone. `AGENT_SESSIONS_VAULT` is
		// here so claude's own hooks/statusLine (agent-sessions hook/status) don't lose track of
		// the vault — the daemon just passes `env` straight through to execvpe, so without this
		// it wouldn't work in an environment that has it in neither `env` nor vault.json.
		const env = {
			...(await loginEnv(Platform.isMacOS)),
			VISUAL: this.plugin.visualPath(),
			AGENT_SESSIONS_VAULT: this.plugin.vaultPath(),
		};
		const argv = fresh ? [claude, "--session-id", this.id] : [claude, "--resume", this.id];
		const cwd = this.cwd || this.plugin.vaultPath();
		const res = await client.start({
			id: this.id,
			agent: this.agent,
			cwd,
			argv,
			env,
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		});
		if (!res.ok && res.error !== "exists") {
			throw new Error(t("error.startFailed", { error: res.error ?? "unknown" }));
		}
		this.startedAt = Date.now();
		this.earlyOutput = "";
		if (fresh) {
			this.fresh = false;
			this.app.workspace.requestSaveLayout();
		}
	}

	private async attachTo(client: DaemonClient): Promise<void> {
		this.replayChunks = [];
		const res = await client.attach(this.id, this.terminal.cols, this.terminal.rows);
		if (!res.ok) {
			this.replayChunks = null;
			throw new Error(t("error.attachFailed", { error: res.error ?? "unknown" }));
		}
		this.attached = true;
		this.updateIcon();
	}

	private disconnect(): void {
		const client = this.client;
		this.client = null;
		this.attached = false;
		this.replayChunks = null;
		if (client) {
			client.removeAllListeners();
			client.on("error", () => undefined);
			void client.detach().catch(() => undefined);
			client.close();
		}
	}

	// ---- Input/output -----------------------------------------------------------------

	private sendInput(bytes: Buffer): void {
		if (!this.client || !this.attached) {
			return;
		}
		try {
			this.client.writeInput(bytes);
		} catch (err) {
			console.warn("agent-sessions: write", err);
		}
	}

	/**
	 * When the submit key is pressed: writes the submit sequence and records an instruction
	 * marker for jump. This is the only place an instruction marker gets recorded (not from `onData`).
	 */
	private sendSubmit(): void {
		this.sendInput(Buffer.from(submitSequence(this.plugin.settings), "binary"));
		this.marks.markInstruction();
	}

	/**
	 * Called after the built-in editor's "send", once the editor pane has closed: submits if
	 * so. `main.ts` calls this after waiting for Claude to read the file back.
	 */
	submitPrompt(): void {
		if (this.pendingEdit || this.closed) {
			return;
		}
		this.sendSubmit();
	}

	/** Keeps a copy of output right after `start` (used to detect `--resume` failing). */
	private noteEarly(buf: Buffer): void {
		if (this.startedAt && Date.now() - this.startedAt <= EARLY_EXIT_MS) {
			this.earlyOutput = (this.earlyOutput + buf.toString("utf8")).slice(-4096);
		}
	}

	private onOutput(buf: Buffer): void {
		this.noteEarly(buf);
		this.terminal.write(buf);
	}

	/** Replay (`R`) is written as one batch, then `scrollToBottom()` once it's done. */
	private onReplayed(): void {
		const chunks = this.replayChunks;
		this.replayChunks = null;
		if (chunks && chunks.length > 0) {
			const all = Buffer.concat(chunks);
			this.noteEarly(all);
			this.terminal.write(all, () => this.terminal.scrollToBottom());
		} else {
			this.terminal.scrollToBottom();
		}
	}

	private onExit(code: number): void {
		this.attached = false;
		const early = this.startedAt > 0 && Date.now() - this.startedAt <= EARLY_EXIT_MS;
		this.startedAt = 0;
		if (early && code === 127) {
			this.showExit({ kind: "claude-missing", message: t("error.claudeMissing") });
			return;
		}
		const resumeFailed =
			early && RESUME_FAILURE_PATTERNS.some((p) => this.earlyOutput.includes(p));
		this.showExit({ kind: "exited", code, resumeFailed });
	}

	// ---- Editor pane -----------------------------------------------------

	/**
	 * An `agent-sessions edit` request: splits the body and opens the editor pane below it,
	 * resolving via send / back to prompt / cancel. Returns `busy` if a second request comes in while one is open.
	 */
	async openEditor(file: string, cwd: string): Promise<EditResult | "busy"> {
		if (this.pendingEdit || this.closed) {
			return this.closed ? "cancel" : "busy";
		}
		const initial = fs.readFileSync(file, "utf8");
		const s = this.plugin.settings;
		const pane = new EditorPane(this.editorEl, {
			app: this.app,
			vaultPath: this.plugin.vaultPath(),
			fontFamily: s.fontFamily,
			fontSize: this.fontSize ?? s.fontSize,
			submitKey: s.submitKey,
			isMac: Platform.isMacOS,
		});
		this.pendingEdit = pane;
		this.applyTerminalMinHeight();
		this.editorEl.show();
		this.scheduleFit();
		this.updateIcon();
		try {
			return await pane.open(file, cwd, initial);
		} finally {
			if (this.pendingEdit === pane) {
				this.pendingEdit = null;
			}
			this.updateIcon();
			this.applyTerminalMinHeight();
			this.editorEl.hide();
			if (!this.closed) {
				this.scheduleFit();
				this.terminal.focus();
			}
		}
	}

	/** claude's side disconnected: closes the editor pane and resolves `pendingEdit` with `cancel` (no reply is sent). */
	abortEditor(): void {
		this.pendingEdit?.abort();
	}

	/** The tab side is closing: writes the original content back and resolves with `cancel` (the reply is sent by `main.ts`). */
	cancelEditor(): void {
		this.pendingEdit?.cancel();
	}

	// ---- Links, `@`, jump --------------------------------------------

	/** The base for `@`'s relative path and `start`'s cwd. Falls back to the vault if state's `cwd` is empty. */
	getCwd(): string {
		return this.cwd || this.plugin.vaultPath();
	}

	/** Moves input focus to this terminal, from the header's `@` or a `main.ts` command. */
	focusTerminal(): void {
		this.terminal.focus();
	}

	/**
	 * Writes the last-frontmost note to this terminal as `@path[#Lx-y] ` and moves focus to it.
	 * `workspace.activeEditor` is null while the terminal has focus, so this uses the Markdown
	 * view `main.ts` remembers instead.
	 */
	private insertActiveNoteAt(): void {
		const md = this.plugin.lastMarkdownView();
		if (!md || !md.file) {
			new Notice(t("notice.noActiveNote"));
			return;
		}
		const abs = join(this.plugin.vaultPath(), md.file.path);
		const range = selectionLineRange(md.editor);
		const token = buildAtToken(abs, this.getCwd(), range);
		this.sendCommand(`@${token} `);
		this.focusTerminal();
	}

	/** Response marker: placed at the cursor row when `registry` reports `busy` (including the first time it's observed). */
	private onBusyMark(id: string): void {
		if (id === this.id) {
			this.marks.onBusy();
		}
	}

	/**
	 * The topmost visible row (an absolute row within the buffer). `marks.prev/next` return the
	 * nearest instruction marker above/below this. A marker's `line` is also an absolute row, so
	 * it can be passed straight to `scrollToLine`.
	 */
	private viewportY(): number {
		return this.terminal.buffer.active.viewportY;
	}

	/** Scrolls so `line` (an absolute row) is at the top. Does nothing if `line` is `null` (no match). */
	private jumpTo(line: number | null): void {
		if (line === null) {
			return;
		}
		this.terminal.scrollToLine(line);
		this.focusTerminal();
	}

	// In fullscreen mode (`tui: "fullscreen"`), Claude redraws the whole screen and owns
	// scrolling itself, so nothing accumulates in xterm's scrollback (`buffer.length === rows`).
	// The marker approach doesn't work there, so these send Claude's `Scroll` context keys
	// (PageUp/PageDown/End) instead.

	private jumpPrev(): void {
		if (this.plugin.isFullscreenTui()) {
			this.sendInput(Buffer.from("\x1b[5~", "binary"));
			this.focusTerminal();
			return;
		}
		this.jumpTo(this.marks.prev(this.viewportY()));
	}

	private jumpNext(): void {
		if (this.plugin.isFullscreenTui()) {
			this.sendInput(Buffer.from("\x1b[6~", "binary"));
			this.focusTerminal();
			return;
		}
		this.jumpTo(this.marks.next(this.viewportY()));
	}

	private jumpLast(): void {
		if (this.plugin.isFullscreenTui()) {
			this.sendInput(Buffer.from("\x1b[F", "binary"));
			this.focusTerminal();
			return;
		}
		this.jumpTo(this.marks.lastResponse());
	}

	// ---- ⋯ menu ---------------------------------------------------------

	/**
	 * Adds a separator and the session actions after Obsidian's standard items (including split
	 * right/down). "Compact session" is disabled based on `index.getCachedDetail`'s
	 * `last_command` (synchronous — stays enabled if not yet fetched, and `compactSession` itself checks again).
	 */
	onPaneMenu(menu: Menu, source: "more-options" | "tab-header" | string): void {
		super.onPaneMenu(menu, source);
		const id = this.id;
		const lastCommand = this.plugin.index.getCachedDetail(id)?.last_command ?? null;
		// If not yet fetched, kick off a fetch for next time this opens.
		void this.plugin.index.getDetail(id).catch(() => undefined);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(t("action.rename"))
				.setIcon("pencil")
				.onClick(() => {
					new RenameSessionModal(this.plugin, this.getDisplayText(), (name) => void this.plugin.renameSession(id, name)).open();
				})
		);
		menu.addItem((item) =>
			item
				.setTitle(t("action.compact"))
				.setIcon("fold-vertical")
				.setDisabled(lastCommand === "/compact")
				.onClick(() => void this.plugin.compactSession(id))
		);
		menu.addItem((item) =>
			item
				.setTitle(t("action.showUsage"))
				.setIcon("bar-chart-2")
				.onClick(() => this.plugin.showUsage(id))
		);
		menu.addItem((item) =>
			item
				.setTitle(t("action.copyId"))
				.setIcon("copy")
				.onClick(() => {
					void navigator.clipboard.writeText(id).then(() => new Notice(t("notice.idCopied")));
				})
		);
	}

	// ---- Keys -------------------------------------------------------------------

	private handleKey(ev: KeyboardEvent): boolean {
		// While the editor pane is open, nothing is passed to xterm (including IME input).
		if (this.pendingEdit) {
			return false;
		}
		if (ev.key === "Escape") {
			ev.stopPropagation();
			if (ev.type === "keyup") {
				ev.preventDefault();
				return false;
			}
			return true;
		}
		// Intercept every Enter combination and send the submit or newline sequence ourselves.
		const submitKey = this.plugin.settings.submitKey;
		const enterAction = resolveEnterAction(classifyEnter(ev), submitKey);
		if (enterAction !== "passthrough") {
			ev.preventDefault();
			ev.stopPropagation();
			if (ev.type === "keydown") {
				if (enterAction === "submit") {
					this.sendSubmit();
				} else {
					this.sendInput(Buffer.from(sendSequence("newline", submitKey), "binary"));
				}
			}
			return false;
		}
		if (ev.metaKey && !ev.ctrlKey && !ev.altKey) {
			if (ev.key === "+" || ev.key === "=" || ev.key === "-" || ev.key === "0") {
				ev.preventDefault();
				ev.stopPropagation();
				if (ev.type === "keydown") {
					this.zoomFont(ev.key === "0" ? "reset" : ev.key === "-" ? "out" : "in");
				}
				return false;
			}
			return true;
		}
		// Non-macOS: Obsidian's modifier key is Ctrl. claude also uses combinations like
		// Ctrl+C/D/G/R/O/S/L/T, so plain Ctrl combinations go to the terminal by default (same
		// as the final fallback below), and only a few combinations are routed to Obsidian,
		// copy/paste, or font size (`classifyCtrlKeyNonMac`).
		if (!Platform.isMacOS) {
			const role = classifyCtrlKeyNonMac(ev);
			if (role === "obsidian") {
				// Not passed to xterm (`false`), but propagation isn't stopped — no
				// preventDefault either, so it goes straight to Obsidian's hotkeys (same idea as
				// Cmd-held keys on macOS).
				return false;
			}
			if (role !== "passthrough" && role !== "terminal") {
				ev.preventDefault();
				ev.stopPropagation();
				if (ev.type === "keydown") {
					switch (role) {
						case "copy":
							void this.copySelection();
							break;
						case "paste":
							void this.pasteFromClipboard();
							break;
						case "zoom-in":
							this.zoomFont("in");
							break;
						case "zoom-out":
							this.zoomFont("out");
							break;
						case "zoom-reset":
							this.zoomFont("reset");
							break;
						case "close-tab":
							this.runObsidianCommand("workspace:close");
							break;
						case "command-palette":
							this.runObsidianCommand("command-palette:open");
							break;
					}
				}
				return false;
			}
		}
		if (ev.type === "keydown") {
			ev.stopPropagation();
		}
		return true;
	}

	/**
	 * Non-macOS Ctrl+Shift+W/Ctrl+Shift+P (close tab / command palette). Obsidian's default
	 * hotkeys for these are bound to plain Ctrl+W/Ctrl+P (which we don't forward there, since
	 * they'd collide with claude's input line), so merely passing the key event through doesn't
	 * trigger them — this calls `app.commands` directly (the Commands API, an internal API not
	 * in `obsidian`'s public types).
	 */
	private runObsidianCommand(id: string): void {
		const commands = (this.app as unknown as { commands?: { executeCommandById(id: string): boolean } }).commands;
		commands?.executeCommandById(id);
	}

	/** Zooms the font in/out or resets it (Cmd +/-/0, or on non-macOS Ctrl+Shift+=/-/0). */
	private zoomFont(direction: "in" | "out" | "reset"): void {
		if (direction === "reset") {
			this.setFontSize(this.plugin.settings.fontSize);
			return;
		}
		const current = this.fontSize ?? this.plugin.settings.fontSize;
		this.setFontSize(current + (direction === "in" ? 1 : -1));
	}

	/**
	 * Ctrl+Shift+C (non-macOS): copies the selection to the clipboard, if there is one. macOS's
	 * Cmd+C is left to the native `copy` event (which xterm itself handles), so this code path
	 * doesn't run there.
	 */
	private async copySelection(): Promise<void> {
		const text = this.terminal.getSelection();
		if (!text) {
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
		} catch (err) {
			console.warn("agent-sessions: couldn't copy to the clipboard", err);
		}
	}

	/**
	 * Ctrl+Shift+V (non-macOS): sends the clipboard's text to the PTY. If claude has enabled
	 * bracketed paste (`terminal.modes.bracketedPasteMode`), wraps it the same way (same reason
	 * as the bracketed paste used for command sending: avoid accidentally opening `/` completion).
	 */
	private async pasteFromClipboard(): Promise<void> {
		let text: string;
		try {
			text = await navigator.clipboard.readText();
		} catch (err) {
			console.warn("agent-sessions: couldn't read the clipboard", err);
			return;
		}
		if (!text) {
			return;
		}
		const wrapped = this.terminal.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
		this.sendInput(Buffer.from(wrapped, "utf8"));
	}

	// ---- Exit screen ---------------------------------------------------------------

	private showExit(reason: ExitReason): void {
		if (this.closed) {
			return;
		}
		this.exitReason = reason;
		this.updateIcon();
		const el = this.exitEl;
		el.empty();
		const msg = el.createDiv({ cls: "agent-sessions-exit-message" });
		const buttons = el.createDiv({ cls: "agent-sessions-exit-buttons" });
		const button = (label: string, cls: string | undefined, onClick: () => void) => {
			const b = buttons.createEl("button", { text: label, cls });
			this.registerDomEvent(b, "click", () => onClick());
		};

		switch (reason.kind) {
			case "exited":
				msg.setText(t("exit.exited", { code: reason.code }));
				button(t("action.resume"), "mod-cta", () => void this.restart(false));
				if (reason.resumeFailed) {
					button(t("action.startFresh"), undefined, () => void this.restart(true));
				}
				button(t("action.close"), undefined, () => void this.closeTab(true));
				break;
			case "claude-missing": {
				msg.setText(reason.message);
				const link = msg.createEl("a", { text: t("action.openSettings"), cls: "agent-sessions-exit-link" });
				this.registerDomEvent(link, "click", (e) => {
					e.preventDefault();
					this.plugin.openSettings();
				});
				button(t("action.retry"), "mod-cta", () => void this.retry());
				button(t("action.close"), undefined, () => void this.closeTab(false));
				break;
			}
			case "daemon-unavailable":
				msg.setText(reason.message);
				button(t("action.retry"), "mod-cta", () => void this.retry());
				button(t("action.close"), undefined, () => void this.closeTab(false));
				break;
			case "disconnected":
				msg.setText(t("exit.disconnected"));
				button(t("action.reconnect"), "mod-cta", () => void this.retry());
				button(t("action.close"), undefined, () => void this.closeTab(false));
				break;
			case "error":
				msg.setText(reason.message);
				button(t("action.retry"), "mod-cta", () => void this.retry());
				button(t("action.close"), undefined, () => void this.closeTab(false));
				break;
		}
		el.show();
	}

	private hideExit(): void {
		this.exitReason = null;
		this.exitEl.empty();
		this.exitEl.hide();
	}

	/** Reconnects (attach if the daemon already has `id`, otherwise start). */
	private async retry(): Promise<void> {
		this.hideExit();
		await this.ensureAttached();
	}

	/** Restart: `forget` → `start` (`--resume`, or `--session-id` if `fresh`) → `attach`. */
	private async restart(fresh: boolean): Promise<void> {
		this.hideExit();
		this.attaching = true;
		this.updateIcon();
		try {
			const client = this.client ?? (await this.openClient());
			await client.forget(this.id).catch(() => undefined);
			this.terminal.reset();
			await this.startSession(client, fresh);
			await this.attachTo(client);
		} catch (err) {
			this.disconnect();
			this.showExit(this.reasonOf(err));
		} finally {
			this.attaching = false;
			this.updateIcon();
		}
	}

	private async openClient(): Promise<DaemonClient> {
		const client = await ensureDaemon(this.plugin.sockPath(), this.plugin.agentSessionsPath());
		this.bindClient(client);
		await client.hello("plugin");
		return client;
	}

	/** Closes: sends `forget` first if the session has already exited, then closes the tab. */
	private async closeTab(forget: boolean): Promise<void> {
		if (forget && this.client) {
			await this.client.forget(this.id).catch(() => undefined);
		}
		this.leaf.detach();
	}

	// ---- Title and icon -----------------------------------------------------------

	private onIndexChange(): void {
		this.refreshName();
		this.updateIcon();
	}

	private refreshName(): void {
		const row = this.plugin.index.sessions.get(this.id);
		const next = row?.name || "";
		if (next !== this.displayName) {
			this.displayName = next;
			this.updateHeader();
		}
	}

	private onIdle(id: string): void {
		if (id !== this.id) {
			return;
		}
		if (!this.isFront()) {
			this.waiting = true;
		}
		this.updateIcon();
	}

	private onFrontChange(): void {
		if (this.waiting && this.isFront()) {
			this.waiting = false;
			this.updateIcon();
		}
	}

	private isFront(): boolean {
		return this.containerEl.isShown() && this.app.workspace.getActiveViewOfType(TerminalView) === this;
	}

	private isExited(): boolean {
		if (this.exitReason?.kind === "exited") {
			return true;
		}
		const row = this.plugin.index.sessions.get(this.id);
		return row?.exited != null;
	}

	/** Daemon unreachable, claude missing, or a start failure (`exited` is handled separately). */
	private isErrorState(): boolean {
		return !!this.exitReason && this.exitReason.kind !== "exited";
	}

	/**
	 * The current status (`terminalStatus`). Used by `updateIcon()`, and by `main.ts`'s
	 * `refreshTerminalStatus()` (via `currentStatus()`) when combining it with row markers.
	 */
	private computeStatus(): TerminalStatus {
		return terminalStatus({
			error: this.isErrorState(),
			exited: this.isExited(),
			editing: !!this.pendingEdit,
			connecting: this.attaching,
			registryStatus: this.plugin.index.registry.get(this.id)?.status as
				| "busy"
				| "shell"
				| "waiting"
				| "idle"
				| null
				| undefined,
			waiting: this.waiting,
			compacted: this.plugin.index.compactedTracker.has(this.id),
			attached: this.attached,
		});
	}

	/** The current status (public version, read by `main.ts`'s `refreshTerminalStatus()`). */
	currentStatus(): TerminalStatus {
		return this.computeStatus();
	}

	/** Whether this view is still open (used by `main.ts`'s `refreshTerminalStatus()` when combining several views). */
	isOpen(): boolean {
		return !this.closed;
	}

	/** The tab header's icon (`terminalStatus`). Icon, color, and motion classes vary by state. */
	private updateIcon(): void {
		if (this.closed) {
			return;
		}
		const status = this.computeStatus();
		this.plugin.refreshTerminalStatus(this.id);
		const icon = TERMINAL_STATUS_ICON[status];
		if (icon !== this.icon) {
			this.icon = icon;
			this.updateHeader();
		}
		const iconEl = this.headerIconEl();
		if (!iconEl) {
			return;
		}
		for (const s of ALL_TERMINAL_STATUSES) {
			iconEl.toggleClass(terminalStatusClass(s), s === status);
		}
		setTooltip(iconEl, t(STATUS_LABEL_KEY[status]));
	}

	private headerIconEl(): HTMLElement | null {
		const headerEl = (this.leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
		return headerEl?.querySelector<HTMLElement>(".workspace-tab-header-inner-icon") ?? null;
	}

	/**
	 * Redraws the title and icon on both the tab header and the view's own header
	 * (`.view-header-title`). `updateHeader` isn't in the public types, and it doesn't touch the
	 * view's own header, so that's updated separately below.
	 */
	private updateHeader(): void {
		const leaf = this.leaf as unknown as { updateHeader?: () => void };
		if (typeof leaf.updateHeader === "function") {
			leaf.updateHeader();
		} else {
			const iconEl = this.headerIconEl();
			if (iconEl) {
				setIcon(iconEl, this.getIcon());
			}
		}
		const titleEl = this.containerEl.querySelector<HTMLElement>(".view-header-title");
		if (titleEl) {
			titleEl.setText(this.getDisplayText());
		}
	}
}

// ターミナル（§6.3）・1 セッション＝1 タブ（§6.4）・アイコンの状態（§6.5）・
// エラー処理（§7）。xterm 5.x を `DaemonClient` に繋ぐ。

import { ItemView, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { BackendError, loginEnv, resolveClaude } from "../backend";
import { DaemonClient, DaemonUnavailableError, ensureDaemon } from "../daemon-client";
import type AgentSessionsPlugin from "../main";
import { VIEW_TYPE_TERMINAL } from "../open-session";
import type { Padding } from "../settings";
import { readObsidianTheme } from "../theme";
import type { DaemonSession } from "../types";

export { VIEW_TYPE_TERMINAL };

export interface TerminalState {
	id: string;
	agent: string;
	cwd: string;
	fontSize?: number;
	/** 新規セッション。最初の `start` が済むまで残り、`--session-id` で起動する。 */
	fresh?: boolean;
}

const PADDING_PX: Record<Padding, number> = { comfortable: 12, compact: 4, none: 0 };
const RESIZE_DEBOUNCE_MS = 50;
/** `start` からこの時間内の `exit` は起動の失敗とみなす（§7）。 */
const EARLY_EXIT_MS = 3000;
const RESUME_FAILURE_PATTERNS = ["No conversation found", "not found"];
const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 40;

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
	private exitEl!: HTMLElement;
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
	}

	getViewType(): string {
		return VIEW_TYPE_TERMINAL;
	}

	getDisplayText(): string {
		return this.displayName || `無題 ${this.id.slice(0, 8)}`;
	}

	getIcon(): string {
		return this.icon || "bot";
	}

	getState(): Record<string, unknown> {
		const state: Record<string, unknown> = { id: this.id, agent: this.agent, cwd: this.cwd };
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
		this.applySettings();
		this.app.workspace.onLayoutReady(() => {
			if (this.closed || this.dedupe()) {
				return;
			}
			this.maybeAttach();
		});
	}

	/** 同じ `id` の別 leaf があれば自分を畳んで相手を前面に出す（§6.4）。畳んだら true。 */
	private dedupe(): boolean {
		if (!this.id) {
			return false;
		}
		const other = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_TERMINAL)
			.find((leaf) => leaf !== this.leaf && leaf.getViewState().state?.id === this.id);
		if (!other) {
			return false;
		}
		this.leaf.detach();
		void this.app.workspace.revealLeaf(other);
		return true;
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("agent-sessions-terminal");
		this.bodyEl = this.contentEl.createDiv({ cls: "agent-sessions-terminal-body" });
		this.exitEl = this.contentEl.createDiv({ cls: "agent-sessions-exit" });
		this.exitEl.hide();

		this.terminal.loadAddon(this.fit);
		this.terminal.loadAddon(new Unicode11Addon());
		this.terminal.unicode.activeVersion = "11";
		this.terminal.attachCustomKeyEventHandler((ev) => this.handleKey(ev));
		const onData = this.terminal.onData((data) => this.sendInput(Buffer.from(data, "utf8")));
		const onBinary = this.terminal.onBinary((data) => this.sendInput(Buffer.from(data, "binary")));
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
		ro.observe(this.bodyEl);
		this.register(() => ro.disconnect());

		this.register(this.plugin.index.onChange(() => this.onIndexChange()));
		this.register(this.plugin.index.registry.onChange(() => this.updateIcon()));
		this.register(this.plugin.index.registry.onIdle((id) => this.onIdle(id)));
		this.registerEvent(this.plugin.events.on("settings-changed", () => this.applySettings()));
		this.registerEvent(this.app.workspace.on("css-change", () => this.applyTheme()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onFrontChange()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.onFrontChange()));

		this.applySettings();
	}

	async onClose(): Promise<void> {
		this.closed = true;
		if (this.resizeTimer) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		this.disconnect();
		this.terminal.dispose();
	}

	// ---- 設定・テーマ ---------------------------------------------------------

	/** フォント・サイズ（タブ毎の値があればそれ）・余白・スクロールバックを当てて `fit()`。 */
	applySettings(): void {
		const s = this.plugin.settings;
		this.terminal.options.fontFamily = s.fontFamily;
		this.terminal.options.fontSize = this.fontSize ?? s.fontSize;
		this.terminal.options.scrollback = s.scrollback;
		if (this.bodyEl) {
			this.bodyEl.style.setProperty("--as-pad", `${PADDING_PX[s.padding] ?? PADDING_PX.comfortable}px`);
		}
		this.applyTheme();
		this.scheduleFit();
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

	// ---- サイズ -----------------------------------------------------------------

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

	/** 大きさが 0 でなくなってから xterm を DOM に載せる（隠れたまま開くと文字幅が測れない）。 */
	private openTerminal(): void {
		this.terminal.open(this.bodyEl);
		this.opened = true;
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			this.terminal.loadAddon(webgl);
		} catch (err) {
			console.log("agent-sessions: WebGL が使えないため canvas で描く", err);
		}
		this.applyTheme();
	}

	// ---- 接続 -------------------------------------------------------------------

	private maybeAttach(): void {
		if (this.id && this.opened && this.lastSize.width > 0 && this.lastSize.height > 0) {
			void this.ensureAttached();
		}
	}

	/** デーモンに繋ぎ、`id` があれば `attach`、無ければ `start` → `attach`（§6.3）。 */
	async ensureAttached(): Promise<void> {
		if (this.closed || this.attaching || this.client || this.exitReason) {
			return;
		}
		this.attaching = true;
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
		const claude = await resolveClaude(this.plugin.settings.claudePath);
		const env = await loginEnv();
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
			throw new Error(`start に失敗: ${res.error ?? "unknown"}`);
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
			throw new Error(`attach に失敗: ${res.error ?? "unknown"}`);
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

	// ---- 入出力 -----------------------------------------------------------------

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

	/** `start` 直後の出力を控える（`--resume` の失敗判定に使う。§7）。 */
	private noteEarly(buf: Buffer): void {
		if (this.startedAt && Date.now() - this.startedAt <= EARLY_EXIT_MS) {
			this.earlyOutput = (this.earlyOutput + buf.toString("utf8")).slice(-4096);
		}
	}

	private onOutput(buf: Buffer): void {
		this.noteEarly(buf);
		this.terminal.write(buf);
	}

	/** 再生（`R`）はまとめて 1 回で書き、書き終わってから `scrollToBottom()`。 */
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
			this.showExit({ kind: "claude-missing", message: "claude が見つからない" });
			return;
		}
		const resumeFailed =
			early && RESUME_FAILURE_PATTERNS.some((p) => this.earlyOutput.includes(p));
		this.showExit({ kind: "exited", code, resumeFailed });
	}

	// ---- キー -------------------------------------------------------------------

	private handleKey(ev: KeyboardEvent): boolean {
		if (ev.key === "Escape") {
			ev.stopPropagation();
			if (ev.type === "keyup") {
				ev.preventDefault();
				return false;
			}
			return true;
		}
		if (ev.key === "Enter" && (ev.shiftKey || ev.altKey || ev.metaKey)) {
			ev.preventDefault();
			ev.stopPropagation();
			if (ev.type === "keydown") {
				this.sendInput(Buffer.from("\x1b\r", "binary"));
			}
			return false;
		}
		if (ev.metaKey && !ev.ctrlKey && !ev.altKey) {
			if (ev.key === "+" || ev.key === "=" || ev.key === "-" || ev.key === "0") {
				ev.preventDefault();
				ev.stopPropagation();
				if (ev.type === "keydown") {
					const current = this.fontSize ?? this.plugin.settings.fontSize;
					if (ev.key === "0") {
						this.setFontSize(this.plugin.settings.fontSize);
					} else {
						this.setFontSize(current + (ev.key === "-" ? -1 : 1));
					}
				}
				return false;
			}
			return true;
		}
		if (ev.type === "keydown") {
			ev.stopPropagation();
		}
		return true;
	}

	// ---- 終了画面 ---------------------------------------------------------------

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
				msg.setText(`セッションは終了しました（${reason.code}）`);
				button("再開", "mod-cta", () => void this.restart(false));
				if (reason.resumeFailed) {
					button("新規として開始", undefined, () => void this.restart(true));
				}
				button("閉じる", undefined, () => void this.closeTab(true));
				break;
			case "claude-missing": {
				msg.setText(reason.message);
				const link = msg.createEl("a", { text: "設定を開く", cls: "agent-sessions-exit-link" });
				this.registerDomEvent(link, "click", (e) => {
					e.preventDefault();
					this.plugin.openSettings();
				});
				button("再試行", "mod-cta", () => void this.retry());
				button("閉じる", undefined, () => void this.closeTab(false));
				break;
			}
			case "daemon-unavailable":
				msg.setText(reason.message);
				button("再試行", "mod-cta", () => void this.retry());
				button("閉じる", undefined, () => void this.closeTab(false));
				break;
			case "disconnected":
				msg.setText("デーモンとの接続が切れました");
				button("再接続", "mod-cta", () => void this.retry());
				button("閉じる", undefined, () => void this.closeTab(false));
				break;
			case "error":
				msg.setText(reason.message);
				button("再試行", "mod-cta", () => void this.retry());
				button("閉じる", undefined, () => void this.closeTab(false));
				break;
		}
		el.show();
	}

	private hideExit(): void {
		this.exitReason = null;
		this.exitEl.empty();
		this.exitEl.hide();
	}

	/** 繋ぎ直す（デーモンに `id` があれば attach、無ければ start）。 */
	private async retry(): Promise<void> {
		this.hideExit();
		await this.ensureAttached();
	}

	/** 再開：`forget` → `start`（`--resume`、`fresh` なら `--session-id`）→ `attach`。 */
	private async restart(fresh: boolean): Promise<void> {
		this.hideExit();
		this.attaching = true;
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
		}
	}

	private async openClient(): Promise<DaemonClient> {
		const client = await ensureDaemon(this.plugin.sockPath(), this.plugin.agentSessionsPath());
		this.bindClient(client);
		await client.hello("plugin");
		return client;
	}

	/** 閉じる：終了済みなら `forget` してからタブを畳む。 */
	private async closeTab(forget: boolean): Promise<void> {
		if (forget && this.client) {
			await this.client.forget(this.id).catch(() => undefined);
		}
		this.leaf.detach();
	}

	// ---- 題名とアイコン -----------------------------------------------------------

	private onIndexChange(): void {
		this.refreshName();
		this.updateIcon();
	}

	private refreshName(): void {
		const row = this.plugin.index.sessions.get(this.id);
		const next = row?.name || row?.pendingRename || "";
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

	private isBusy(): boolean {
		const status = this.plugin.index.registry.get(this.id)?.status;
		return status === "busy" || status === "shell";
	}

	/** `bot`／busy アニメ／`message-circle`／`circle-off`（§6.3）。 */
	private updateIcon(): void {
		if (this.closed) {
			return;
		}
		let icon = "bot";
		let busy = false;
		let waiting = false;
		if (this.isExited()) {
			icon = "circle-off";
		} else if (this.isBusy()) {
			busy = true;
		} else if (this.waiting) {
			icon = "message-circle";
			waiting = true;
		}
		if (icon !== this.icon) {
			this.icon = icon;
			this.updateHeader();
		}
		const iconEl = this.headerIconEl();
		if (!iconEl) {
			return;
		}
		iconEl.toggleClass("agent-sessions-busy", busy);
		iconEl.toggleClass("agent-sessions-waiting", waiting);
	}

	private headerIconEl(): HTMLElement | null {
		const headerEl = (this.leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
		return headerEl?.querySelector<HTMLElement>(".workspace-tab-header-inner-icon") ?? null;
	}

	/**
	 * タブ見出しとビュー上部の見出し（`.view-header-title`）の題名・アイコンを描き直す。
	 * `updateHeader` は公開型に無い。ビュー上部の見出しは `updateHeader` が触らない。
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

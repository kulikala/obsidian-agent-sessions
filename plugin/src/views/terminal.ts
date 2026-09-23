// ターミナル（§6.3）・1 セッション＝1 タブ（§6.4）・アイコンの状態（§6.5）・
// エラー処理（§7）。xterm 5.x を `DaemonClient` に繋ぐ。

import { ItemView, Notice, setIcon, setTooltip, type Menu, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import * as fs from "node:fs";
import { join } from "node:path";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { BackendError, loginEnv, resolveClaude } from "../backend";
import { DaemonClient, DaemonUnavailableError, ensureDaemon } from "../daemon-client";
import { t } from "../i18n";
import { classifyEnter, resolveEnterAction, sendSequence } from "../keys";
import { buildAtToken, selectionLineRange, VaultLinkProvider } from "../links";
import { submitSequence } from "../main";
import type AgentSessionsPlugin from "../main";
import { MarkTracker, type MarkerHandle, type MarkerSource } from "../marks";
import { RenameSessionModal } from "../modals";
import { sessionDisplayName } from "../name";
import { VIEW_TYPE_TERMINAL } from "../open-session";
import type { Padding } from "../settings";
import {
	ALL_TERMINAL_STATUSES,
	STATUS_LABEL_KEY,
	TERMINAL_STATUS_ICON,
	terminalStatus,
	terminalStatusClass,
	type TerminalStatus,
} from "../terminal-status";
import { readObsidianTheme } from "../theme";
import type { DaemonSession } from "../types";
import { EditorPane, type EditResult } from "./editor-pane";

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
/** 編集領域の高さ（%）の下限・上限。上限として効き、ターミナルの最小行数が優先する。 */
const EDITOR_HEIGHT_MIN = 10;
const EDITOR_HEIGHT_MAX = 90;
/** 編集領域を開いている間にターミナルへ残す最小行数。 */
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
	/** xterm を載せる要素。編集領域が開くと縮む。 */
	private termEl!: HTMLElement;
	/** 編集領域（D-22）。閉じている間は隠す。 */
	private editorEl!: HTMLElement;
	private exitEl!: HTMLElement;
	/** 進行中の編集。閉じる経路すべてがこれを解決する（D-21）。 */
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

	/** ジャンプ（§6.7）：指示・応答の先頭を覚える。xterm のマーカーは `markerSource()` で包む。 */
	private marks: MarkTracker;
	/** ヘッダのジャンプ 3 つ。fullscreen のときは tooltip を差し替える（D-42）。 */
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

	/** xterm の `registerMarker` を `MarkerSource` に包む（`marks.ts` は xterm に依存しない）。 */
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

	/** サイドパネル・マネージャーが名前変更や圧縮の対象を探すのに使う。 */
	get sessionId(): string {
		return this.id;
	}

	/** `@` 挿入から、そのまま PTY へ書く。 */
	sendCommand(text: string): void {
		this.sendInput(Buffer.from(text, "utf8"));
	}

	/** `main.ts` の `sendCommand`（D-42）から、組み立て済みのバイト列を PTY へ書く。 */
	sendBytes(bytes: Buffer): void {
		this.sendInput(bytes);
	}

	/** デーモンに attach 済みか（`main.ts` の `sendCommand` が経路①を選ぶ条件）。 */
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
		// 同じ `id` の別 leaf があっても自分を畳まない（D-42）：右／下に分割・タブの複製で
		// 複数のビューが同じセッションに attach する。`openSession` は既存タブへ移動するので
		// 重複は分割からしか生まれない。
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
		// 編集領域（D-21）を開いている間は、IME の確定文字やペーストも PTY へ流さない。
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
		// このビュー分を除いて合成し直す（同じ id の他のビューが無ければ消える。D-66 追補）。
		this.plugin.refreshTerminalStatus(this.id);
	}

	// ---- 設定・テーマ ---------------------------------------------------------

	/** フォント・サイズ（タブ毎の値があればそれ）・余白・スクロールバックを当てて `fit()`。 */
	applySettings(): void {
		const s = this.plugin.settings;
		this.terminal.options.fontFamily = s.fontFamily;
		this.terminal.options.fontSize = this.fontSize ?? s.fontSize;
		this.terminal.options.scrollback = s.scrollback;
		// 編集領域（D-22）が開いていれば、そのフォントも今の設定に合わせる（T-75）。
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
			// 言語が変わったとき、終了画面が出ていれば描き直す（§6.9・D-56）。
			this.showExit(this.exitReason);
		}
		this.scheduleFit();
	}

	/** fullscreen（Claude が自分でスクロールを持つ）なら、ジャンプの説明を画面送りの言葉にする。 */
	private applyJumpTooltips(): void {
		const full = this.plugin.isFullscreenTui();
		const labels = full
			? { prev: t("action.scrollUp"), next: t("action.scrollDown"), last: t("action.scrollBottom") }
			: { prev: t("action.prevInstruction"), next: t("action.nextInstruction"), last: t("action.lastResponse") };
		for (const key of ["prev", "next", "last"] as const) {
			this.jumpActions[key]?.setAttribute("aria-label", labels[key]);
		}
	}

	/** xterm のセル高さ（描画サービスの実測。未測なら fontSize から概算）。 */
	private cellHeight(): number {
		const core = (this.terminal as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })._core;
		const measured = core?._renderService?.dimensions?.css?.cell?.height;
		if (measured && measured > 0) {
			return measured;
		}
		return Math.ceil((this.fontSize ?? this.plugin.settings.fontSize) * 1.3);
	}

	/** 編集領域を開いている間、ターミナルに最小 8 行を確保する。 */
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
		this.terminal.open(this.termEl);
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
		const claude = await resolveClaude(this.plugin.settings.claudePath);
		// `VISUAL` は内蔵エディタ（D-20）。`EDITOR` は触らない。`AGENT_SESSIONS_VAULT`
		// は claude 自身のフック・statusLine（agent-sessions hook/status）が vault を
		// 見失わないように（T-80。デーモンは env をそのまま execvpe に渡すだけなので、
		// ここで入れておかないと env にも vault.json にも無い環境では効かない）。
		const env = { ...(await loginEnv()), VISUAL: this.plugin.visualPath(), AGENT_SESSIONS_VAULT: this.plugin.vaultPath() };
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

	/** 送信キーが押されたとき（§6.8・D-50）：送信列を書き、指示マーカーを記録する。ジャンプ
	 * の指示マーカーはここが唯一の記録場所（`onData` からは記録しない。§6.7）。 */
	private sendSubmit(): void {
		this.sendInput(Buffer.from(submitSequence(this.plugin.settings), "binary"));
		this.marks.markInstruction();
	}

	/**
	 * 内蔵エディタの「送る」の後（D-51）：編集領域が閉じていれば送信する。`main.ts` が
	 * Claude の読み戻しを待ってから呼ぶ。
	 */
	submitPrompt(): void {
		if (this.pendingEdit || this.closed) {
			return;
		}
		this.sendSubmit();
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
			this.showExit({ kind: "claude-missing", message: t("error.claudeMissing") });
			return;
		}
		const resumeFailed =
			early && RESUME_FAILURE_PATTERNS.some((p) => this.earlyOutput.includes(p));
		this.showExit({ kind: "exited", code, resumeFailed });
	}

	// ---- 編集領域（D-21・D-22） -----------------------------------------------------

	/**
	 * `agent-sessions edit` からの要求。本体を上下に割って下に編集領域を開き、送る／入力欄に戻る／取消で
	 * 解決する。編集中に 2 つ目が来たら `busy`。
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

	/** claude 側が切れた：編集領域を閉じ、`pendingEdit` を `cancel` で解決する（応答は返さない）。 */
	abortEditor(): void {
		this.pendingEdit?.abort();
	}

	/** タブ側が閉じる：元の内容を書き戻して `cancel` で解決する（応答は `main.ts` が返す）。 */
	cancelEditor(): void {
		this.pendingEdit?.cancel();
	}

	// ---- リンク・`@`・ジャンプ（§6.7） --------------------------------------------

	/** `@` の相対パスの基準・`start` の cwd。state の `cwd` が空なら vault（D-42）。 */
	getCwd(): string {
		return this.cwd || this.plugin.vaultPath();
	}

	/** ヘッダの `@` や `main.ts` のコマンドから、このターミナルへ入力フォーカスを移す。 */
	focusTerminal(): void {
		this.terminal.focus();
	}

	/**
	 * 最後に前面だったノートを `@path[#Lx-y] ` としてこのターミナルへ書き、フォーカスを移す。
	 * `workspace.activeEditor` はターミナルにフォーカスがあると null なので、`main.ts` が
	 * 覚えている Markdown ビューを使う（§6.7・D-42）。
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

	/** 応答マーカー（§6.7）：`registry` の `busy`（初回観測を含む）でカーソル行に打つ。 */
	private onBusyMark(id: string): void {
		if (id === this.id) {
			this.marks.onBusy();
		}
	}

	/**
	 * 表示の先頭行（バッファ内の絶対行）。`marks.prev/next` はこれより上／下の指示マーカーを返す。
	 * マーカーの `line` も絶対行なので、`scrollToLine` にそのまま渡せる。
	 */
	private viewportY(): number {
		return this.terminal.buffer.active.viewportY;
	}

	/** `line`（絶対行）を表示の先頭にする。`null`（該当なし）なら何もしない。 */
	private jumpTo(line: number | null): void {
		if (line === null) {
			return;
		}
		this.terminal.scrollToLine(line);
		this.focusTerminal();
	}

	// fullscreen（`tui: "fullscreen"`）では Claude が全面を描き直してスクロールを自分で持ち、
	// xterm のスクロールバックに何も溜まらない（`buffer.length === rows`）。マーカー方式は成り立たない
	// ので、Claude の `Scroll` コンテキストのキー（PageUp／PageDown／End）を送る。

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

	// ---- ⋯ メニュー（D-42） ---------------------------------------------------------

	/**
	 * Obsidian 標準の項目（右／下に分割を含む）の後に、区切り線とセッションの操作を足す。
	 * 「セッションを圧縮」の非活性は `index.getCachedDetail` の `last_command`（同期。未取得なら活性のまま
	 * にし、`compactSession` 側が改めて判定する）。
	 */
	onPaneMenu(menu: Menu, source: "more-options" | "tab-header" | string): void {
		super.onPaneMenu(menu, source);
		const id = this.id;
		const lastCommand = this.plugin.index.getCachedDetail(id)?.last_command ?? null;
		// 未取得なら次に開くときのために取っておく。
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

	// ---- キー -------------------------------------------------------------------

	private handleKey(ev: KeyboardEvent): boolean {
		// 編集領域を開いている間は、何も xterm に渡さない（IME を含む。D-21・D-42）。
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
		// Enter の組合せはすべて横取りし、送信か改行の列を自分で送る（D-50）。
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

	/** 繋ぎ直す（デーモンに `id` があれば attach、無ければ start）。 */
	private async retry(): Promise<void> {
		this.hideExit();
		await this.ensureAttached();
	}

	/** 再開：`forget` → `start`（`--resume`、`fresh` なら `--session-id`）→ `attach`。 */
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

	/** デーモン不通・claude 不在・起動失敗（`exited` は別に扱う。D-66）。 */
	private isErrorState(): boolean {
		return !!this.exitReason && this.exitReason.kind !== "exited";
	}

	/**
	 * 今の状態（`terminalStatus`・D-66）。`updateIcon()` と、行の印と合成する
	 * `main.ts` の `refreshTerminalStatus()`（`currentStatus()` 経由。D-66 追補）で使う。
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

	/** 今の状態（公開版。`main.ts` の `refreshTerminalStatus()` が読む。D-66 追補）。 */
	currentStatus(): TerminalStatus {
		return this.computeStatus();
	}

	/** 閉じていないか（`main.ts` の `refreshTerminalStatus()` が複数ビューを合成するのに使う。D-66 追補）。 */
	isOpen(): boolean {
		return !this.closed;
	}

	/** タブ見出しのアイコン（`terminalStatus`・D-66）。状態ごとにアイコン・色・動きのクラスが変わる。 */
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

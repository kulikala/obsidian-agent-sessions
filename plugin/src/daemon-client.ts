// デーモンのソケットとフレーム（§4.1）・セッションの保持（§4.2）・接続エラー（§7）。
//
// フレーム：
//   +------+----------------+---------+
//   | type | length (u32 BE)| payload |
//   | 1 B  | 4 B            | n B     |
//   +------+----------------+---------+
// type は 'J'（JSON、要求・応答・イベント）・'D'（生バイト、PTY の入出力）・
// 'R'（デーモン→、attach 直後の再生バッファ）。

import { EventEmitter } from "node:events";
import * as net from "node:net";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { t } from "./i18n";

export type FrameKind = "J" | "D" | "R";

export interface Frame {
	kind: FrameKind;
	payload: Buffer;
}

const KIND_BYTE: Record<FrameKind, number> = { J: 0x4a, D: 0x44, R: 0x52 };
const BYTE_KIND: Record<number, FrameKind> = { 0x4a: "J", 0x44: "D", 0x52: "R" };

/** ソケットの既定パス（`~/.agents/sessions/daemon.sock`。§3）。 */
export function defaultSockPath(): string {
	return join(homedir(), ".agents", "sessions", "daemon.sock");
}

export function encodeFrame(kind: FrameKind, payload: Uint8Array | Buffer): Buffer {
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
	const header = Buffer.alloc(5);
	header.writeUInt8(KIND_BYTE[kind], 0);
	header.writeUInt32BE(body.length, 1);
	return Buffer.concat([header, body]);
}

/** 受信バイト列からフレームを切り出す。フレーム境界をまたぐ分割にも対応する。 */
export class FrameDecoder {
	private buf: Buffer = Buffer.alloc(0);

	feed(chunk: Uint8Array | Buffer): Frame[] {
		this.buf = Buffer.concat([this.buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
		const frames: Frame[] = [];
		for (;;) {
			if (this.buf.length < 5) break;
			const kindByte = this.buf.readUInt8(0);
			const kind = BYTE_KIND[kindByte];
			if (kind === undefined) {
				throw new Error(t("error.unknownFrameKind", { hex: kindByte.toString(16) }));
			}
			const length = this.buf.readUInt32BE(1);
			if (this.buf.length < 5 + length) break;
			frames.push({ kind, payload: Buffer.from(this.buf.subarray(5, 5 + length)) });
			this.buf = this.buf.subarray(5 + length);
		}
		return frames;
	}
}

export interface JsonRequestArgs {
	[key: string]: unknown;
}

export interface JsonResponse {
	ok: boolean;
	seq?: number;
	error?: string;
	[key: string]: unknown;
}

/** デーモンに接続できない（§7：Python が無い／ソケットが作れない／`agent-sessions` が無い）。 */
export class DaemonUnavailableError extends Error {}

interface Pending {
	resolve: (res: JsonResponse) => void;
	reject: (err: Error) => void;
}

/**
 * デーモンのソケットクライアント（§4.1）。
 *
 * イベント：
 * - `data`（Buffer）：`D` フレーム＝PTY の出力
 * - `replay`（Buffer）：`R` フレーム＝attach 直後の再生チャンク
 * - `replayed`：再生の終わり（`{"ev":"replayed"}`）
 * - `exit`（id, code）：セッションの終了（`{"ev":"exit",…}`）
 * - `close`：ソケットが閉じた
 */
export class DaemonClient extends EventEmitter {
	private socket: net.Socket | null = null;
	private decoder = new FrameDecoder();
	private seq = 0;
	private pending = new Map<number, Pending>();

	constructor(private sockPath: string) {
		super();
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = net.connect(this.sockPath);
			const onError = (err: Error) => {
				socket.removeAllListeners();
				reject(err);
			};
			socket.once("error", onError);
			socket.once("connect", () => {
				socket.removeListener("error", onError);
				this.socket = socket;
				socket.on("data", (chunk: Buffer) => this.handleData(chunk));
				socket.on("close", () => {
					this.socket = null;
					this.rejectPending(new Error(t("error.socketClosed")));
					this.emit("close");
				});
				socket.on("error", (err: Error) => this.emit("error", err));
				resolve();
			});
		});
	}

	private handleData(chunk: Buffer): void {
		for (const frame of this.decoder.feed(chunk)) {
			if (frame.kind === "D") {
				this.emit("data", frame.payload);
				continue;
			}
			if (frame.kind === "R") {
				this.emit("replay", frame.payload);
				continue;
			}
			const msg = JSON.parse(frame.payload.toString("utf8")) as JsonResponse & { ev?: string; id?: string; code?: number };
			if (typeof msg.seq === "number") {
				const pending = this.pending.get(msg.seq);
				if (pending) {
					this.pending.delete(msg.seq);
					pending.resolve(msg);
				}
				continue;
			}
			if (msg.ev === "replayed") {
				this.emit("replayed");
			} else if (msg.ev === "exit") {
				this.emit("exit", msg.id, msg.code);
			}
		}
	}

	request(op: string, args: JsonRequestArgs = {}): Promise<JsonResponse> {
		if (!this.socket) {
			return Promise.reject(new Error(t("error.notConnected")));
		}
		const seq = ++this.seq;
		const payload = Buffer.from(JSON.stringify({ op, seq, ...args }), "utf8");
		const socket = this.socket;
		return new Promise((resolve, reject) => {
			this.pending.set(seq, { resolve, reject });
			socket.write(encodeFrame("J", payload));
		});
	}

	hello(client: "plugin" | "tui"): Promise<JsonResponse> {
		return this.request("hello", { client });
	}

	list(): Promise<JsonResponse> {
		return this.request("list");
	}

	start(args: {
		id: string;
		agent: string;
		cwd: string;
		argv: string[];
		env: Record<string, string>;
		cols: number;
		rows: number;
	}): Promise<JsonResponse> {
		return this.request("start", args);
	}

	attach(id: string, cols: number, rows: number): Promise<JsonResponse> {
		return this.request("attach", { id, cols, rows });
	}

	detach(): Promise<JsonResponse> {
		return this.request("detach");
	}

	resize(cols: number, rows: number): Promise<JsonResponse> {
		return this.request("resize", { cols, rows });
	}

	kill(id: string, signal = "TERM"): Promise<JsonResponse> {
		return this.request("kill", { id, signal });
	}

	forget(id: string): Promise<JsonResponse> {
		return this.request("forget", { id });
	}

	shutdown(): Promise<JsonResponse> {
		return this.request("shutdown");
	}

	writeInput(bytes: Uint8Array | Buffer): void {
		if (!this.socket) {
			throw new Error(t("error.notConnected"));
		}
		this.socket.write(encodeFrame("D", bytes));
	}

	close(): void {
		this.socket?.end();
		this.socket = null;
	}

	private rejectPending(err: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(err);
		}
		this.pending.clear();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const ENSURE_ATTEMPTS = 3;

/**
 * デーモンに接続する。繋がらなければ `agentSessionsPath daemon --detach` を起動し、
 * 1 秒待って再試行する（§6.3・§7）。3 回失敗したら `DaemonUnavailableError`。
 */
export async function ensureDaemon(sockPath: string, agentSessionsPath: string): Promise<DaemonClient> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= ENSURE_ATTEMPTS; attempt++) {
		const client = new DaemonClient(sockPath);
		try {
			await client.connect();
			return client;
		} catch (err) {
			lastErr = err;
		}
		try {
			spawn(agentSessionsPath, ["daemon", "--detach"], { detached: true, stdio: "ignore" }).unref();
		} catch (err) {
			lastErr = err;
		}
		if (attempt < ENSURE_ATTEMPTS) {
			await delay(1000);
		}
	}
	throw new DaemonUnavailableError(describeUnavailable(lastErr, agentSessionsPath));
}

function describeUnavailable(err: unknown, agentSessionsPath: string): string {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	const path = (err as NodeJS.ErrnoException | undefined)?.path;
	if (code === "ENOENT" && path === agentSessionsPath) {
		return t("error.agentSessionsNotFound", { path: agentSessionsPath });
	}
	return t("error.daemonUnavailable");
}

// プラグイン側ソケット（D-21）。`~/.agents/sessions/plugin.sock` で listen し、
// `agent-sessions edit` からの `J {"op":"edit","seq","file","session","cwd"}` を受ける。
// フレームは `daemon-client.ts` の `encodeFrame`／`FrameDecoder` を共用する（`J` のみ）。
//
// 1 接続 1 要求。`reply` で応答して接続を閉じる。応答の前に相手が切れたら（claude 側の
// 中断・`{"op":"cancel"}`）`req.onAbort` を呼ぶ。`stop()` は応答待ちの要求すべてに
// `cancel` を返してから閉じる。

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { encodeFrame, FrameDecoder } from "./daemon-client";

export interface EditRequest {
	file: string;
	session: string;
	cwd: string;
	/** 応答の前に相手が切れたときに呼ばれる。ハンドラが設定する。 */
	onAbort: (() => void) | null;
}

export type EditReply = (ok: boolean, error?: string) => void;
export type EditHandler = (req: EditRequest, reply: EditReply) => void;

interface Conn {
	socket: net.Socket;
	decoder: FrameDecoder;
	req: EditRequest | null;
	seq: number;
	replied: boolean;
}

export class EditServer {
	private server: net.Server | null = null;
	private sockPath = "";
	private handler: EditHandler | null = null;
	private conns = new Set<Conn>();

	onEdit(handler: EditHandler): void {
		this.handler = handler;
	}

	/** 古いソケットを消して listen し、`chmod 0600`。 */
	start(sockPath: string): Promise<void> {
		this.sockPath = sockPath;
		fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
		try {
			fs.unlinkSync(sockPath);
		} catch {
			// 無ければよい。
		}
		const server = net.createServer((socket) => this.accept(socket));
		this.server = server;
		return new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(sockPath, () => {
				server.removeListener("error", reject);
				server.on("error", (err) => console.warn("agent-sessions: plugin.sock", err));
				try {
					fs.chmodSync(sockPath, 0o600);
				} catch {
					// 失敗しても listen は続ける。
				}
				resolve();
			});
		});
	}

	/** 応答待ちの要求に `cancel` を返し、接続と listen を閉じてソケットを消す。 */
	stop(): void {
		for (const conn of [...this.conns]) {
			if (conn.req && !conn.replied) {
				this.reply(conn, false, "cancel");
			} else {
				conn.socket.end();
			}
		}
		this.conns.clear();
		const server = this.server;
		this.server = null;
		if (server) {
			server.close();
		}
		if (this.sockPath) {
			try {
				fs.unlinkSync(this.sockPath);
			} catch {
				// 既に無ければよい。
			}
		}
	}

	get listening(): boolean {
		return this.server !== null;
	}

	private accept(socket: net.Socket): void {
		const conn: Conn = { socket, decoder: new FrameDecoder(), req: null, seq: 0, replied: false };
		this.conns.add(conn);
		socket.on("data", (chunk: Buffer) => this.onData(conn, chunk));
		socket.on("error", () => undefined);
		socket.on("close", () => {
			this.conns.delete(conn);
			if (conn.req && !conn.replied) {
				conn.replied = true;
				conn.req.onAbort?.();
			}
		});
	}

	private onData(conn: Conn, chunk: Buffer): void {
		let frames;
		try {
			frames = conn.decoder.feed(chunk);
		} catch {
			conn.socket.destroy();
			return;
		}
		for (const frame of frames) {
			if (frame.kind !== "J") {
				continue;
			}
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
			} catch {
				this.send(conn, { ok: false, error: "bad-request" });
				continue;
			}
			this.handleMessage(conn, msg);
		}
	}

	private handleMessage(conn: Conn, msg: Record<string, unknown>): void {
		const seq = typeof msg.seq === "number" ? msg.seq : 0;
		if (msg.op === "cancel") {
			// claude 側の中断（Ctrl+C／SIGTERM）。応答は要らない。
			if (conn.req && !conn.replied) {
				conn.replied = true;
				conn.req.onAbort?.();
			}
			conn.socket.end();
			return;
		}
		if (msg.op !== "edit") {
			this.send(conn, { ok: false, error: "unknown-op", seq });
			return;
		}
		if (typeof msg.file !== "string" || !msg.file) {
			this.send(conn, { ok: false, error: "bad-request", seq });
			return;
		}
		if (conn.req) {
			this.send(conn, { ok: false, error: "busy", seq });
			return;
		}
		conn.seq = seq;
		conn.req = {
			file: msg.file,
			session: typeof msg.session === "string" ? msg.session : "",
			cwd: typeof msg.cwd === "string" ? msg.cwd : "",
			onAbort: null,
		};
		if (!this.handler) {
			this.reply(conn, false, "no-tab");
			return;
		}
		this.handler(conn.req, (ok, error) => this.reply(conn, ok, error));
	}

	/** 応答して接続を閉じる。既に応答済み・切断済みなら何もしない。 */
	private reply(conn: Conn, ok: boolean, error?: string): void {
		if (conn.replied) {
			return;
		}
		conn.replied = true;
		const body: Record<string, unknown> = { ok, seq: conn.seq };
		if (!ok) {
			body.error = error ?? "cancel";
		}
		this.send(conn, body);
		conn.socket.end();
	}

	private send(conn: Conn, body: Record<string, unknown>): void {
		if (conn.socket.destroyed) {
			return;
		}
		try {
			conn.socket.write(encodeFrame("J", Buffer.from(JSON.stringify(body), "utf8")));
		} catch {
			// 相手が消えていれば書けない。close で片付く。
		}
	}
}

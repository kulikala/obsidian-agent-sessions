// The plugin's own socket. Listens on `~/.agents/sessions/plugin.sock` and receives
// `J {"op":"edit","seq","file","session","cwd"}` from `agent-sessions edit`. Frames share
// `daemon-client.ts`'s `encodeFrame`/`FrameDecoder` (using kind `J` only).
//
// One request per connection. Replies via `reply`, then closes the connection. If the other
// side disconnects before a reply is sent (claude's side aborting, or `{"op":"cancel"}`), calls
// `req.onAbort`. `stop()` replies `cancel` to every still-pending request before closing.

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { encodeFrame, FrameDecoder } from "./daemon-client";

export interface EditRequest {
	file: string;
	session: string;
	cwd: string;
	/** Called if the other side disconnects before a reply is sent. Set by the handler. */
	onAbort: (() => void) | null;
}

export type EditReply = (ok: boolean, error?: string) => void;

/**
 * The editor pane's outcome. `send` = send it, `return` = back to the prompt (keeps the content,
 * commits it, doesn't submit), `cancel` = the tab closed (original content), `busy` = already editing.
 */
export type EditOutcome = "send" | "return" | "cancel" | "busy";

/** Turns an outcome into a reply: send/return are `ok` (exit 0), everything else is an error named after the outcome. */
export function editReplyFor(outcome: EditOutcome): { ok: boolean; error?: string } {
	if (outcome === "send" || outcome === "return") {
		return { ok: true };
	}
	return { ok: false, error: outcome };
}

/** Whether to send the submit sequence after "send": only for a prompt-edit temp file (`claude-prompt-*`). */
export function submitsAfterEdit(file: string): boolean {
	return path.basename(file).startsWith("claude-prompt-");
}
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

	/** Removes any stale socket, starts listening, then `chmod 0600`. */
	start(sockPath: string): Promise<void> {
		this.sockPath = sockPath;
		fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
		try {
			fs.unlinkSync(sockPath);
		} catch {
			// Fine if it wasn't there.
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
					// Keep listening even if this fails.
				}
				resolve();
			});
		});
	}

	/** Replies `cancel` to any still-pending request, then closes every connection and the listener, and removes the socket. */
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
				// Fine if it's already gone.
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
			// claude's side aborted (Ctrl+C/SIGTERM). No reply needed.
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

	/** Sends a reply and closes the connection. Does nothing if already replied or disconnected. */
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
			// Can't write if the other side is already gone — the `close` handler cleans up.
		}
	}
}

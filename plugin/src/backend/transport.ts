// Local stream sockets between the plugin, the daemon and the `agent-sessions` CLI — the
// TypeScript side of `agentsessions/transport.py`.
//
// On macOS/Linux an endpoint is a Unix domain socket at a path (`daemon.sock`, `plugin.sock`).
// On Windows the same path names a JSON file, `{"port": N, "token": "<hex>"}`: the listener is a
// TCP socket on 127.0.0.1, and a client sends the token plus a newline before anything else.

import * as fs from "node:fs";
import * as net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const IS_WINDOWS = process.platform === "win32";

const TOKEN_BYTES = 16;
const TOKEN_LINE = TOKEN_BYTES * 2 + 1;

export interface Endpoint {
	port: number;
	token: string;
}

/** Parses an endpoint file's text; `null` when malformed. Pure. */
export function parseEndpoint(text: string): Endpoint | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null) return null;
	const { port, token } = data as Record<string, unknown>;
	if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || typeof token !== "string" || !token) {
		return null;
	}
	return { port, token };
}

/**
 * Starts connecting to the endpoint at `path` and returns the socket (listen for `connect` /
 * `error` as with `net.connect`). On Windows a missing or malformed endpoint file surfaces as an
 * `error` event with code `ENOENT`, like a missing Unix socket.
 */
export function connectEndpoint(path: string): net.Socket {
	if (!IS_WINDOWS) {
		return net.connect(path);
	}
	let endpoint: Endpoint | null = null;
	try {
		endpoint = parseEndpoint(fs.readFileSync(path, "utf8"));
	} catch {
		endpoint = null;
	}
	if (!endpoint) {
		const socket = new net.Socket();
		const err = Object.assign(new Error(`no endpoint at ${path}`), { code: "ENOENT", path });
		queueMicrotask(() => socket.destroy(err));
		return socket;
	}
	const socket = net.connect({ host: "127.0.0.1", port: endpoint.port });
	const token = endpoint.token;
	socket.once("connect", () => socket.write(`${token}\n`, "ascii"));
	return socket;
}

/**
 * Listens on `server` for the endpoint at `path`. Resolves with the token clients must present
 * (`null` on Unix, where the socket file's 0600 mode does that job).
 */
export function listenEndpoint(server: net.Server, path: string): Promise<string | null> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		if (!IS_WINDOWS) {
			server.listen(path, () => {
				server.removeListener("error", reject);
				try {
					fs.chmodSync(path, 0o600);
				} catch {
					// Keep listening even if this fails.
				}
				resolve(null);
			});
			return;
		}
		server.listen({ host: "127.0.0.1", port: 0 }, () => {
			server.removeListener("error", reject);
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("no TCP address"));
				return;
			}
			const token = randomBytes(TOKEN_BYTES).toString("hex");
			const tmp = `${path}.${process.pid}.tmp`;
			try {
				fs.writeFileSync(tmp, JSON.stringify({ port: address.port, token, pid: process.pid }), "utf8");
				fs.renameSync(tmp, path);
			} catch (err) {
				reject(err);
				return;
			}
			resolve(token);
		});
	});
}

/**
 * Listener-side check of the token line a Windows client sends first. `feed` returns
 * `{ state, rest }`: `true` once matched (`rest` = the bytes after it), `false` on a mismatch
 * (drop the connection), `null` while more bytes are needed. With no token it passes everything.
 */
export class TokenGate {
	private buf = Buffer.alloc(0);
	passed: boolean;

	constructor(private token: string | null) {
		this.passed = token === null;
	}

	feed(chunk: Buffer): { state: boolean | null; rest: Buffer } {
		if (this.passed) return { state: true, rest: chunk };
		this.buf = Buffer.concat([this.buf, chunk]);
		if (this.buf.length < TOKEN_LINE) return { state: null, rest: Buffer.alloc(0) };
		const line = this.buf.subarray(0, TOKEN_LINE);
		const rest = Buffer.from(this.buf.subarray(TOKEN_LINE));
		this.buf = Buffer.alloc(0);
		const expected = Buffer.from(`${this.token ?? ""}\n`, "ascii");
		if (line.length === expected.length && timingSafeEqual(line, expected)) {
			this.passed = true;
			return { state: true, rest };
		}
		return { state: false, rest: Buffer.alloc(0) };
	}
}

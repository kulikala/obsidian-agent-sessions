import { randomBytes } from "node:crypto";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient, encodeFrame, FrameDecoder } from "../src/daemon-client";

describe("encodeFrame / FrameDecoder", () => {
	it("round-trips a single frame", () => {
		const payload = Buffer.from(JSON.stringify({ op: "hello", seq: 1 }), "utf8");
		const encoded = encodeFrame("J", payload);
		const decoder = new FrameDecoder();
		const frames = decoder.feed(encoded);
		expect(frames).toHaveLength(1);
		expect(frames[0].kind).toBe("J");
		expect(frames[0].payload.toString("utf8")).toBe(payload.toString("utf8"));
	});

	it("splits multiple frames even when they arrive concatenated", () => {
		const a = encodeFrame("D", Buffer.from("abc"));
		const b = encodeFrame("J", Buffer.from('{"ev":"replayed"}'));
		const decoder = new FrameDecoder();
		const frames = decoder.feed(Buffer.concat([a, b]));
		expect(frames.map((f) => f.kind)).toEqual(["D", "J"]);
		expect(frames[0].payload.toString("utf8")).toBe("abc");
	});

	it("waits for the rest when a frame arrives split mid-way", () => {
		const full = encodeFrame("D", Buffer.from("0123456789"));
		const decoder = new FrameDecoder();

		const head = full.subarray(0, 3);
		expect(decoder.feed(head)).toHaveLength(0);

		const middle = full.subarray(3, 8);
		expect(decoder.feed(middle)).toHaveLength(0);

		const tail = full.subarray(8);
		const frames = decoder.feed(tail);
		expect(frames).toHaveLength(1);
		expect(frames[0].payload.toString("utf8")).toBe("0123456789");
	});

	it("recovers on the next feed even when the split lands right before the length bytes", () => {
		const full = encodeFrame("J", Buffer.from("{}"));
		const decoder = new FrameDecoder();
		// Cut after 3 bytes, in the middle of the 1-byte kind + 4-byte length header.
		expect(decoder.feed(full.subarray(0, 3))).toHaveLength(0);
		const frames = decoder.feed(full.subarray(3));
		expect(frames).toHaveLength(1);
		expect(frames[0].kind).toBe("J");
	});
});

/** A mock server that reads requests arriving as `J` frames and echoes the handler's return value back with the same `seq`. */
function startMockServer(
	sockPath: string,
	handle: (op: string, args: Record<string, unknown>, socket: net.Socket) => unknown
): Promise<net.Server> {
	return new Promise((resolve, reject) => {
		const server = net.createServer((socket) => {
			const decoder = new FrameDecoder();
			socket.on("data", (chunk) => {
				for (const frame of decoder.feed(chunk)) {
					if (frame.kind !== "J") continue;
					const { op, seq, ...args } = JSON.parse(frame.payload.toString("utf8"));
					const result = handle(op, args, socket);
					const response = Buffer.from(JSON.stringify({ ok: true, seq, ...(result as object) }), "utf8");
					socket.write(encodeFrame("J", response));
				}
			});
		});
		server.once("error", reject);
		server.listen(sockPath, () => resolve(server));
	});
}

describe("DaemonClient", () => {
	let sockPath: string;
	let server: net.Server | undefined;

	beforeEach(() => {
		sockPath = join(tmpdir(), `agent-sessions-test-${randomBytes(6).toString("hex")}.sock`);
	});

	afterEach(async () => {
		server?.close();
		server = undefined;
	});

	it("request matches a response by its seq", async () => {
		server = await startMockServer(sockPath, (op) => ({ echo: op }));
		const client = new DaemonClient(sockPath);
		await client.connect();

		const res = await client.request("hello", { client: "plugin" });
		expect(res.ok).toBe(true);
		expect(res.echo).toBe("hello");

		client.close();
	});

	it("routes a response to the right caller by seq, even when it arrives out of order", async () => {
		// Deliberately delay the response to "hello" (sent first) and write the response to
		// "list" (sent second) right away, to confirm request() dispatches by seq rather than
		// send order.
		server = await new Promise<net.Server>((resolve, reject) => {
			const s = net.createServer((socket) => {
				const decoder = new FrameDecoder();
				socket.on("data", (chunk) => {
					for (const frame of decoder.feed(chunk)) {
						if (frame.kind !== "J") continue;
						const { op, seq } = JSON.parse(frame.payload.toString("utf8"));
						const write = () => socket.write(encodeFrame("J", Buffer.from(JSON.stringify({ ok: true, seq, op }))));
						if (op === "hello") {
							setTimeout(write, 20);
						} else {
							write();
						}
					}
				});
			});
			s.once("error", reject);
			s.listen(sockPath, () => resolve(s));
		});

		const client = new DaemonClient(sockPath);
		await client.connect();

		const helloPromise = client.hello("plugin");
		const listPromise = client.list();
		const [helloRes, listRes] = await Promise.all([helloPromise, listPromise]);
		expect(helloRes.op).toBe("hello");
		expect(listRes.op).toBe("list");

		client.close();
	});

	it("a D frame becomes a data event; a J frame's ev becomes a replayed/exit event", async () => {
		server = await new Promise<net.Server>((resolve, reject) => {
			const s = net.createServer((socket) => {
				socket.write(encodeFrame("R", Buffer.from("replay-data")));
				socket.write(encodeFrame("J", Buffer.from('{"ev":"replayed"}')));
				socket.write(encodeFrame("D", Buffer.from("output")));
				socket.write(encodeFrame("J", Buffer.from('{"ev":"exit","id":"abc","code":0}')));
			});
			s.once("error", reject);
			s.listen(sockPath, () => resolve(s));
		});

		const client = new DaemonClient(sockPath);
		const seen: string[] = [];
		const replay: Buffer[] = [];
		const dataChunks: Buffer[] = [];
		let exitArgs: [string, number] | undefined;

		client.on("replay", (buf: Buffer) => {
			replay.push(buf);
			seen.push("replay");
		});
		client.on("replayed", () => seen.push("replayed"));
		client.on("data", (buf: Buffer) => {
			dataChunks.push(buf);
			seen.push("data");
		});
		client.on("exit", (id: string, code: number) => {
			exitArgs = [id, code];
			seen.push("exit");
		});

		await client.connect();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(seen).toEqual(["replay", "replayed", "data", "exit"]);
		expect(replay[0]?.toString("utf8")).toBe("replay-data");
		expect(dataChunks[0]?.toString("utf8")).toBe("output");
		expect(exitArgs).toEqual(["abc", 0]);

		client.close();
	});

	it("fires a close event when the socket closes", async () => {
		server = await startMockServer(sockPath, () => ({}));
		const client = new DaemonClient(sockPath);
		await client.connect();

		const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
		server.close();
		client.close();
		await closed;
	});
});

// 実デーモンとの往復。`AGENT_SESSIONS_BIN`（`agent-sessions` 本体へのパス）が
// 環境変数に無ければ丸ごと skip する（受け入れは T-14 で行う）。

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client";

const BIN = process.env.AGENT_SESSIONS_BIN;

function waitForSocket(sockPath: string, timeoutMs = 3000): Promise<void> {
	const client = new DaemonClient(sockPath);
	const start = Date.now();
	const attempt = async (): Promise<void> => {
		try {
			await client.connect();
			client.close();
		} catch (err) {
			if (Date.now() - start > timeoutMs) {
				throw err;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
			return attempt();
		}
	};
	return attempt();
}

describe.skipIf(!BIN)("daemon（実プロセス）", () => {
	let daemonProc: ChildProcess | undefined;
	let sockPath: string;

	afterEach(() => {
		daemonProc?.kill();
		daemonProc = undefined;
	});

	it("hello → start(cat) → attach → 入出力の往復 → shutdown", async () => {
		sockPath = join(tmpdir(), `agent-sessions-it-${randomBytes(6).toString("hex")}.sock`);
		daemonProc = spawn(BIN as string, ["daemon"], {
			env: { ...process.env, AGENT_SESSIONS_SOCK: sockPath },
			stdio: "ignore",
		});

		await waitForSocket(sockPath);

		const client = new DaemonClient(sockPath);
		await client.connect();

		const helloRes = await client.hello("plugin");
		expect(helloRes.ok).toBe(true);

		const id = `it-${randomBytes(4).toString("hex")}`;
		const startRes = await client.start({
			id,
			agent: "test",
			cwd: process.cwd(),
			argv: ["cat"],
			env: {},
			cols: 80,
			rows: 24,
		});
		expect(startRes.ok).toBe(true);

		const chunks: Buffer[] = [];
		client.on("data", (buf: Buffer) => chunks.push(buf));
		const replayed = new Promise<void>((resolve) => client.once("replayed", () => resolve()));

		const attachRes = await client.attach(id, 80, 24);
		expect(attachRes.ok).toBe(true);
		await replayed;

		client.writeInput(Buffer.from("hello\n"));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(Buffer.concat(chunks).toString("utf8")).toContain("hello");

		const killRes = await client.kill(id);
		expect(killRes.ok).toBe(true);

		const shutdownRes = await client.shutdown();
		expect(shutdownRes.ok).toBe(true);
	});
});

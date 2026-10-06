// Smoke test, the half that runs inside Obsidian. Evaluated in the renderer over CDP
// (`Runtime.evaluate`, awaitPromise) by `run.mjs`; it defines
//
//     globalThis.__agentSessionsSmoke = { run(opts), verify(opts), sweep(), startEnv(plugin) }
//
//   run({ mode: "cleanup" | "keep", workDir })  -> { steps, kept }
//   verify({ id, marker })                      -> { steps }
//   sweep()                                     -> { steps }   (ends leftover smoke- sessions)
//
// Each step is { name, status: "pass" | "fail" | "skipped", ms, message, data? }. Neither function
// ever throws. It drives the plugin from the inside (`app.plugins.plugins["agent-sessions"]`) and
// talks to the daemon with its own small client in the plugin's frame format, so it does not depend
// on the DOM. The session it starts is a fake agent (`fake_agent.py`), never a real one.
//
// `run.mjs` defines `globalThis.__smokeDecideLeftovers` (lib/leftovers.mjs) before this file.
(() => {
	"use strict";

	const nodeRequire = typeof window !== "undefined" && typeof window.require === "function" ? window.require : require;
	const fs = nodeRequire("fs");
	const os = nodeRequire("os");
	const path = nodeRequire("path");
	const net = nodeRequire("net");
	const cp = nodeRequire("child_process");
	const { StringDecoder } = nodeRequire("string_decoder");

	const PLUGIN_ID = "agent-sessions";
	const VIEW_TYPE_TERMINAL = "agent-sessions-terminal";
	const PREFIX = "smoke-";
	const IS_WINDOWS = process.platform === "win32";
	const COLS = 100;
	const ROWS = 30;
	const RESIZED_COLS = 64;
	const RESIZED_ROWS = 20;
	const REQUEST_TIMEOUT_MS = 15000;

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	/** The environment the fake agent starts with: Obsidian's, the plugin's built-in editor variables
	 * (`editorEnv`, async: on Windows it names the shim without spaces) and the vault. Throws when
	 * `VISUAL` is missing, so the start step fails rather than the editor step later. */
	async function startEnv(plugin) {
		const env = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (typeof v === "string") {
				env[k] = v;
			}
		}
		const editor = await plugin.editorEnv("claude", env);
		if (!editor || typeof editor.VISUAL !== "string" || !editor.VISUAL) {
			throw new Error("the plugin's editorEnv gave no VISUAL");
		}
		Object.assign(env, editor, { AGENT_SESSIONS_VAULT: plugin.vaultPath() });
		if (IS_WINDOWS) {
			env.PYTHONUTF8 = "1";
		}
		return env;
	}

	async function waitFor(fn, timeoutMs, intervalMs = 150) {
		const until = Date.now() + timeoutMs;
		for (;;) {
			let value;
			try {
				value = await fn();
			} catch {
				value = null;
			}
			if (value) {
				return value;
			}
			if (Date.now() > until) {
				return null;
			}
			await sleep(intervalMs);
		}
	}

	const errText = (err) => (err && err.message ? err.message : String(err));

	// ---- The plugin and its paths ---------------------------------------------------------

	function getPlugin() {
		const plugin = app.plugins && app.plugins.plugins && app.plugins.plugins[PLUGIN_ID];
		if (!plugin) {
			throw new Error(`plugin "${PLUGIN_ID}" is not loaded (trust the vault and enable the plugin first)`);
		}
		return plugin;
	}

	function runtimeDir(plugin) {
		return path.dirname(plugin.sockPath());
	}

	function smokeWorkCwd(plugin) {
		return path.join(runtimeDir(plugin), "smoke", "work");
	}

	function statusFile(plugin, id) {
		return path.join(runtimeDir(plugin), "status", `${id}.json`);
	}

	/** Same as windows.ts `programInvocation`: a Windows `.cmd` launcher is run as `python script`. */
	function invocation(program, args) {
		if (IS_WINDOWS && /\.cmd$/i.test(program)) {
			try {
				const m = /^"([^"]+)" "%~dp0([^"]+)" %\*\s*$/m.exec(fs.readFileSync(program, "utf8"));
				if (m) {
					return { file: m[1], args: [path.win32.join(path.win32.dirname(program), m[2]), ...args] };
				}
			} catch {
				// Fall through: the spawn fails with the launcher's own path.
			}
		}
		return { file: program, args };
	}

	function programEnv(plugin) {
		const env = { ...process.env, AGENT_SESSIONS_VAULT: plugin.vaultPath() };
		if (IS_WINDOWS) {
			env.PYTHONUTF8 = "1";
		}
		return env;
	}

	function runProgram(plugin, program, args, timeoutMs = 60000) {
		const call = invocation(program, args);
		return new Promise((resolve, reject) => {
			cp.execFile(
				call.file,
				call.args,
				{ encoding: "utf8", timeout: timeoutMs, windowsHide: true, env: programEnv(plugin), maxBuffer: 64 * 1024 * 1024 },
				(err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout))
			);
		});
	}

	/** The interpreter the program runs under: the plugin's installed one, else the launcher's shebang. */
	function pythonOf(plugin) {
		if (plugin.bundled && plugin.bundled.python) {
			return plugin.bundled.python;
		}
		if (!IS_WINDOWS) {
			try {
				const first = fs.readFileSync(plugin.agentSessionsPath(), "utf8").split("\n", 1)[0];
				const m = /^#!\s*(\S+)/.exec(first);
				if (m && m[1] && !/\/env$/.test(m[1])) {
					return m[1];
				}
			} catch {
				// No shebang to read.
			}
		}
		return null;
	}

	// ---- The daemon's frames, from our own client -----------------------------------------

	function encodeFrame(kind, payload) {
		const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
		const header = Buffer.alloc(5);
		header.writeUInt8(kind.charCodeAt(0), 0);
		header.writeUInt32BE(body.length, 1);
		return Buffer.concat([header, body]);
	}

	/** transport.ts `connectEndpoint`: a Unix socket, or on Windows loopback TCP plus the token line. */
	function connectEndpoint(endpointPath) {
		if (!IS_WINDOWS) {
			return net.connect(endpointPath);
		}
		let endpoint = null;
		try {
			const data = JSON.parse(fs.readFileSync(endpointPath, "utf8"));
			if (data && Number.isInteger(data.port) && data.port > 0 && typeof data.token === "string" && data.token) {
				endpoint = data;
			}
		} catch {
			endpoint = null;
		}
		if (!endpoint) {
			const socket = new net.Socket();
			const err = Object.assign(new Error(`no endpoint at ${endpointPath}`), { code: "ENOENT", path: endpointPath });
			queueMicrotask(() => socket.destroy(err));
			return socket;
		}
		const socket = net.connect({ host: "127.0.0.1", port: endpoint.port });
		socket.once("connect", () => socket.write(`${endpoint.token}\n`, "ascii"));
		return socket;
	}

	/** One connection to the daemon. `out` collects everything the attached session prints (replay included). */
	class Client {
		constructor(sockPath) {
			this.sockPath = sockPath;
			this.socket = null;
			this.buf = Buffer.alloc(0);
			this.seq = 0;
			this.pending = new Map();
			this.decoder = new StringDecoder("utf8");
			this.out = "";
			this.replayed = false;
			this.exits = [];
			this.closed = false;
		}

		connect() {
			return new Promise((resolve, reject) => {
				const socket = connectEndpoint(this.sockPath);
				const onError = (err) => {
					socket.removeAllListeners();
					socket.destroy();
					reject(err);
				};
				socket.once("error", onError);
				socket.once("connect", () => {
					socket.removeListener("error", onError);
					this.socket = socket;
					socket.on("data", (chunk) => this.onData(chunk));
					socket.on("error", () => undefined);
					socket.on("close", () => {
						this.closed = true;
						for (const p of this.pending.values()) {
							p.reject(new Error("socket closed"));
						}
						this.pending.clear();
					});
					resolve();
				});
			});
		}

		onData(chunk) {
			this.buf = Buffer.concat([this.buf, chunk]);
			for (;;) {
				if (this.buf.length < 5) {
					return;
				}
				const kind = String.fromCharCode(this.buf.readUInt8(0));
				const length = this.buf.readUInt32BE(1);
				if (this.buf.length < 5 + length) {
					return;
				}
				const payload = Buffer.from(this.buf.subarray(5, 5 + length));
				this.buf = this.buf.subarray(5 + length);
				if (kind === "D" || kind === "R") {
					this.out += this.decoder.write(payload);
					continue;
				}
				let msg;
				try {
					msg = JSON.parse(payload.toString("utf8"));
				} catch {
					continue;
				}
				if (typeof msg.seq === "number") {
					const p = this.pending.get(msg.seq);
					if (p) {
						this.pending.delete(msg.seq);
						p.resolve(msg);
					}
				} else if (msg.ev === "replayed") {
					this.replayed = true;
				} else if (msg.ev === "exit") {
					this.exits.push({ id: msg.id, code: msg.code });
				}
			}
		}

		request(op, args = {}) {
			if (!this.socket || this.closed) {
				return Promise.reject(new Error("not connected"));
			}
			const seq = ++this.seq;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					this.pending.delete(seq);
					reject(new Error(`daemon did not answer "${op}"`));
				}, REQUEST_TIMEOUT_MS);
				this.pending.set(seq, {
					resolve: (m) => (clearTimeout(timer), resolve(m)),
					reject: (e) => (clearTimeout(timer), reject(e)),
				});
				this.socket.write(encodeFrame("J", Buffer.from(JSON.stringify({ op, seq, ...args }), "utf8")));
			});
		}

		write(text) {
			this.socket.write(encodeFrame("D", Buffer.from(text, "utf8")));
		}

		async sessions() {
			const res = await this.request("list");
			if (!res.ok) {
				throw new Error(`list failed: ${res.error}`);
			}
			return res.sessions || [];
		}

		close() {
			try {
				this.socket && this.socket.end();
			} catch {
				// Already gone.
			}
			this.closed = true;
		}
	}

	async function connectDaemon(plugin, tries = 1, gapMs = 500) {
		let last = null;
		for (let i = 0; i < tries; i++) {
			const client = new Client(plugin.sockPath());
			try {
				await client.connect();
				const hello = await client.request("hello", { client: "plugin" });
				if (!hello.ok) {
					throw new Error(`hello failed: ${hello.error}`);
				}
				client.hello = hello;
				return client;
			} catch (err) {
				last = err;
				client.close();
				if (i < tries - 1) {
					await sleep(gapMs);
				}
			}
		}
		throw last || new Error("could not connect to the daemon");
	}

	function isRunning(s) {
		return s.exited === null || s.exited === undefined;
	}

	function pidAlive(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch (err) {
			return err && err.code === "EPERM";
		}
	}

	/** Ends one session and forgets it: TERM, then KILL if it lingers. Returns what it did. */
	async function endSession(client, id) {
		let info = (await client.sessions()).find((s) => s.id === id);
		if (!info) {
			return "absent";
		}
		if (isRunning(info)) {
			await client.request("kill", { id, signal: "TERM" });
			let gone = await waitFor(async () => !isRunning((await client.sessions()).find((s) => s.id === id) || { exited: 0 }), 6000);
			if (!gone) {
				await client.request("kill", { id, signal: "KILL" });
				gone = await waitFor(async () => !isRunning((await client.sessions()).find((s) => s.id === id) || { exited: 0 }), 6000);
			}
			if (!gone) {
				throw new Error(`session ${id} did not stop`);
			}
		}
		const res = await client.request("forget", { id });
		if (!res.ok && res.error !== "no-session") {
			throw new Error(`forget ${id}: ${res.error}`);
		}
		return "ended";
	}

	function removeFiles(plugin, id) {
		try {
			fs.rmSync(statusFile(plugin, id), { force: true });
		} catch {
			// Not there.
		}
		try {
			fs.rmSync(smokeWorkCwd(plugin), { recursive: true, force: true });
		} catch {
			// Not there.
		}
	}

	// ---- The tab ---------------------------------------------------------------------------

	function terminalLeaf(id) {
		return app.workspace
			.getLeavesOfType(VIEW_TYPE_TERMINAL)
			.find((leaf) => leaf.view && (leaf.view.sessionId === id || leaf.view.daemonSessionId === id));
	}

	/** The tab's screen (scrollback included) as text; wrapped rows are joined. `null` if unreadable. */
	function screenText(view) {
		const term = view && view.terminal;
		if (!term || !term.buffer || !term.buffer.active) {
			return null;
		}
		const buffer = term.buffer.active;
		let text = "";
		for (let y = 0; y < buffer.length; y++) {
			const line = buffer.getLine(y);
			if (!line) {
				continue;
			}
			text += (line.isWrapped || y === 0 ? "" : "\n") + line.translateToString(true);
		}
		return text;
	}

	// ---- Step plumbing ---------------------------------------------------------------------

	/**
	 * Runs `defs` in order. A failed step with `fatal: true` skips the rest ("not reached"); steps
	 * with `always: true` still run (the cleanup). A step returns { status?, message?, data? } or throws.
	 */
	async function runSteps(defs, ctx) {
		const steps = [];
		let stopped = false;
		for (const def of defs) {
			if (stopped && !def.always) {
				steps.push({ name: def.name, status: "skipped", ms: 0, message: "not reached" });
				continue;
			}
			const started = Date.now();
			let r;
			try {
				r = (await def.fn(ctx)) || {};
			} catch (err) {
				r = { status: "fail", message: errText(err) };
			}
			const step = { name: def.name, status: r.status || "pass", ms: Date.now() - started, message: r.message || "" };
			if (r.data !== undefined) {
				step.data = r.data;
			}
			steps.push(step);
			if (step.status === "fail" && def.fatal) {
				stopped = true;
			}
		}
		return steps;
	}

	const fail = (message, data) => ({ status: "fail", message, data });
	const skipped = (message) => ({ status: "skipped", message });

	// ---- run -------------------------------------------------------------------------------

	function buildRunSteps(opts) {
		const mode = opts.mode === "keep" ? "keep" : "cleanup";
		return [
			{
				name: "0 leftovers",
				fatal: true,
				fn: async (ctx) => {
					const plugin = (ctx.plugin = getPlugin());
					let client;
					try {
						client = await connectDaemon(plugin);
					} catch {
						return { message: "daemon not running; nothing left over" };
					}
					try {
						const plan = globalThis.__smokeDecideLeftovers(await client.sessions(), PREFIX);
						for (const id of plan.forget) {
							await endSession(client, id);
							removeFiles(plugin, id);
						}
						return { message: plan.forget.length ? `removed ${plan.forget.join(", ")}` : "none" };
					} finally {
						client.close();
					}
				},
			},
			{
				name: "1 environment and install",
				fatal: true,
				fn: async (ctx) => {
					const plugin = ctx.plugin;
					const program = plugin.agentSessionsPath();
					const info = {
						os: `${os.type()} ${os.release()} (${process.platform}, ${os.arch()})`,
						obsidian: (/obsidian\/([\d.]+)/i.exec(navigator.userAgent) || [])[1] || String(app.appVersion || "unknown"),
						plugin: plugin.manifest.version,
						program: plugin.bundled ? plugin.bundled.version : "unknown",
						programPath: program,
						python: pythonOf(plugin),
					};
					ctx.env = info;
					if (!fs.existsSync(program)) {
						return fail(`the program is not installed (${program}); install it from the plugin first`, info);
					}
					if (!info.python) {
						return fail("no Python for the program (plugin.bundled.python is empty)", info);
					}
					try {
						const out = await new Promise((resolve, reject) =>
							cp.execFile(info.python, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 20000 }, (e, so, se) =>
								e ? reject(e) : resolve((so || se || "").trim())
							)
						);
						info.pythonVersion = out;
					} catch (err) {
						return fail(`cannot run Python ${info.python}: ${errText(err)}`, info);
					}
					ctx.agentScript = path.join(opts.workDir, "fake_agent.py");
					if (!fs.existsSync(ctx.agentScript)) {
						return fail(`the fake agent is missing (${ctx.agentScript})`, info);
					}
					return { message: `${info.os}; Obsidian ${info.obsidian}; plugin ${info.plugin}; program ${info.program}; ${info.pythonVersion}`, data: info };
				},
			},
			{
				name: "2 daemon",
				fatal: true,
				fn: async (ctx) => {
					const plugin = ctx.plugin;
					let client = null;
					let started = false;
					try {
						client = await connectDaemon(plugin);
					} catch {
						const call = invocation(plugin.agentSessionsPath(), ["daemon", "--detach"]);
						cp.spawn(call.file, call.args, {
							detached: true,
							stdio: "ignore",
							windowsHide: true,
							env: IS_WINDOWS ? { ...process.env, PYTHONUTF8: "1" } : process.env,
						}).unref();
						started = true;
						client = await connectDaemon(plugin, 20, 500);
					}
					ctx.client = client;
					if (!started && plugin.bundled) {
						const installFile = path.join(plugin.bundled.dir, "install.json");
						try {
							const installedAt = fs.statSync(installFile).mtimeMs;
							const daemonSince = fs.statSync(plugin.sockPath()).mtimeMs;
							if (daemonSince < installedAt) {
								return fail(
									"the daemon is older than the installed program; restart the daemon first (agent-sessions daemon --stop, then run again)"
								);
							}
						} catch {
							// No install.json or no socket stat: nothing to compare.
						}
					}
					return { message: `${started ? "started" : "already running"} (daemon pid ${client.hello.pid}, version ${client.hello.version})` };
				},
			},
			{
				name: "3 start fake agent",
				fatal: true,
				fn: async (ctx) => {
					const plugin = ctx.plugin;
					const id = (ctx.id = PREFIX + Math.random().toString(36).slice(2, 8));
					ctx.marker = `こんにちは ${id}`;
					const cwd = smokeWorkCwd(plugin);
					fs.mkdirSync(cwd, { recursive: true });
					const env = await startEnv(plugin);
					const client = ctx.client;
					const res = await client.request("start", {
						id,
						agent: "claude",
						cwd,
						argv: [ctx.env.python, ctx.agentScript],
						env,
						cols: COLS,
						rows: ROWS,
					});
					if (!res.ok) {
						return fail(`start failed: ${res.error}${res.message ? ` (${res.message})` : ""}`);
					}
					ctx.started = true;
					const attached = await client.request("attach", { id, cols: COLS, rows: ROWS });
					if (!attached.ok) {
						return fail(`attach failed: ${attached.error}`);
					}
					const ready = await waitFor(() => client.out.includes("FAKE-AGENT READY"), 15000);
					if (!ready) {
						return fail(`the fake agent never printed READY (output: ${JSON.stringify(client.out.slice(-200))})`);
					}
					return { message: `${id} running in ${cwd}` };
				},
			},
			{
				name: "4 input and echo",
				fn: async (ctx) => {
					const client = ctx.client;
					client.write(`${ctx.marker}\r`);
					const expected = `ECHO ${ctx.marker}`;
					const ok = await waitFor(() => client.out.includes(expected), 10000);
					return ok ? { message: "echoed, Japanese included" } : fail(`no echo of ${JSON.stringify(ctx.marker)} (output: ${JSON.stringify(client.out.slice(-200))})`);
				},
			},
			{
				name: "5 resize",
				fn: async (ctx) => {
					const client = ctx.client;
					const res = await client.request("resize", { cols: RESIZED_COLS, rows: RESIZED_ROWS });
					if (!res.ok) {
						return fail(`resize failed: ${res.error}`);
					}
					const from = client.out.length;
					client.write("size\r");
					const want = `SIZE ${RESIZED_COLS}x${RESIZED_ROWS}`;
					const ok = await waitFor(() => client.out.slice(from).includes(want), 10000);
					return ok ? { message: want } : fail(`expected ${want}, got ${JSON.stringify(client.out.slice(from).slice(-100))}`);
				},
			},
			{
				name: "6 disconnect and reattach",
				fn: async (ctx) => {
					ctx.client.close();
					await sleep(300);
					const client = (ctx.client = await connectDaemon(ctx.plugin));
					const attached = await client.request("attach", { id: ctx.id, cols: RESIZED_COLS, rows: RESIZED_ROWS });
					if (!attached.ok) {
						return fail(`reattach failed: ${attached.error}`);
					}
					const replayed = await waitFor(() => client.replayed, 10000);
					if (!replayed) {
						return fail("the replay never finished");
					}
					const expected = `ECHO ${ctx.marker}`;
					return client.out.includes(expected)
						? { message: "the replay holds the earlier output" }
						: fail(`the replay lacks ${JSON.stringify(expected)} (replay: ${JSON.stringify(client.out.slice(-200))})`);
				},
			},
			{
				name: "7 built-in editor route",
				fn: async (ctx) => {
					const plugin = ctx.plugin;
					const client = ctx.client;
					const original = plugin.handleEdit;
					const hadOwn = Object.prototype.hasOwnProperty.call(plugin, "handleEdit");
					if (typeof original !== "function") {
						return fail("plugin.handleEdit does not exist (renamed?)");
					}
					const seen = [];
					plugin.handleEdit = function (req, reply) {
						if (req && String(req.session).startsWith(PREFIX)) {
							seen.push(req.session);
							try {
								fs.appendFileSync(req.file, "EDITED BY SMOKE\n", "utf8");
							} catch (err) {
								reply(false, errText(err));
								return;
							}
							reply(true);
							return;
						}
						return original.call(this, req, reply);
					};
					try {
						const from = client.out.length;
						client.write("\x07");
						const ok = await waitFor(() => /EDITED \d+/.test(client.out.slice(from)) && client.out.slice(from).includes("FILE FAKE PROMPT"), 20000);
						const out = client.out.slice(from);
						if (!ok) {
							return fail(`no result from the editor call (output: ${JSON.stringify(out.slice(-300))})`);
						}
						if (!/EDITED 0/.test(out)) {
							return fail(`the editor call failed (${JSON.stringify(out.slice(-200))})`);
						}
						if (!out.includes("FILE EDITED BY SMOKE")) {
							return fail("the file came back without the line the plugin side added");
						}
						if (seen.length === 0) {
							return fail("the request never reached the plugin's handleEdit");
						}
						return { message: "shim -> plugin.sock -> plugin -> reply: the added line came back" };
					} finally {
						if (hadOwn) {
							plugin.handleEdit = original;
						} else {
							delete plugin.handleEdit;
						}
					}
				},
			},
			{
				name: "8 hook and statusLine",
				fn: async (ctx) => runHookStep(ctx),
			},
			{
				name: "9 pid and listing",
				fn: async (ctx) => {
					const plugin = ctx.plugin;
					const info = (await ctx.client.sessions()).find((s) => s.id === ctx.id);
					if (!info) {
						return fail("the session is not in the daemon's list");
					}
					if (!isRunning(info)) {
						return fail(`the session has exited (code ${info.exited})`);
					}
					if (!pidAlive(info.pid)) {
						return fail(`the daemon reports pid ${info.pid}, which is not alive`);
					}
					let out;
					try {
						out = await runProgram(plugin, plugin.agentSessionsPath(), ["json", "scan"]);
					} catch (err) {
						return fail(`json scan failed: ${errText(err)}`);
					}
					if (out.includes(ctx.id)) {
						return fail("json scan lists the fake session, which writes no transcript");
					}
					return { message: `pid ${info.pid} alive; json scan does not list ${ctx.id}` };
				},
			},
			{
				name: "10 finish",
				always: true,
				fn: async (ctx) => {
					const plugin = ctx.plugin;
					const failed = ctx.failedBefore();
					if (!ctx.id || !ctx.started) {
						try {
							ctx.client && ctx.client.close();
						} catch {
							// Nothing to close.
						}
						return { message: "no session was started; nothing to finish" };
					}
					if (mode === "keep" && !failed) {
						ctx.client.close();
						ctx.kept = { id: ctx.id, marker: ctx.marker };
						return { message: `left ${ctx.id} running for the restart check`, data: ctx.kept };
					}
					let client = ctx.client;
					if (!client || client.closed) {
						client = await connectDaemon(plugin);
					}
					try {
						const did = await endSession(client, ctx.id);
						removeFiles(plugin, ctx.id);
						const left = (await client.sessions()).some((s) => s.id === ctx.id);
						return left ? fail(`${ctx.id} is still in the daemon's list`) : { message: `${did}; forgotten; work folder and status file removed${failed ? " (an earlier step failed, so nothing is kept)" : ""}` };
					} finally {
						client.close();
					}
				},
			},
		];
	}

	// ---- Step 8: the hook and the statusLine, as Claude Code runs them ----------------------

	function claudeSettingsFile() {
		const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
		return path.join(dir, "settings.json");
	}

	/** The shell Claude Code runs hook commands in: `sh -c`; on Windows Git Bash if it is there, else PowerShell. */
	function hookShell(command) {
		if (!IS_WINDOWS) {
			return { file: "/bin/sh", args: ["-c", command], name: "sh -c" };
		}
		const candidates = [
			process.env.CLAUDE_CODE_GIT_BASH_PATH,
			path.win32.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
			path.win32.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
			path.win32.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
		].filter(Boolean);
		const bash = candidates.find((c) => fs.existsSync(c));
		if (bash) {
			return { file: bash, args: ["-c", command], name: "Git Bash" };
		}
		return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command], name: "PowerShell" };
	}

	function runShell(command, payload, env, timeoutMs = 30000) {
		const shell = hookShell(command);
		return new Promise((resolve) => {
			const child = cp.spawn(shell.file, shell.args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let done = false;
			const finish = (r) => {
				if (!done) {
					done = true;
					clearTimeout(timer);
					resolve({ ...r, stdout, stderr, shell: shell.name });
				}
			};
			const timer = setTimeout(() => {
				child.kill();
				finish({ code: null, timedOut: true });
			}, timeoutMs);
			child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
			child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
			child.on("error", (err) => finish({ code: null, error: errText(err) }));
			child.on("close", (code) => finish({ code }));
			child.stdin.on("error", () => undefined);
			child.stdin.end(JSON.stringify(payload));
		});
	}

	/** The commands in Claude Code's settings that belong to Agent Sessions (others may do anything). */
	function settingsCommands(settings) {
		const stop = [];
		for (const entry of (settings.hooks && settings.hooks.Stop) || []) {
			for (const hook of (entry && entry.hooks) || []) {
				if (hook && hook.type === "command" && typeof hook.command === "string" && /agent-sessions/.test(hook.command)) {
					stop.push(hook.command);
				}
			}
		}
		const sl = settings.statusLine;
		const status = sl && typeof sl.command === "string" && /agent-sessions/.test(sl.command) ? sl.command : null;
		return { stop, status };
	}

	async function runHookStep(ctx) {
		const plugin = ctx.plugin;
		const file = claudeSettingsFile();
		let settings;
		try {
			settings = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (err) {
			return skipped(`no readable Claude Code settings (${file}: ${errText(err)})`);
		}
		const { stop, status } = settingsCommands(settings);
		if (stop.length === 0 && !status) {
			return skipped("no Agent Sessions Stop hook or statusLine in the Claude Code settings");
		}
		const env = { ...process.env, AGENT_SESSIONS_VAULT: plugin.vaultPath(), AGENT_SESSIONS_ID: ctx.id };
		const cwd = smokeWorkCwd(plugin);
		const notes = [];
		let shellName = "";
		if (stop.length) {
			const eventsLog = path.join(runtimeDir(plugin), "events.log");
			const sizeBefore = fs.existsSync(eventsLog) ? fs.statSync(eventsLog).size : 0;
			for (const command of stop) {
				const r = await runShell(command, { session_id: ctx.id, transcript_path: "", cwd, hook_event_name: "Stop", stop_hook_active: false }, env);
				shellName = r.shell;
				if (r.code !== 0) {
					return fail(`the Stop hook exited ${r.code}${r.timedOut ? " (timed out)" : ""} in ${r.shell}: ${(r.error || r.stderr || r.stdout).trim().slice(0, 300)}`);
				}
			}
			let wrote = false;
			try {
				const text = fs.readFileSync(eventsLog, "utf8");
				wrote = text.slice(sizeBefore).includes(ctx.id);
			} catch {
				wrote = false;
			}
			if (!wrote) {
				return fail(`the Stop hook ran in ${shellName} but events.log has no line for ${ctx.id}`);
			}
			notes.push(`Stop hook ok (${shellName}), events.log written`);
		} else {
			notes.push("no Stop hook");
		}
		if (status) {
			const r = await runShell(status, { session_id: ctx.id, cwd, model: { id: "smoke", display_name: "smoke" }, workspace: { current_dir: cwd, project_dir: cwd } }, env);
			shellName = r.shell;
			if (r.code !== 0) {
				return fail(`the statusLine exited ${r.code}${r.timedOut ? " (timed out)" : ""} in ${r.shell}: ${(r.error || r.stderr).trim().slice(0, 300)}`);
			}
			if (!r.stdout.trim()) {
				return fail(`the statusLine printed nothing in ${r.shell}`);
			}
			if (!fs.existsSync(statusFile(plugin, ctx.id))) {
				return fail(`the statusLine ran in ${r.shell} but wrote no status/${ctx.id}.json`);
			}
			notes.push(`statusLine ok (${r.shell}), status file written`);
		} else {
			notes.push("no statusLine");
		}
		return { message: notes.join("; ") };
	}

	// ---- verify ----------------------------------------------------------------------------

	function buildVerifySteps(opts) {
		const id = opts.id;
		const marker = opts.marker;
		return [
			{
				name: "v1 session survived the restart",
				fatal: true,
				fn: async (ctx) => {
					if (!id || !String(id).startsWith(PREFIX)) {
						return fail("no smoke session id was given");
					}
					const plugin = (ctx.plugin = await waitFor(() => {
						const p = app.plugins && app.plugins.plugins && app.plugins.plugins[PLUGIN_ID];
						return p && p.index ? p : null;
					}, 30000));
					if (!plugin) {
						return fail("the plugin did not load after the restart");
					}
					let client;
					try {
						client = ctx.client = await connectDaemon(plugin, 10, 500);
					} catch (err) {
						return fail(`the daemon is not reachable after the restart: ${errText(err)}`);
					}
					const info = (await client.sessions()).find((s) => s.id === id);
					if (!info) {
						return fail(`${id} is not in the daemon's list; the daemon or the session did not survive the restart`);
					}
					if (!isRunning(info)) {
						return fail(`${id} exited (code ${info.exited}) during the restart`);
					}
					if (!pidAlive(info.pid)) {
						return fail(`pid ${info.pid} is not alive`);
					}
					ctx.found = true;
					return { message: `running as pid ${info.pid}, daemon pid ${client.hello.pid}` };
				},
			},
			{
				name: "v2 tab reattaches with replay",
				fatal: true,
				fn: async (ctx) => {
					await ctx.plugin.openSession(id, { agent: "claude" });
					const leaf = await waitFor(() => terminalLeaf(id), 10000);
					if (!leaf) {
						return fail("no terminal tab appeared");
					}
					ctx.leaf = leaf;
					const attached = await waitFor(() => leaf.view.isAttached && leaf.view.isAttached(), 20000);
					if (!attached) {
						return fail("the tab never reported attached");
					}
					const expected = `ECHO ${marker}`;
					const shown = await waitFor(() => (screenText(leaf.view) || "").includes(expected), 10000);
					if (!shown) {
						const text = screenText(leaf.view);
						return fail(text === null ? "cannot read the tab's screen (view.terminal is not reachable)" : `the replay lacks ${JSON.stringify(expected)} (screen: ${JSON.stringify(text.slice(-200))})`);
					}
					return { message: "attached; the screen holds the earlier output" };
				},
			},
			{
				name: "v3 input after reattach",
				fn: async (ctx) => {
					const view = ctx.leaf.view;
					const line = `after-restart ${id}`;
					view.sendBytes(Buffer.from(`${line}\r`, "utf8"));
					const ok = await waitFor(() => (screenText(view) || "").includes(`ECHO ${line}`), 10000);
					return ok ? { message: "typed through the tab and echoed" } : fail(`no echo of ${JSON.stringify(line)}`);
				},
			},
			{
				name: "v4 end and clean up",
				always: true,
				fn: async (ctx) => {
					const plugin = ctx.plugin || getPlugin();
					const notes = [];
					let client = ctx.client;
					if (!client || client.closed) {
						client = await connectDaemon(plugin, 5, 500);
					}
					try {
						if (ctx.leaf && ctx.leaf.view && ctx.leaf.view.isAttached && ctx.leaf.view.isAttached()) {
							try {
								ctx.leaf.view.sendBytes(Buffer.from("exit\r", "utf8"));
								await waitFor(async () => !isRunning((await client.sessions()).find((s) => s.id === id) || { exited: 0 }), 8000);
							} catch {
								// Falls through to the kill below.
							}
						}
						const did = id && String(id).startsWith(PREFIX) ? await endSession(client, id) : "nothing to end";
						notes.push(did);
						const leaf = terminalLeaf(id);
						if (leaf) {
							leaf.detach();
							notes.push("tab closed");
						}
						if (id) {
							removeFiles(plugin, id);
						}
						const left = id ? (await client.sessions()).some((s) => s.id === id) : false;
						return left ? fail(`${id} is still in the daemon's list`) : { message: notes.join("; ") };
					} finally {
						client.close();
					}
				},
			},
		];
	}

	// ---- Entry points ----------------------------------------------------------------------

	async function guarded(label, body) {
		try {
			return await body();
		} catch (err) {
			return { steps: [{ name: label, status: "fail", ms: 0, message: errText(err) }] };
		}
	}

	/** Resolves once Obsidian has restored the workspace layout (tabs cannot be opened before), or after `ms`. */
	function layoutReady(ms = 30000) {
		const ws = app.workspace;
		if (ws.layoutReady) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), ms);
			ws.onLayoutReady(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	async function run(opts = {}) {
		return guarded("run", async () => {
			await layoutReady();
			const ctx = { kept: null };
			const defs = buildRunSteps(opts);
			let steps = [];
			// The steps' own results decide whether the finish keeps or cleans up.
			ctx.failedBefore = () => steps.some((s) => s.status === "fail");
			const results = [];
			for (const def of defs) {
				steps = results;
				const part = await runSteps([def], ctx);
				results.push(...part);
				if (part[0].status === "fail" && def.fatal) {
					// Let the remaining steps be reported as not reached, but the finish still runs.
					const rest = defs.slice(defs.indexOf(def) + 1);
					for (const next of rest) {
						if (next.always) {
							results.push(...(await runSteps([next], ctx)));
						} else {
							results.push({ name: next.name, status: "skipped", ms: 0, message: "not reached" });
						}
					}
					break;
				}
			}
			return { steps: results, kept: ctx.kept };
		});
	}

	async function verify(opts = {}) {
		return guarded("verify", async () => {
			await layoutReady();
			const ctx = {};
			return { steps: await runSteps(buildVerifySteps(opts), ctx) };
		});
	}

	/** Ends every `smoke-` session and removes its files: for when a kept session cannot be verified. */
	async function sweep() {
		return guarded("sweep", async () => {
			const defs = buildRunSteps({ mode: "cleanup" }).slice(0, 1);
			return { steps: await runSteps(defs, {}) };
		});
	}

	globalThis.__agentSessionsSmoke = { run, verify, sweep, startEnv };
})();

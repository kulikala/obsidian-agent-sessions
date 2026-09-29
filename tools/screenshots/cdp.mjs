// A minimal Chrome DevTools Protocol client over Node's built-in WebSocket: just enough to
// drive one Obsidian window (evaluate, resize, screenshot). Attaches through the browser-level
// endpoint — Obsidian's page-level endpoint accepts the socket but never answers.

export async function connectPage(port, { timeoutMs = 30000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let version = null;
	while (!version) {
		try {
			version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
		} catch {
			if (Date.now() > deadline) {
				throw new Error("Obsidian's debugging port never opened");
			}
			await sleep(300);
		}
	}
	const ws = new WebSocket(version.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error("could not open the DevTools socket"));
	});
	let seq = 0;
	const pending = new Map();
	const listeners = new Set();
	ws.onmessage = (e) => {
		const msg = JSON.parse(e.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) {
				reject(new Error(`${msg.error.message}`));
			} else {
				resolve(msg.result);
			}
		} else if (msg.method) {
			for (const fn of listeners) {
				fn(msg);
			}
		}
	};
	const send = (method, params = {}, sessionId) =>
		new Promise((resolve, reject) => {
			const id = ++seq;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params, sessionId }));
		});

	let target = null;
	while (!target) {
		const { targetInfos } = await send("Target.getTargets");
		target = targetInfos.find((t) => t.type === "page" && t.url.startsWith("app://obsidian.md/"));
		if (!target) {
			if (Date.now() > deadline) {
				throw new Error(`Obsidian's window never appeared (targets: ${targetInfos.map((t) => `${t.type} ${t.url}`).join(", ")})`);
			}
			await sleep(300);
		}
	}
	const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });

	const page = {
		/** Evaluates `expression` in the page (awaiting a returned promise) and returns its value. */
		async evaluate(expression) {
			const res = await send(
				"Runtime.evaluate",
				{ expression, returnByValue: true, awaitPromise: true },
				sessionId
			);
			if (res.exceptionDetails) {
				const d = res.exceptionDetails;
				throw new Error(d.exception?.description ?? d.text);
			}
			return res.result.value;
		},
		/** Polls `expression` until it's truthy. */
		async waitFor(expression, { timeoutMs = 20000, what = expression } = {}) {
			const until = Date.now() + timeoutMs;
			for (;;) {
				try {
					if (await page.evaluate(expression)) {
						return;
					}
				} catch {
					// The page may be mid-reload.
				}
				if (Date.now() > until) {
					throw new Error(`timed out waiting for: ${what}`);
				}
				await sleep(250);
			}
		},
		/** Lays the page out at exactly `width`×`height` CSS pixels, rendered at `scale`, whatever
		 * the real window's size or display — so every run produces the same image. */
		async setViewport(width, height, scale = 2) {
			await send(
				"Emulation.setDeviceMetricsOverride",
				{ width, height, deviceScaleFactor: scale, mobile: false },
				sessionId
			);
		},
		/** A PNG of the whole window, as a Buffer. */
		async screenshot() {
			const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
			return Buffer.from(data, "base64");
		},
		/** Collects `console.error`/exceptions from the page, for the end-of-run report. */
		async collectErrors(sink) {
			await send("Runtime.enable", {}, sessionId);
			listeners.add((msg) => {
				if (msg.sessionId !== sessionId) {
					return;
				}
				if (msg.method === "Runtime.exceptionThrown") {
					sink.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
				} else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
					sink.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
				}
			});
		},
		close() {
			ws.close();
		},
	};
	return page;
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

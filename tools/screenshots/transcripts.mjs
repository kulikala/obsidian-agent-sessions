// What each terminal tab shows: ANSI text in the style of Claude Code's and Codex's own TUIs,
// replayed by the sandbox daemon when a tab attaches. Rendered to the tab's actual width.

const ESC = "\x1b[";
const reset = `${ESC}0m`;
const rgb = (r, g, b) => (s) => `${ESC}38;2;${r};${g};${b}m${s}${reset}`;
const bg = (r, g, b) => (s) => `${ESC}48;2;${r};${g};${b}m${s}${reset}`;
const bold = (s) => `${ESC}1m${s}${reset}`;
const dim = (s) => `${ESC}2m${s}${reset}`;

const orange = rgb(215, 119, 87);
const green = rgb(78, 186, 101);
const red = rgb(255, 107, 128);
const cyan = rgb(86, 182, 194);
const gray = rgb(153, 153, 153);
const added = bg(34, 70, 44);
const removed = bg(86, 34, 40);

/** Visible width of a line (ANSI escapes stripped). */
function width(s) {
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(s, n) {
	return s + " ".repeat(Math.max(0, n - width(s)));
}

function box(lines, w) {
	const inner = w - 4;
	return [
		dim(`╭${"─".repeat(w - 2)}╮`),
		...lines.map((l) => `${dim("│")} ${pad(l, inner)} ${dim("│")}`),
		dim(`╰${"─".repeat(w - 2)}╯`),
	];
}

// ---- Claude Code ------------------------------------------------------------------------

function claudeHeader(model, dir) {
	return [
		`${orange(" ▐▛███▜▌")}   ${bold("Claude Code")}`,
		`${orange("▝▜█████▛▘")}  ${gray(`${model} · Claude Max`)}`,
		`${orange("  ▘▘ ▝▝")}    ${gray(dir)}`,
		"",
	];
}

function claudePrompt(text) {
	return [`${gray(">")} ${text}`, ""];
}

function claudeInput(cols, hint = "? for shortcuts") {
	const rule = dim("─".repeat(cols));
	return [rule, `${gray(">")} `, rule, `  ${dim(hint)}`];
}

const dot = "⏺";

function tool(name, arg, results) {
	return [`${green(dot)} ${bold(name)}(${arg})`, ...results.map((r, i) => `  ${i === 0 ? dim("⎿") : " "}  ${r}`), ""];
}

function say(...lines) {
	return [...lines.map((l, i) => (i === 0 ? `${dot} ${l}` : `  ${l}`)), ""];
}

function claudeCheckout(cols) {
	return [
		...claudeHeader("Opus 5.5", "~/code/storefront"),
		...claudePrompt("Run the checkout e2e tests and summarize any failures."),
		...tool("Bash", "npm run e2e -- checkout", [
			`${red("✗")} coupon › total updates as soon as a coupon is applied`,
			`${green("23 passed")}, ${red("1 failed")} ${gray("(1m 48s)")}`,
		]),
		...say(
			"One failure: right after a coupon is applied, the total briefly shows the old amount",
			"before settling. Everything else in the checkout flow passes."
		),
		...claudePrompt("The checkout page flashes the old total after a coupon is applied. Fix it and add a regression test."),
		...say("I'll look at how the cart total is derived after a coupon is applied."),
		...tool("Search", 'pattern: "applyCoupon", path: "src"', ["Found 4 files"]),
		...tool("Read", "src/checkout/useCartTotal.ts", ["Read 86 lines"]),
		...say(
			"The total comes from a memo that depends on `cart.items` but not on `cart.coupon`,",
			"so the previous total renders for one frame after the coupon lands."
		),
		...tool("Update", "src/checkout/useCartTotal.ts", [
			"Updated src/checkout/useCartTotal.ts with 1 addition and 1 removal",
			`${gray("39")}      const discount = coupon ? coupon.apply(subtotal) : 0;`,
			`${gray("40")}      return subtotal - discount + shipping;`,
			removed(pad("41  -   }, [cart.items]);", 60)),
			added(pad("41  +   }, [cart.items, cart.coupon]);", 60)),
		]),
		...tool("Write", "src/checkout/__tests__/useCartTotal.test.ts", ["Wrote 38 lines to src/checkout/__tests__/useCartTotal.test.ts"]),
		...tool("Bash", "npm test -- useCartTotal", [
			`${green("PASS")}  src/checkout/__tests__/useCartTotal.test.ts`,
			`  ${green("✓")} recomputes the total when a coupon is applied ${gray("(12 ms)")}`,
			`  ${green("✓")} keeps the total stable when the coupon is removed ${gray("(4 ms)")}`,
		]),
		`${orange("✻")} ${orange("Running the full checkout suite…")} ${gray("(esc to interrupt · 42s · ↓ 1.8k tokens)")}`,
		"",
		...claudeInput(cols),
	];
}

function claudeDocs(cols) {
	return [
		...claudeHeader("Sonnet 5", "~/code/docs-site"),
		...claudePrompt("Draft the v3 → v4 migration guide from the changelog. Keep it to one page."),
		...tool("Read", "CHANGELOG.md", ["Read 214 lines"]),
		...tool("Write", "docs/migrate-to-v4.md", ["Wrote 96 lines to docs/migrate-to-v4.md"]),
		...say(
			"Done: `docs/migrate-to-v4.md` covers the three breaking changes —",
			"the renamed config keys, the new auth header, and the dropped Node 18 support —",
			"each with a before/after snippet."
		),
		...claudeInput(cols),
	];
}

function claudeInfra(cols) {
	return [
		...claudeHeader("Opus 5.5", "~/code/infra"),
		...claudePrompt("/compact"),
		`${dim("⎿")}  ${gray("Compacted. ctrl+o to see full summary")}`,
		"",
		...claudeInput(cols),
	];
}

// ---- Codex -------------------------------------------------------------------------------

function codexHeader(cols, model, effort, dir) {
	const w = Math.min(cols, 58);
	return [
		...box(
			[
				`${bold(">_ OpenAI Codex")}`,
				"",
				`${gray("model:")}     ${model} ${effort}   ${cyan("/model")} ${gray("to change")}`,
				`${gray("directory:")} ${dir}`,
			],
			w
		),
		"",
	];
}

function codexPrompt(cols, text) {
	const line = ` ${bold("›")} ${text}`;
	const shade = bg(40, 40, 40);
	return [shade(pad("", cols)), shade(pad(line, cols)), shade(pad("", cols)), ""];
}

function bullet(first, ...rest) {
	return [`${gray("•")} ${first}`, ...rest.map((l) => `  ${l}`), ""];
}

function codexFooter(cols, left) {
	return ["", `  ${dim(left)}`];
}

function codexLimiter(cols) {
	return [
		...codexHeader(cols, "gpt-5.5", "high", "~/code/billing-api"),
		...codexPrompt(cols, "Where is the rate limiter configured?"),
		...bullet(bold("Explored"), `${dim("└")} ${cyan("Search")} ratelimit in cmd, internal`, `  ${cyan("Read")} config.go`),
		...bullet(
			"Limits are set per API key in internal/ratelimit/config.go (100 req/s, burst 200),",
			"and the middleware is wired up in cmd/server/main.go."
		),
		...codexPrompt(cols, "Add tests for the token-bucket rate limiter, including the burst case."),
		...bullet(bold("Explored"), `${dim("└")} ${cyan("Read")} limiter.go, limiter_test.go`, `  ${cyan("Search")} Burst in internal/ratelimit`),
		...bullet("I'll add table-driven tests covering refill, burst, and concurrent access."),
		...bullet(
			`${bold("Edited")} internal/ratelimit/limiter_test.go ${green("(+64")} ${red("-0)")}`,
			`${gray("   12")} ${green("+func TestBucket_Burst(t *testing.T) {")}`,
			`${gray("   13")} ${green("+\tb := NewBucket(10, time.Second)")}`,
			`${gray("   14")} ${green("+\tfor i := 0; i < 10; i++ {")}`
		),
		`  ${bold("Would you like to run the following command?")}`,
		"",
		`  ${gray("$")} go test -race ./internal/ratelimit/...`,
		"",
		`${cyan("›")} ${cyan("1. Yes, proceed")}`,
		"  2. Yes, and don't ask again for this command",
		`  3. No, and tell Codex what to do differently ${dim("esc")}`,
		"",
		`  ${dim("Press enter to confirm or esc to cancel")}`,
	];
}

function codexSync(cols) {
	return [
		...codexHeader(cols, "gpt-5.5", "medium", "~/code/mobile-app"),
		...codexPrompt(cols, "Queue writes while offline and replay them in order when the connection comes back."),
		...bullet(bold("Explored"), `${dim("└")} ${cyan("Read")} sync/store.ts, sync/api.ts`),
		...bullet(`${bold("Edited")} 3 files ${green("(+148")} ${red("-22)")}`),
		...bullet(`${bold("Ran")} npm test -- sync`, `${dim("└")} ${green("18 passed")}`),
		...bullet(
			"Writes now go through an outbox table. Replay is ordered by sequence number and",
			"idempotent per request id, so a retry after a dropped response can't double-apply."
		),
		`${dim("─ Worked for 3m 12s " + "─".repeat(Math.max(0, cols - 22)))}`,
		"",
		...codexPrompt(cols, dim("Ask Codex to do anything")),
		...codexFooter(cols, "? for shortcuts"),
	];
}

const TRANSCRIPTS = {
	"claude-checkout": claudeCheckout,
	"claude-docs": claudeDocs,
	"claude-infra": claudeInfra,
	"codex-limiter": codexLimiter,
	"codex-sync": codexSync,
};

/** The bytes a tab gets on attach: an optional OSC 0 title, then the transcript. */
export function renderTranscript(key, cols, title) {
	const lines = TRANSCRIPTS[key] ? TRANSCRIPTS[key](cols) : [];
	const head = title ? `\x1b]0;${title}\x07` : "";
	return head + lines.join("\r\n");
}

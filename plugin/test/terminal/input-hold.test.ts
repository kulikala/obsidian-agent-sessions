import { describe, expect, it } from "vitest";
import { InputHold } from "../../src/terminal/input-hold";

const bytes = (s: string) => Buffer.from(s, "utf8");

describe("InputHold", () => {
	it("writes input at once when nothing holds it", () => {
		const out: string[] = [];
		const hold = new InputHold((b) => out.push(b.toString()));
		hold.input(bytes("a"));
		expect(out).toEqual(["a"]);
		expect(hold.held).toBe(false);
	});

	it("keeps input in order while held and writes it on the last release", () => {
		const out: string[] = [];
		const hold = new InputHold((b) => out.push(b.toString()));
		const first = hold.hold();
		const second = hold.hold();
		hold.input(bytes("he"));
		hold.input(bytes("llo"));
		first();
		first();
		expect(out).toEqual([]);
		second();
		expect(out).toEqual(["he", "llo"]);
		hold.input(bytes("!"));
		expect(out).toEqual(["he", "llo", "!"]);
	});

	it("lets a waiter go once nothing holds input", async () => {
		const hold = new InputHold(() => undefined);
		await hold.free();
		const release = hold.hold();
		let freed = false;
		const waiting = hold.free().then(() => (freed = true));
		await Promise.resolve();
		expect(freed).toBe(false);
		release();
		await waiting;
		expect(freed).toBe(true);
	});
});

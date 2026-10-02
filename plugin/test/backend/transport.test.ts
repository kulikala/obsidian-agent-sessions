import { describe, expect, it } from "vitest";
import { parseEndpoint, TokenGate } from "../../src/backend/transport";

describe("parseEndpoint", () => {
	it("reads port and token, rejecting anything malformed", () => {
		expect(parseEndpoint('{"port": 5000, "token": "ab", "pid": 1}')).toEqual({ port: 5000, token: "ab" });
		expect(parseEndpoint('{"port": "5000", "token": "ab"}')).toBeNull();
		expect(parseEndpoint('{"port": 5000}')).toBeNull();
		expect(parseEndpoint("not json")).toBeNull();
	});
});

describe("TokenGate", () => {
	const token = "0123456789abcdef0123456789abcdef";
	it("passes everything when there is no token", () => {
		const gate = new TokenGate(null);
		expect(gate.feed(Buffer.from("x"))).toEqual({ state: true, rest: Buffer.from("x") });
	});
	it("waits for the whole line, then hands over what follows it", () => {
		const gate = new TokenGate(token);
		expect(gate.feed(Buffer.from(token.slice(0, 10))).state).toBeNull();
		const { state, rest } = gate.feed(Buffer.from(`${token.slice(10)}\nJ...`));
		expect(state).toBe(true);
		expect(rest.toString()).toBe("J...");
		expect(gate.passed).toBe(true);
	});
	it("rejects a wrong token", () => {
		const gate = new TokenGate(token);
		expect(gate.feed(Buffer.from(`${"f".repeat(32)}\n`)).state).toBe(false);
	});
});

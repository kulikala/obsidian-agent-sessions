import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

describe("styles.css", () => {
	it("has balanced braces, so no rule swallows the ones after it", () => {
		const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		let depth = 0;
		for (const ch of css) {
			if (ch === "{") depth++;
			if (ch === "}") depth--;
			expect(depth).toBeGreaterThanOrEqual(0);
		}
		expect(depth).toBe(0);
	});
});

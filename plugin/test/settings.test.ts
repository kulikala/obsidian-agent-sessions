import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings";

describe("DEFAULT_SETTINGS", () => {
	it("§6.9 の既定値を持つ", () => {
		expect(DEFAULT_SETTINGS).toEqual({
			fontFamily: 'Menlo, "Hiragino Sans", monospace',
			fontSize: 13,
			padding: "comfortable",
			recentCount: 10,
			notifyOnIdle: true,
			claudePath: "",
			agentSessionsPath: "",
			pythonPath: "/usr/bin/python3",
			scrollback: 5000,
			editorHeight: 40,
		});
	});
});

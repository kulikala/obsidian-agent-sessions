import { describe, expect, it } from "vitest";
import { remoteControlAtStartup, resumeConnectsRemoteControl, transcriptHasRemoteControl } from "../../src/sessions/remote-control";

describe("remoteControlAtStartup", () => {
	it("is true only for remoteControlAtStartup: true", () => {
		expect(remoteControlAtStartup('{"remoteControlAtStartup": true}')).toBe(true);
		expect(remoteControlAtStartup('{"remoteControlAtStartup": false}')).toBe(false);
		expect(remoteControlAtStartup('{"remoteControlAtStartup": "true"}')).toBe(false);
		expect(remoteControlAtStartup("{}")).toBe(false);
		expect(remoteControlAtStartup("{not json")).toBe(false);
		expect(remoteControlAtStartup(null)).toBe(false);
	});
});

describe("transcriptHasRemoteControl", () => {
	it("finds a bridge-session line", () => {
		const line = '{"type":"bridge-session","sessionId":"a","bridgeSessionId":"cse_1","lastSequenceNum":0}';
		expect(transcriptHasRemoteControl(`{"type":"user"}\n${line}\n`)).toBe(true);
		expect(transcriptHasRemoteControl('{"type":"custom-title","customTitle":"bridge-session"}\n')).toBe(false);
		expect(transcriptHasRemoteControl(null)).toBe(false);
	});
});

describe("resumeConnectsRemoteControl", () => {
	it("holds when either the setting or the transcript says so", () => {
		const bridge = '{"type":"bridge-session","bridgeSessionId":"cse_1"}';
		expect(resumeConnectsRemoteControl('{"remoteControlAtStartup": true}', null)).toBe(true);
		expect(resumeConnectsRemoteControl(null, bridge)).toBe(true);
		expect(resumeConnectsRemoteControl("{}", '{"type":"user"}')).toBe(false);
	});
});

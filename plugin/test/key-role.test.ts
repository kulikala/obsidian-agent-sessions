import { describe, expect, it } from "vitest";
import { classifyEnter, deriveKeysFromKeybindings, resolveEnterAction, type KeyLike } from "../src/keys";
import type { NewlineKey, SubmitKey } from "../src/settings";

function key(overrides: Partial<KeyLike> = {}): KeyLike {
	return {
		key: "Enter",
		shiftKey: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		...overrides,
	};
}

describe("classifyEnter", () => {
	it("Enter 以外は passthrough", () => {
		expect(classifyEnter(key({ key: "a" }))).toBe("passthrough");
	});

	it("IME 変換中（isComposing）は passthrough", () => {
		expect(classifyEnter(key({ isComposing: true }))).toBe("passthrough");
	});

	it("IME 変換中（keyCode 229）は passthrough", () => {
		expect(classifyEnter(key({ keyCode: 229 }))).toBe("passthrough");
	});

	it("無修飾 Enter は enter", () => {
		expect(classifyEnter(key())).toBe("enter");
	});

	it("Shift+Enter は shift+enter", () => {
		expect(classifyEnter(key({ shiftKey: true }))).toBe("shift+enter");
	});

	it("Option/Alt+Enter は meta+enter", () => {
		expect(classifyEnter(key({ altKey: true }))).toBe("meta+enter");
	});

	it("Ctrl+Enter は ctrl+enter", () => {
		expect(classifyEnter(key({ ctrlKey: true }))).toBe("ctrl+enter");
	});

	it("Cmd/Meta+Enter は super+enter", () => {
		expect(classifyEnter(key({ metaKey: true }))).toBe("super+enter");
	});

	it("複数修飾は shift・alt・ctrl・meta の優先順で 1 つに決まる", () => {
		expect(classifyEnter(key({ shiftKey: true, altKey: true }))).toBe("shift+enter");
		expect(classifyEnter(key({ altKey: true, ctrlKey: true }))).toBe("meta+enter");
		expect(classifyEnter(key({ ctrlKey: true, metaKey: true }))).toBe("ctrl+enter");
	});
});

describe("resolveEnterAction", () => {
	const settings = (newlineKey: NewlineKey, submitKey: SubmitKey = "super+enter") => ({ newlineKey, submitKey });

	it("passthrough はそのまま passthrough", () => {
		expect(resolveEnterAction("passthrough", settings("shift+enter"))).toBe("passthrough");
	});

	it("修飾つきの Enter が newlineKey に一致すれば newline", () => {
		expect(resolveEnterAction("shift+enter", settings("shift+enter"))).toBe("newline");
		expect(resolveEnterAction("meta+enter", settings("meta+enter"))).toBe("newline");
		expect(resolveEnterAction("ctrl+enter", settings("ctrl+enter"))).toBe("newline");
		expect(resolveEnterAction("super+enter", settings("super+enter"))).toBe("newline");
	});

	it("無修飾 Enter で newlineKey が enter でなければ submit", () => {
		expect(resolveEnterAction("enter", settings("shift+enter"))).toBe("submit");
	});

	it("無修飾 Enter で newlineKey が enter なら raw-enter（keybindings.json 側で改行になる）", () => {
		expect(resolveEnterAction("enter", settings("enter"))).toBe("raw-enter");
	});

	it("newlineKey が enter のとき、submitKey に一致すれば submit", () => {
		expect(resolveEnterAction("super+enter", settings("enter", "super+enter"))).toBe("submit");
		expect(resolveEnterAction("meta+enter", settings("enter", "meta+enter"))).toBe("submit");
	});

	it("newlineKey が enter のとき、submitKey に一致しない修飾つき Enter は passthrough", () => {
		expect(resolveEnterAction("ctrl+enter", settings("enter", "super+enter"))).toBe("passthrough");
	});

	it("newlineKey に一致しない修飾つき Enter は passthrough（従来どおりの扱いに委ねる）", () => {
		expect(resolveEnterAction("ctrl+enter", settings("shift+enter"))).toBe("passthrough");
	});
});

describe("deriveKeysFromKeybindings", () => {
	const settings = (newlineKey: NewlineKey, submitKey: SubmitKey = "super+enter") => ({ newlineKey, submitKey });

	it("実機の例：enter/meta+enter/cmd+enter が chat:newline/chat:submit なら enter・super+enter を導く", () => {
		const chatBindings = { enter: "chat:newline", "meta+enter": "chat:submit", "cmd+enter": "chat:submit" };
		expect(deriveKeysFromKeybindings(chatBindings, settings("shift+enter"))).toEqual({
			newlineKey: "enter",
			submitKey: "super+enter",
		});
	});

	it("cmd+enter が無く meta+enter だけあれば meta+enter を導く", () => {
		const chatBindings = { enter: "chat:newline", "meta+enter": "chat:submit" };
		expect(deriveKeysFromKeybindings(chatBindings, settings("shift+enter"))).toEqual({
			newlineKey: "enter",
			submitKey: "meta+enter",
		});
	});

	it("super+enter という鍵名でも cmd+enter と同様に扱う", () => {
		const chatBindings = { enter: "chat:newline", "super+enter": "chat:submit" };
		expect(deriveKeysFromKeybindings(chatBindings, settings("shift+enter"))).toEqual({
			newlineKey: "enter",
			submitKey: "super+enter",
		});
	});

	it("どちらも無ければ既定の super+enter", () => {
		const chatBindings = { enter: "chat:newline" };
		expect(deriveKeysFromKeybindings(chatBindings, settings("shift+enter"))).toEqual({
			newlineKey: "enter",
			submitKey: "super+enter",
		});
	});

	it("newline モードで既に設定が一致していれば null（変更不要）", () => {
		const chatBindings = { enter: "chat:newline", "cmd+enter": "chat:submit" };
		expect(deriveKeysFromKeybindings(chatBindings, settings("enter", "super+enter"))).toBeNull();
	});

	it("enter が無ければ submit 扱い：設定が enter のままなら shift+enter に戻す", () => {
		expect(deriveKeysFromKeybindings(undefined, settings("enter"))).toEqual({
			newlineKey: "shift+enter",
			submitKey: "super+enter",
		});
		expect(deriveKeysFromKeybindings({}, settings("enter", "meta+enter"))).toEqual({
			newlineKey: "shift+enter",
			submitKey: "meta+enter",
		});
	});

	it("enter が chat:submit でも submit 扱い", () => {
		const chatBindings = { enter: "chat:submit" };
		expect(deriveKeysFromKeybindings(chatBindings, settings("enter"))).toEqual({
			newlineKey: "shift+enter",
			submitKey: "super+enter",
		});
	});

	it("submit 扱いで設定が既に enter 以外なら null（変更不要）", () => {
		expect(deriveKeysFromKeybindings(undefined, settings("shift+enter"))).toBeNull();
		expect(deriveKeysFromKeybindings({ enter: "chat:submit" }, settings("ctrl+enter"))).toBeNull();
	});
});

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setLang, t, type MessageKey } from "../../src/i18n";
import { dialogTitle, stripEllipsis } from "../../src/ui/dialog-title";

afterEach(() => setLang("en"));

const SRC = path.join(__dirname, "..", "..", "src");

function read(file: string): string {
	return fs.readFileSync(path.join(SRC, file), "utf8");
}

function sourceFiles(dir = SRC): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			return e.name === "locales" ? [] : sourceFiles(full);
		}
		return e.name.endsWith(".ts") ? [path.relative(SRC, full)] : [];
	});
}

/** Every dialog opened from a labelled item: the key its title and its openers share, and the
 * files whose menu items, commands or buttons open it. */
const DIALOGS: { dialog: string; key: MessageKey; openers: string[] }[] = [
	{ dialog: "New session", key: "action.newSession", openers: ["main.ts", "views/side.ts", "views/manager.ts"] },
	{ dialog: "Rename", key: "action.rename", openers: ["views/rows-render.ts", "views/terminal.ts"] },
	{ dialog: "Move to category", key: "action.moveToCategory", openers: ["views/rows-render.ts"] },
	{ dialog: "Suggest name and category", key: "action.suggestNameCategory", openers: ["views/rows-render.ts"] },
	{ dialog: "Change model", key: "action.changeModel", openers: ["views/rows-render.ts"] },
	{ dialog: "Organize names and categories", key: "action.organize", openers: ["views/side.ts", "views/manager.ts"] },
	{ dialog: "Stretch your usage limit", key: "action.analyzeEfficiency", openers: ["main.ts", "views/side.ts", "views/manager.ts"] },
	{ dialog: "Ask the agent to fix it", key: "efficiency.action.agent", openers: ["ui/efficiency-modal.ts"] },
	{ dialog: "End session", key: "action.endSession", openers: ["views/rows-render.ts"] },
	{ dialog: "Restart session", key: "action.restartSession", openers: ["views/rows-render.ts"] },
	{ dialog: "Session analytics", key: "action.usage", openers: ["views/rows-render.ts", "views/terminal.ts"] },
	{ dialog: "Install", key: "action.installBackend", openers: ["main.ts", "views/side.ts", "ui/onboarding-modal.ts"] },
	{ dialog: "Reinstall", key: "action.reinstall", openers: ["main.ts"] },
	{ dialog: "Remove agent-sessions", key: "action.uninstallBackend", openers: ["main.ts"] },
];

/** The welcome guide opens by itself (first run, update) as well as from two commands that say
 * where in it to start; its title is the guide's name. */
const EXCEPTIONS: MessageKey[] = ["onboarding.title"];

/** Keys in a title position: `dialogTitle("k")`, `dialogHeaderSpec(x, "k", …)`, an install
 * dialog's title key, and a title set straight from a message. */
const TITLE_PATTERNS = [
	/dialogTitle\("([\w.]+)"\)/g,
	/dialogHeaderSpec\([^,]+,\s*"([\w.]+)"/g,
	/titleKey: MessageKey = "([\w.]+)"/g,
	/openInstallBackend\([^;]*?"([\w.]+)"\)/g,
	/(?:titleEl\.setText|this\.setTitle|modal\.setTitle)\(t\("([\w.]+)"\)\)/g,
];

function titleKeys(): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const file of sourceFiles()) {
		const text = read(file);
		for (const re of TITLE_PATTERNS) {
			for (const m of text.matchAll(re)) {
				found.set(m[1], [...(found.get(m[1]) ?? []), file]);
			}
		}
	}
	return found;
}

function opensWith(text: string, key: string): boolean {
	const k = key.replace(/\./g, "\\.");
	return new RegExp(
		`(?:setTitle|setButtonText)\\(t\\("${k}"\\)|name: t\\("${k}"\\)|text: t\\("${k}"\\)|iconButton\\([^;]*?t\\("${k}"\\)`
	).test(text);
}

describe("stripEllipsis", () => {
	it("drops a trailing ellipsis and nothing else", () => {
		expect(stripEllipsis("Move to category…")).toBe("Move to category");
		expect(stripEllipsis("カテゴリに移動…")).toBe("カテゴリに移動");
		expect(stripEllipsis("Change model...")).toBe("Change model");
		expect(stripEllipsis("Other… later")).toBe("Other… later");
		expect(stripEllipsis("Rename")).toBe("Rename");
	});
});

describe("dialog titles", () => {
	it("are the label of the item that opens the dialog, in every language", () => {
		for (const lang of ["en", "ja"] as const) {
			setLang(lang);
			for (const { key } of DIALOGS) {
				expect(dialogTitle(key)).toBe(stripEllipsis(t(key)));
				expect(dialogTitle(key)).not.toBe("");
			}
		}
	});

	it("come only from the keys in the table (a new dialog adds its row)", () => {
		const keys = [...titleKeys().keys()].sort();
		expect(keys).toEqual([...DIALOGS.map((d) => d.key), ...EXCEPTIONS].sort());
	});

	it("are never set straight from a message key, except the welcome guide", () => {
		const direct = /(?:titleEl\.setText|this\.setTitle|modal\.setTitle)\(t\("([\w.]+)"\)\)/g;
		const keys = sourceFiles().flatMap((f) => [...read(f).matchAll(direct)].map((m) => m[1]));
		expect([...new Set(keys)]).toEqual(EXCEPTIONS);
	});

	it.each(DIALOGS)("$dialog: every opener is labelled with the title's key", ({ key, openers }) => {
		for (const file of openers) {
			expect(opensWith(read(file), key), `${file} opens with ${key}`).toBe(true);
		}
	});
});

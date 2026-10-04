import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ONBOARDING_SCENES } from "../src/ui/onboarding-model";

const REPO = resolve(__dirname, "..", "..");

/** The shooting tool's scene reader, loaded by path: it lives outside the plugin's TypeScript project. */
async function loadScenes(): Promise<{ LANGUAGES: string[]; readOnboardingScenes(): string[] }> {
	return (await import(pathToFileURL(join(REPO, "tools", "screenshots", "scenes.mjs")).href)) as never;
}

describe("onboarding screenshots", () => {
	it("has an image for every scene in both languages", () => {
		const missing: string[] = [];
		for (const lang of ["en", "ja"]) {
			for (const scene of ONBOARDING_SCENES) {
				const path = join("docs", "onboarding", lang, `${scene}.png`);
				if (!existsSync(join(REPO, path))) {
					missing.push(path);
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it("is shot from the same scene list the guide uses", async () => {
		const { LANGUAGES, readOnboardingScenes } = await loadScenes();
		expect(readOnboardingScenes()).toEqual([...ONBOARDING_SCENES]);
		expect(LANGUAGES).toEqual(["en", "ja"]);
	});
});

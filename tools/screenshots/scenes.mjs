// The onboarding scene list, read from the model's source so the guide, the shooting script and
// the test share one list (`ONBOARDING_SCENES` in plugin/src/ui/onboarding-model.ts). Parsing the
// array literal keeps this free of a TypeScript build; it fails loudly if the literal changes
// shape, and plugin/test/onboarding-images.test.ts compares the result with the real constant.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL = join(REPO, "plugin", "src", "ui", "onboarding-model.ts");

export const LANGUAGES = ["en", "ja"];

export function readOnboardingScenes() {
	const source = readFileSync(MODEL, "utf8");
	const match = /export const ONBOARDING_SCENES[^=]*=\s*\[([^\]]*)\]/.exec(source);
	if (!match) {
		throw new Error(`ONBOARDING_SCENES not found in ${MODEL}`);
	}
	const body = match[1].replace(/\/\/.*$/gm, "");
	const scenes = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	if (scenes.length === 0) {
		throw new Error(`ONBOARDING_SCENES in ${MODEL} has no scenes`);
	}
	return scenes;
}

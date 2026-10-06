// Labels for the model and effort dropdowns (the Change model dialog and the built-in editor's bar).

import { t } from "../i18n";
import { EFFORT_AUTO } from "../terminal/model-switch";

/** The label a `/model` alias shows in the dropdowns (also used by the built-in editor's bar). */
export function modelAliasLabel(alias: string): string {
	switch (alias) {
		case "default":
			return t("model.alias.default");
		case "best":
			return t("model.alias.best");
		case "opusplan":
			return t("model.alias.opusplan");
		default:
			// Family names and the [1m] variants read the same in every language.
			return alias.charAt(0).toUpperCase() + alias.slice(1).replace("[1m]", " (1M)");
	}
}

/** A shorter label for narrow dropdowns (the built-in editor's bar); the full `modelAliasLabel`
 * goes in the option's tooltip. */
export function modelAliasShortLabel(alias: string): string {
	switch (alias) {
		case "best":
			return t("model.alias.bestShort");
		case "opusplan":
			return "Opus Plan";
		default:
			return modelAliasLabel(alias);
	}
}

/** The label an effort level shows in the dropdowns. */
export function effortLabel(level: string): string {
	return level === EFFORT_AUTO ? t("effort.auto") : level;
}

/** Adds grouped options to a dropdown through `add`, with a line between one group and the next. */
export function addGroups(select: HTMLSelectElement, groups: readonly (readonly string[])[], add: (value: string) => void): void {
	groups.forEach((values, i) => {
		if (i > 0) {
			select.createEl("hr");
		}
		values.forEach(add);
	});
}

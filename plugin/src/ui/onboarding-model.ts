// The welcome guide's logic, kept free of `obsidian` so it can be tested in plain Node: when it is
// shown, which pages it has, and what the install page reports.

import type { MessageKey } from "../i18n";

export type OnboardingPageId = "about" | "usage" | "install" | "settings";

/** The pages, in order. */
export const ONBOARDING_PAGES: readonly OnboardingPageId[] = ["about", "usage", "install", "settings"];

/**
 * Whether the guide opens by itself at startup. It does on first install (nothing recorded yet),
 * and after an update when the user keeps "Show this guide after updates" on; an unchanged
 * version never reopens it.
 */
export function shouldShowOnboarding(shownVersion: string, currentVersion: string, onUpdate: boolean): boolean {
	if (shownVersion === "") {
		return true;
	}
	return shownVersion !== currentVersion && onUpdate;
}

export interface OnboardingNav {
	/** 1-based, for the step indicator ("2 / 4"). */
	step: number;
	total: number;
	hasBack: boolean;
	/** The last page swaps Next for Done. */
	isLast: boolean;
}

/** Back/Next/Done state for the page at `index` (clamped into range). */
export function onboardingNav(index: number, total = ONBOARDING_PAGES.length): OnboardingNav {
	const i = Math.min(Math.max(index, 0), total - 1);
	return { step: i + 1, total, hasBack: i > 0, isLast: i === total - 1 };
}

/** The page index after Back (`-1`) or Next (`+1`), staying inside the pages. */
export function stepPage(index: number, delta: -1 | 1, total = ONBOARDING_PAGES.length): number {
	return Math.min(Math.max(index + delta, 0), total - 1);
}

export interface UsageItem {
	/** A lucide icon id. */
	icon: string;
	title: MessageKey;
	body: MessageKey;
}

/** The "Using sessions" page's items. The editor item's text takes the current editor key as `{key}`. */
export const USAGE_ITEMS: readonly UsageItem[] = [
	{ icon: "terminal", title: "onboarding.usage.input.title", body: "onboarding.usage.input.body" },
	{ icon: "pencil", title: "onboarding.usage.rename.title", body: "onboarding.usage.rename.body" },
	{ icon: "folder-input", title: "onboarding.usage.category.title", body: "onboarding.usage.category.body" },
	{ icon: "square-pen", title: "onboarding.usage.editor.title", body: "onboarding.usage.editor.body" },
	{ icon: "gauge", title: "onboarding.usage.limits.title", body: "onboarding.usage.limits.body" },
];

export type InstallPageState = { kind: "installed"; path: string } | { kind: "missing" };

/**
 * What the install page shows. The one place that decides it, so a platform with more
 * prerequisites (Windows) can extend the states here without touching the page's rendering.
 */
export function installPageState(backendAvailable: boolean, programPath: string): InstallPageState {
	return backendAvailable ? { kind: "installed", path: programPath } : { kind: "missing" };
}

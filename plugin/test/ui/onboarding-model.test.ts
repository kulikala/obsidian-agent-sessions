import { describe, expect, it } from "vitest";
import {
	installPageState,
	ONBOARDING_PAGES,
	onboardingNav,
	shouldShowOnboarding,
	stepPage,
	USAGE_ITEMS,
} from "../../src/ui/onboarding-model";

describe("shouldShowOnboarding", () => {
	it("shows on first install", () => {
		expect(shouldShowOnboarding("", "0.5.0", true)).toBe(true);
		expect(shouldShowOnboarding("", "0.5.0", false)).toBe(true);
	});

	it("shows after an update only when the user keeps it on", () => {
		expect(shouldShowOnboarding("0.4.0", "0.5.0", true)).toBe(true);
		expect(shouldShowOnboarding("0.4.0", "0.5.0", false)).toBe(false);
	});

	it("does not reopen for an unchanged version", () => {
		expect(shouldShowOnboarding("0.5.0", "0.5.0", true)).toBe(false);
	});
});

describe("onboarding navigation", () => {
	it("has no Back on the first page and Done on the last", () => {
		expect(onboardingNav(0)).toEqual({ step: 1, total: ONBOARDING_PAGES.length, hasBack: false, isLast: false });
		const last = onboardingNav(ONBOARDING_PAGES.length - 1);
		expect(last.hasBack).toBe(true);
		expect(last.isLast).toBe(true);
	});

	it("clamps out-of-range indexes", () => {
		expect(onboardingNav(-3).step).toBe(1);
		expect(onboardingNav(99).step).toBe(ONBOARDING_PAGES.length);
	});

	it("steps within the pages", () => {
		expect(stepPage(0, -1)).toBe(0);
		expect(stepPage(0, 1)).toBe(1);
		expect(stepPage(ONBOARDING_PAGES.length - 1, 1)).toBe(ONBOARDING_PAGES.length - 1);
	});
});

describe("page content", () => {
	it("lists the five usage items", () => {
		expect(USAGE_ITEMS).toHaveLength(5);
	});

	it("reports the install state", () => {
		expect(installPageState(true, "/x/agent-sessions")).toEqual({ kind: "installed", path: "/x/agent-sessions" });
		expect(installPageState(false, "/x/agent-sessions")).toEqual({ kind: "missing" });
	});
});

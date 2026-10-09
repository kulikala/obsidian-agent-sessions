import { describe, expect, it } from "vitest";
import { en } from "../../src/i18n/locales/en";
import { ja } from "../../src/i18n/locales/ja";
import { attentionInfos, STATE_DESC_KEY, stateInfo } from "../../src/sessions/state-info";
import {
	ALL_TERMINAL_STATUSES,
	statusGroup,
	STATUS_LABEL_KEY,
	TERMINAL_STATUS_ICON,
	terminalStatusClass,
} from "../../src/sessions/terminal-status";

describe("stateInfo", () => {
	it("uses the row mark's icon, class and label for every status", () => {
		for (const status of ALL_TERMINAL_STATUSES) {
			const info = stateInfo(status, false);
			expect(info.icon).toBe(TERMINAL_STATUS_ICON[status]);
			expect(info.cls).toBe(terminalStatusClass(status));
			expect(info.labelKey).toBe(STATUS_LABEL_KEY[status]);
			expect(info.descKey).toBe(STATE_DESC_KEY[status]);
		}
	});

	it("has an explanation in en and ja for every status and for archived", () => {
		const keys = [...ALL_TERMINAL_STATUSES.map((s) => stateInfo(s, false).descKey), stateInfo("idle", true).descKey];
		for (const key of keys) {
			expect(en[key], key).toBeTruthy();
			expect(ja[key], key).toBeTruthy();
		}
	});

	it("shows an archived row as archived whatever its status", () => {
		const info = stateInfo("working", true);
		expect(info.icon).toBe("archive");
		expect(info.labelKey).toBe("status.group.archived");
		expect(info.cls).toBe("agent-sessions-status-archived");
	});
});

describe("attentionInfos", () => {
	it("matches the groups the side panel's badge counts", () => {
		for (const status of ALL_TERMINAL_STATUSES) {
			const group = statusGroup(status, false);
			const kinds = attentionInfos(status, false).map((a) => a.kind);
			if (group === "needs-input") {
				expect(kinds).toEqual(["needs-input"]);
			} else if (group === "needs-review") {
				expect(kinds).toEqual(["needs-review"]);
			} else {
				expect(kinds).toEqual([]);
			}
		}
	});

	it("never applies to an archived row", () => {
		expect(attentionInfos("asking", true)).toEqual([]);
		expect(attentionInfos("waiting", true)).toEqual([]);
	});

	it("uses the group's icon and a distinct explanation for compacted", () => {
		const [asking] = attentionInfos("asking", false);
		expect(asking.icon).toBe("hand");
		const [waiting] = attentionInfos("waiting", false);
		const [compacted] = attentionInfos("compacted", false);
		expect(waiting.icon).toBe("eye");
		expect(waiting.labelKey).toBe(compacted.labelKey);
		expect(waiting.descKey).not.toBe(compacted.descKey);
		for (const a of [asking, waiting, compacted]) {
			expect(en[a.descKey]).toBeTruthy();
			expect(ja[a.descKey]).toBeTruthy();
		}
	});
});

describe("looped", () => {
	it("is a needs-review attention with its own explanation", () => {
		expect(attentionInfos("looped", false).map((a) => a.descKey)).toEqual(["detail.attention.looped"]);
		expect(en["detail.attention.looped"]).toBeTruthy();
		expect(ja["detail.attention.looped"]).toBeTruthy();
	});
});

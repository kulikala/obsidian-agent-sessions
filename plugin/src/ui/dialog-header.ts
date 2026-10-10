// Draws the shared header of the per-session dialogs (`dialog-header-model.ts`): title on line 1,
// the target session on line 2 — the agent's mark, the category chip, the name. No "Session:"
// prefix: a session name can itself contain a colon, so the look alone tells the target apart.

import { Setting, requireApiVersion, setIcon, setTooltip, type ButtonComponent, type Modal } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { t, type MessageKey } from "../i18n";
import { renderCategoryChip } from "./chip";
import { dialogTitle } from "./dialog-title";
import { buildSessionHeader, type SessionTarget } from "./dialog-header-model";
import { AGENT_ICON_ID } from "./icons";

const AGENT_NAME_KEY: Record<string, MessageKey> = {
	claude: "settings.agents.claude.name",
	codex: "settings.agents.codex.name",
	opencode: "settings.agents.opencode.name",
};

export interface DialogHeaderSpec {
	title: string;
	/** `null` when the session has no row to read (the header is then the title alone). */
	target: SessionTarget | null;
	colorIndexFor: (category: string) => number;
}

/** `titleKey` is the label of the menu item, command or button that opens the dialog (`dialog-title.ts`). */
export function dialogHeaderSpec(plugin: AgentSessionsPlugin, titleKey: MessageKey, target: SessionTarget | null): DialogHeaderSpec {
	return { title: dialogTitle(titleKey), target, colorIndexFor: (c) => plugin.index.categoryColorIndex(c) };
}

/** Puts a dialog on the shared spacing (`styles.css`, "Dialogs"; `docs/design.md` §16.2): its
 * content is a column of blocks `--size-4-4` apart, with no divider between fields. */
export function markDialog(modal: Modal): void {
	modal.modalEl.addClass("agent-sessions-dialog");
}

/** Styles a button that does something hard to undo: `setDestructive()` on Obsidian 1.13+, and
 * the warning style it replaces before that. */
export function markDestructive(button: ButtonComponent): ButtonComponent {
	if (requireApiVersion("1.13.0")) {
		return button.setDestructive();
	}
	button.buttonEl.addClass("mod-warning");
	return button;
}

/** The button row that ends a dialog: a divider above it, the buttons on the right. */
export function dialogFooter(container: HTMLElement): Setting {
	return new Setting(container).setClass("agent-sessions-dialog-footer");
}

/** Sets the modal's title and puts the target line at the top of its content. */
export function renderDialogHeader(modal: Modal, spec: DialogHeaderSpec): void {
	markDialog(modal);
	modal.setTitle(spec.title);
	renderSessionTarget(modal.contentEl, spec);
}

/** The target line alone, for a dialog that lays out its own title. */
export function renderSessionTarget(container: HTMLElement, spec: DialogHeaderSpec): HTMLElement | null {
	if (!spec.target) {
		return null;
	}
	const model = buildSessionHeader(spec.target);
	const line = container.createDiv({ cls: "agent-sessions-dialog-target" });
	const icon = AGENT_ICON_ID[model.agent];
	if (icon) {
		const mark = line.createSpan({ cls: "agent-sessions-dialog-target-agent" });
		setIcon(mark, icon);
		setTooltip(mark, t(AGENT_NAME_KEY[model.agent] ?? AGENT_NAME_KEY.claude));
	}
	if (model.category) {
		renderCategoryChip(line, model.category, spec.colorIndexFor(model.category));
	}
	const name = line.createSpan({ cls: "agent-sessions-dialog-target-name", text: model.label });
	setTooltip(name, model.tooltip);
	return line;
}

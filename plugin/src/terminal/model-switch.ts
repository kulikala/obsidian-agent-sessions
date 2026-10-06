// Claude Code's `/model` and `/effort` as the plugin drives them: which values the dropdowns
// offer, which of the current values they preselect, and which commands a change needs. Pure,
// so the planning can be tested without a session.

/** `/model` aliases from Claude Code's docs, as the dropdowns list them: the choices that pick a
 * model for you, then the families from the most capable down, the groups separated by a line.
 * A full model id is also accepted ("Other…"). */
export const MODEL_ALIAS_GROUPS: readonly (readonly string[])[] = [
	["default", "best", "opusplan"],
	["fable", "opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku"],
];
export const MODEL_ALIASES: readonly string[] = MODEL_ALIAS_GROUPS.flat();

/** `/effort` levels; `max` lasts for the session only. `auto` clears the saved level, which is
 * Claude Code's default, so it is labelled "Default". */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const EFFORT_AUTO = "auto";
/** The effort dropdowns' groups: the default, then the levels from the highest down. */
export const EFFORT_CHOICE_GROUPS: readonly (readonly string[])[] = [[EFFORT_AUTO], [...EFFORT_LEVELS].reverse()];
export const EFFORT_CHOICES: readonly string[] = EFFORT_CHOICE_GROUPS.flat();

/** The "keep as is" value of both dropdowns, offered when the current value can't be told. */
export const KEEP = "";
/** The model dropdown's "Other…" value (a text field then takes the id). */
export const OTHER_MODEL = "__other__";

/** What a switch asks for. `KEEP` (or an empty string) leaves that setting alone. */
export interface ModelChoice {
	/** An alias, a full model id, or `KEEP`. */
	model: string;
	/** A level, `auto`, or `KEEP`. */
	effort: string;
}

/** The current values, as far as the status line tells them. */
export interface CurrentModel {
	/** The status line's display name ("Opus 5.5"), or null when unknown. */
	display: string | null;
	effort: string | null;
}

/**
 * The alias a status-line display name stands for ("Opus 5.5" → `opus`, "Sonnet 4.6 (1M context)"
 * → `sonnet[1m]`); null when it names no family this list knows.
 */
export function aliasFromDisplay(display: string | null): string | null {
	if (!display) {
		return null;
	}
	const text = display.toLowerCase();
	const family = (["fable", "opus", "sonnet", "haiku"] as const).find((name) => text.includes(name));
	if (!family) {
		return null;
	}
	return /\b1m\b/.test(text) && family !== "haiku" && family !== "fable" ? `${family}[1m]` : family;
}

/** The model dropdown's preselection: the current alias, else "keep". */
export function preselectedModel(current: CurrentModel): string {
	return aliasFromDisplay(current.display) ?? KEEP;
}

/** The effort dropdown's preselection: the current level when it is a known one, else "keep". */
export function preselectedEffort(current: CurrentModel): string {
	return current.effort && (EFFORT_LEVELS as readonly string[]).includes(current.effort) ? current.effort : KEEP;
}

/**
 * The commands a change needs, model first (what an effort level means depends on the model).
 * Only what differs from the current value is sent; `auto` is always sent when chosen, since the
 * status line can't say whether a level was saved.
 */
export function planModelChange(current: CurrentModel, choice: ModelChoice): string[] {
	const commands: string[] = [];
	const model = choice.model.trim();
	if (model !== KEEP && model !== preselectedModel(current)) {
		commands.push(`/model ${model}`);
	}
	const effort = choice.effort.trim();
	if (effort !== KEEP && effort !== preselectedEffort(current)) {
		commands.push(`/effort ${effort}`);
	}
	return commands;
}

/**
 * What the built-in editor's Send does. Without a change it is today's plain send. With one, the
 * text goes back to the prompt first, the commands run over it (a draft is stashed around each,
 * see `main.ts`'s `commandChunks`), and the prompt is submitted last.
 */
export type EditorSendPlan = { kind: "plain" } | { kind: "switch"; commands: string[] };

export function planEditorSend(current: CurrentModel, choice: ModelChoice): EditorSendPlan {
	const commands = planModelChange(current, choice);
	return commands.length === 0 ? { kind: "plain" } : { kind: "switch", commands };
}

/**
 * Claude Code asks "Switch model? … ❯ 1. Yes, switch to Sonnet 5.5" when `/model` is run in a
 * conversation that has history. The user already chose the model, so the plugin answers it.
 * The one place the dialog is recognised, from the visible screen's text.
 */
export function isModelSwitchDialog(screen: string): boolean {
	return /Switch model\?/.test(screen) && /Yes, switch to/.test(screen);
}

/** Only `/model` can raise that dialog; `/effort` never does. */
export function mayAskToConfirm(command: string): boolean {
	return /^\/model\s/.test(command);
}

/** Enter: the dialog's first option, "Yes, switch to …", is the one preselected. */
export const CONFIRM_KEY = "\r";

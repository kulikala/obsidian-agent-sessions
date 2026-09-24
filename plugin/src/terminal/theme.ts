// Obsidian's CSS variables, turned into an xterm theme.
// `background`/`foreground`/`cursor`/`selectionBackground` come from the variables; the ANSI 16
// colors are a fixed table for each of light/dark. Reading colors needs the DOM, so only
// `buildTheme` is kept as a pure function.

import type { ITheme } from "@xterm/xterm";

export interface ThemeVars {
	background: string;
	foreground: string;
	accent: string;
	selection: string;
}

export const ANSI_DARK: Omit<ITheme, "background" | "foreground" | "cursor" | "cursorAccent" | "selectionBackground"> = {
	black: "#2e3436",
	red: "#ef5350",
	green: "#8bc34a",
	yellow: "#ffca28",
	blue: "#64b5f6",
	magenta: "#ce93d8",
	cyan: "#4dd0e1",
	white: "#d3d7cf",
	brightBlack: "#7a7f85",
	brightRed: "#ff8a80",
	brightGreen: "#b9f6ca",
	brightYellow: "#ffe57f",
	brightBlue: "#82b1ff",
	brightMagenta: "#ea80fc",
	brightCyan: "#84ffff",
	brightWhite: "#ffffff",
};

export const ANSI_LIGHT: typeof ANSI_DARK = {
	black: "#000000",
	red: "#c62828",
	green: "#2e7d32",
	yellow: "#a06b00",
	blue: "#1565c0",
	magenta: "#8e24aa",
	cyan: "#00838f",
	white: "#bdbdbd",
	brightBlack: "#616161",
	brightRed: "#e53935",
	brightGreen: "#43a047",
	brightYellow: "#c58a00",
	brightBlue: "#1e88e5",
	brightMagenta: "#ab47bc",
	brightCyan: "#00acc1",
	brightWhite: "#ffffff",
};

const DEFAULT_DARK: ThemeVars = { background: "#202020", foreground: "#dadada", accent: "#7f6df2", selection: "rgba(127,109,242,0.3)" };
const DEFAULT_LIGHT: ThemeVars = { background: "#ffffff", foreground: "#222222", accent: "#705dcf", selection: "rgba(112,93,207,0.25)" };

/** Builds xterm's `ITheme` from the variable values and light/dark. Empty values fall back to that mode's defaults. */
export function buildTheme(vars: Partial<ThemeVars>, dark: boolean): ITheme {
	const base = dark ? DEFAULT_DARK : DEFAULT_LIGHT;
	const v: ThemeVars = {
		background: vars.background || base.background,
		foreground: vars.foreground || base.foreground,
		accent: vars.accent || base.accent,
		selection: vars.selection || base.selection,
	};
	return {
		background: v.background,
		foreground: v.foreground,
		cursor: v.accent,
		cursorAccent: v.background,
		selectionBackground: v.selection,
		selectionInactiveBackground: v.selection,
		...(dark ? ANSI_DARK : ANSI_LIGHT),
	};
}

/**
 * Normalizes a color string to `rgb()`/`rgba()`. Obsidian's variables can take a form like
 * `hsla(var(--…), 0.2)`, and xterm can't read hsl, so this runs the value through a temporary
 * element's `color` and reads back the computed value.
 */
function normalizeColor(el: HTMLElement, raw: string): string {
	const value = raw.trim();
	if (!value) {
		return "";
	}
	const probe = el.ownerDocument.createElement("span");
	probe.style.color = value;
	if (!probe.style.color) {
		return "";
	}
	el.appendChild(probe);
	try {
		return getComputedStyle(probe).color;
	} finally {
		probe.remove();
	}
}

/** Reads Obsidian's variables from an element's computed style; light/dark is decided by `body.theme-dark`. */
export function readObsidianTheme(el: HTMLElement): ITheme {
	const style = getComputedStyle(el);
	const read = (name: string) => normalizeColor(el, style.getPropertyValue(name));
	const dark = el.ownerDocument.body.classList.contains("theme-dark");
	return buildTheme(
		{
			background: read("--background-primary"),
			foreground: read("--text-normal"),
			accent: read("--text-accent"),
			selection: read("--text-selection"),
		},
		dark
	);
}

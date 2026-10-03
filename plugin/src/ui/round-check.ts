// A round, large on/off toggle (a circle that shows a check mark when on) with checkbox semantics.

import { setIcon } from "obsidian";

export interface RoundCheck {
	el: HTMLElement;
	get(): boolean;
	/** Sets the state without calling `onChange`. */
	set(value: boolean): void;
}

export function createRoundCheck(
	parent: HTMLElement,
	options: { value: boolean; label: string; onChange: (value: boolean) => void }
): RoundCheck {
	let value = options.value;
	const el = parent.createDiv({ cls: "agent-sessions-round-check" });
	el.setAttr("role", "checkbox");
	el.setAttr("tabindex", "0");
	el.setAttr("aria-label", options.label);
	el.setAttr("title", options.label);
	setIcon(el, "check");
	const paint = (): void => {
		el.toggleClass("is-on", value);
		el.setAttr("aria-checked", String(value));
	};
	const toggle = (): void => {
		value = !value;
		paint();
		options.onChange(value);
	};
	el.addEventListener("click", toggle);
	el.addEventListener("keydown", (evt) => {
		if (evt.key === " " || evt.key === "Enter") {
			evt.preventDefault();
			toggle();
		}
	});
	paint();
	return {
		el,
		get: () => value,
		set: (next) => {
			value = next;
			paint();
		},
	};
}

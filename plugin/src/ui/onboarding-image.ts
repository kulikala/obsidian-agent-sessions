// A screenshot in the welcome guide: an `<img>` in a frame of fixed proportions, loaded from GitHub
// (see `onboardingImageUrl`), loaded eagerly: a lazy picture below the modal's visible area never starts, and the timeout below would call that a failure. While it loads the frame shows the scene's description, and when the
// picture doesn't come (an error, or `IMAGE_TIMEOUT_MS` without an answer) it says so and offers to
// stop loading pictures. With pictures turned off there is no `<img>` at all, only the description.

import { getLang, t, type MessageKey } from "../i18n";
import type AgentSessionsPlugin from "../main";
import { IMAGE_TIMEOUT_MS, imageFrameNext, type ImageFrameState } from "./onboarding-flow";
import { onboardingImageUrl, type OnboardingScene } from "./onboarding-model";

const SCENE_DESCRIPTION_KEY: Record<OnboardingScene, MessageKey> = {
	overview: "onboarding.scene.overview",
	install: "onboarding.scene.install",
	agents: "onboarding.scene.agents",
	"new-session": "onboarding.scene.newSession",
	"side-panel": "onboarding.scene.sidePanel",
	"row-menu": "onboarding.scene.rowMenu",
	"move-category": "onboarding.scene.moveCategory",
	editor: "onboarding.scene.editor",
	restart: "onboarding.scene.restart",
	organize: "onboarding.scene.organize",
	manager: "onboarding.scene.manager",
};

export interface SceneImageOptions {
	scene: OnboardingScene;
	/** The language of the screenshot (the display language). */
	lang: "en" | "ja";
	/** The plugin's version, which names the tag the pictures are read from. */
	version: string;
	/** A folder to read from instead of the version's tag. Development builds only. */
	base?: string;
	/** The `onboardingImages` setting. */
	enabled: boolean;
	/** Called when the user picks "stop loading pictures" on a frame that failed. */
	onTurnOff: () => void;
}

/** Draws the frame for one scene into `parent`. */
export function renderSceneImage(parent: HTMLElement, opts: SceneImageOptions): HTMLElement {
	const description = t(SCENE_DESCRIPTION_KEY[opts.scene]);
	const frame = parent.createDiv({ cls: "agent-sessions-onboarding-image" });
	if (!opts.enabled) {
		frame.addClass("is-text-only");
		frame.createDiv({ cls: "agent-sessions-onboarding-image-caption", text: description });
		return frame;
	}

	const caption = frame.createDiv({ cls: "agent-sessions-onboarding-image-caption", text: description });
	const img = frame.createEl("img", {
		attr: {
			alt: description,
			referrerpolicy: "no-referrer",
			src: onboardingImageUrl(opts.scene, opts.lang, opts.version, opts.base),
		},
	});
	frame.addClass("is-loading");

	let state: ImageFrameState = "loading";
	let timer: number | undefined;
	const settle = (event: "load" | "error" | "timeout"): void => {
		const next = imageFrameNext(state, event);
		if (next === state) {
			return;
		}
		state = next;
		window.clearTimeout(timer);
		frame.removeClass("is-loading");
		if (state === "loaded") {
			caption.remove();
			return;
		}
		// Failed: the picture is dropped (a late answer must not show through) and the frame says why.
		img.remove();
		frame.addClass("is-failed");
		caption.empty();
		caption.createDiv({ text: t("onboarding.image.failed") });
		caption.createDiv({ cls: "agent-sessions-onboarding-muted", text: description });
		caption.createEl("a", { text: t("onboarding.image.turnOff"), href: "#" }).addEventListener("click", (event) => {
			event.preventDefault();
			opts.onTurnOff();
		});
	};
	img.addEventListener("load", () => settle("load"));
	img.addEventListener("error", () => settle("error"));
	timer = window.setTimeout(() => settle("timeout"), IMAGE_TIMEOUT_MS);
	return frame;
}

/** A scene's frame with the plugin's settings applied: the display language, this version's tag (or
 * the development folder), and the `onboardingImages` switch. `onTurnOff` runs after the setting was
 * turned off from a failed frame, so the caller can redraw. */
export function renderPluginScene(
	parent: HTMLElement,
	plugin: AgentSessionsPlugin,
	scene: OnboardingScene,
	onTurnOff: () => void
): HTMLElement {
	return renderSceneImage(parent, {
		scene,
		lang: getLang(),
		version: plugin.manifest.version,
		base: plugin.devImageBase,
		enabled: plugin.settings.onboardingImages,
		onTurnOff: () => {
			plugin.settings.onboardingImages = false;
			void plugin.saveSettings();
			onTurnOff();
		},
	});
}

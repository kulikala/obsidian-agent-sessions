// Whether a Claude Code process started for a session will connect to Remote Control, so a
// headless `/rename` (`main.ts`'s `sendHeadless`) can wait for the connection before renaming:
// Claude Code sends a new title to Remote Control only while connected. Pure.

/** `remoteControlAtStartup: true` in Claude Code's `settings.json` text ("Enable Remote Control for
 * all sessions"); `null` (no file) or unreadable JSON is `false`. */
export function remoteControlAtStartup(settingsText: string | null): boolean {
	if (settingsText === null) {
		return false;
	}
	try {
		const data: unknown = JSON.parse(settingsText);
		return typeof data === "object" && data !== null && (data as { remoteControlAtStartup?: unknown }).remoteControlAtStartup === true;
	} catch {
		return false;
	}
}

/** Whether a transcript records a Remote Control session (`bridge-session`): resuming it
 * reconnects to that session, whatever the setting says. */
export function transcriptHasRemoteControl(transcriptText: string | null): boolean {
	return transcriptText !== null && /"type":\s*"bridge-session"/.test(transcriptText);
}

/** Whether resuming the session connects Remote Control. */
export function resumeConnectsRemoteControl(settingsText: string | null, transcriptText: string | null): boolean {
	return remoteControlAtStartup(settingsText) || transcriptHasRemoteControl(transcriptText);
}

// English strings — the source of truth for `MessageKey` (every other locale is checked
// against this one's key set; see `../index.ts`'s `t()` and the "locale ⊆ en" test in
// `test/i18n/locales.test.ts`). To add a language, see `../index.ts`'s module comment.

export const en = {
	// ---- Commands and actions (shared strings used by main.ts's command names, actions, tooltips) ----
	"action.openSidePanel": "Open session list",
	"action.newSession": "New session",
	"action.sessionManager": "Session manager",
	"action.insertNoteAt": "Insert current note with @",
	"action.more": "More",
	"action.rescan": "Rescan",
	"action.openSettings": "Open settings",
	"action.rename": "Rename",
	"action.moveToCategory": "Move to category…",
	"action.move": "Move",
	"action.compact": "Compact session",
	"action.archive": "Archive",
	"action.unarchive": "Remove from archive",
	"action.endSession": "End session",
	"action.usage": "Session analytics",
	"action.showUsage": "Show session analytics",
	"action.copyId": "Copy ID",
	"action.prevInstruction": "Previous instruction",
	"action.nextInstruction": "Next instruction",
	"action.lastResponse": "Last response",
	"action.scrollUp": "Scroll up one screen",
	"action.scrollDown": "Scroll down one screen",
	"action.scrollBottom": "Scroll to bottom",
	"action.resume": "Resume",
	"action.startFresh": "Start as new",
	"action.close": "Close",
	"action.retry": "Retry",
	"action.reconnect": "Reconnect",
	"action.showArchived": "Show archive",
	"action.cancel": "Cancel",
	"action.start": "Start",
	"action.change": "Rename",
	"action.send": "Send ({key})",
	"action.backToInput": "Back to prompt (Esc)",
	"action.matchFile": "Match the file",
	"action.write": "Write",
	"action.copy": "Copy",
	"action.clickToRefresh": "Click to refresh",

	// ---- Generic ----
	"common.default": "Default",
	"common.none": "(none)",
	"common.unknown": "Unknown",
	"common.listSep": ", ",
	"common.untitled": "Untitled {id}",

	// ---- Notices and errors (main.ts, terminal.ts) ----
	"notice.noActiveNote": "No note is open",
	"notice.noActiveTerminal": "No terminal tab is open",
	"notice.renameWaitFailed": "Couldn't wait for the session to start, so it wasn't named",
	"notice.renameAtCreateUnsupported": "Naming a new session at creation isn't supported yet for this agent — rename it once it's running instead.",
	"notice.needsOneAgentEnabled": "At least one agent must stay enabled.",
	"notice.renameFailed": "Failed to rename: {error}",
	"progress.renaming": "Renaming…",
	"notice.compactAlready": "The last instruction was /compact, so nothing was sent",
	"progress.compacting": "Compacting session…",
	"notice.compactFailed": "Failed to compact: {error}",
	"progress.sending": "Sending…",
	"error.attachFailed": "attach failed: {error}",
	"error.sessionNotFound": "Session not found",
	"error.startFailed": "start failed: {error}",
	"error.claudeStartWaitFailed": "Timed out waiting for claude to start",
	"error.replyWaitFailed": "Timed out waiting for a reply",
	"confirm.endSession.message": "End this session?",
	"notice.endFailed": "Failed to end: {error}",
	"notice.waitingForInput": "{name}: waiting for input",
	"notice.storeLocked": "Couldn't lock sessions.json. Wait a moment and try again",
	"notice.storeUpdateFailed": "Failed to update sessions.json: {error}",
	"notice.scanFailed": "Failed to scan sessions: {message}",
	"notice.idCopied": "Copied the ID",
	"notice.matchedKeybindings": "Matched keybindings.json",
	"notice.keybindingsWritten": "Updated keybindings.json",
	"notice.keybindingsUnchanged": "keybindings.json already matched — nothing to write",
	"notice.markdownCopied": "Copied the Markdown",
	"error.agentMissing": "{name} was not found",

	// ---- Settings tab (main.ts) ----
	"settings.font.name": "Font",
	"settings.fontSize.name": "Font size",
	"settings.padding.name": "Padding",
	"settings.padding.comfortable": "Comfortable",
	"settings.padding.compact": "Compact",
	"settings.padding.none": "None",
	"settings.recentCount.name": "Recent count (side panel)",
	"settings.notifyOnIdle.name": "Notify when waiting for input",
	"settings.agents.heading": "Agents",
	"settings.agents.desc": "Which CLI agents can be launched, and how each one is found.",
	"settings.agents.claude.name": "Claude Code",
	"settings.agents.codex.name": "Codex",
	"settings.agents.path.name": "Path",
	"settings.agents.path.desc": "Empty = auto-detect.",
	"settings.agents.env.name": "Environment variables",
	"settings.agents.env.desc": "KEY=VALUE, one per line.",
	"settings.agents.detect.name": "Detect again",
	"settings.agents.detected.found": "Detected: {path}",
	"settings.agents.detected.foundWithVersion": "Detected: {path} ({version})",
	"settings.agents.detected.notFound": "Not detected.",
	"settings.agents.detected.enable": "Enable",
	"settings.agentSessionsPath.name": "Path to agent-sessions",
	"settings.agentSessionsPath.desc": "Default when empty: ~/bin/agent-sessions",
	"settings.editorHeight.name": "Editor pane height (%)",
	"settings.editorHeight.desc": "Height of the built-in editor opened with Ctrl+G",
	"settings.scrollback.name": "Scrollback lines",
	"settings.language.name": "Language",
	"settings.language.optionAuto": "Auto",
	"settings.submitKey.name": "Submit key",
	"settings.submitKey.desc":
		"Choosing anything other than Enter makes Enter insert a newline instead. This writes to ~/.claude/keybindings.json (it also affects claude started from other terminal apps) — but only this plugin's own terminal tabs reliably send the chosen key: it intercepts every Enter combination itself and always sends the same bytes for \"submit\", regardless of modifier. In a terminal app outside Obsidian, whether Ctrl+Enter or Cmd+Enter is even distinguishable from plain Enter depends on that terminal — many aren't able to, and send plain Enter either way.",
	"settings.submitKey.currentUnreadable": "Current keybindings.json: can't read {path}",
	"settings.submitKey.currentCustom": "Current keybindings.json Chat enter: {raw}",
	"settings.submitKey.currentNewline": "Current keybindings.json Chat enter: chat:newline",
	"settings.submitKey.currentSubmit": "Current keybindings.json Chat enter: default (unset, or chat:submit)",
	"confirm.writeKeybindings.message":
		"This writes to Claude Code's keybindings.json to make Enter insert a newline. It also affects claude started from other terminal apps.",
	"settings.submitKeyMismatch.name": "Doesn't match keybindings.json",
	"settings.submitKeyMismatch.desc": "Doesn't match Claude Code's keybindings.json",

	// ---- Modals (ui/modals.ts) ----
	"modal.newSession.title": "New session",
	"modal.newSession.nameField": "Name",
	"modal.newSession.agentField": "Agent",
	"modal.renameSession.title": "Rename",
	"modal.moveToCategory.title": "Move to category",
	"modal.moveToCategory.categoryField": "Category",

	// ---- Side panel (views/side.ts) ----
	"section.openTabs": "Open tabs",
	"section.running": "Running",
	"section.recent": "Recent",
	"empty.desc": "Open and manage Claude Code and Codex sessions right here in Obsidian.",
	"empty.noAgentEnabled": "No agent is enabled — turn one on in settings first.",
	"empty.noAgentFound": "No enabled agent could be found — check the path in settings.",

	// ---- Row relative time (views/rows.ts's formatRelativeTime, side panel only) ----
	"time.justNow": "just now",
	"time.minutesAgo": "{n} min ago",
	"time.hoursAgo": "{n} h ago",
	"time.yesterday": "yesterday",
	"time.daysAgo": "{n} d ago",

	// ---- Attention markers (side panel badges, manager section headings) ----
	"attention.asking": "Needs input {count}",
	// This counts both `waiting` (turn ended, tab not yet viewed) and `compacted` (just
	// /compact'd, no next instruction yet) — both are "needs review" now (statusGroup).
	"attention.waiting": "Needs review {count}",
	"attention.askingInGroup": "Has a session waiting for input",
	"attention.waitingInGroup": "Has a session that needs review",

	// ---- Manager (views/manager.ts, views/manager-model.ts) ----
	"table.name": "Name",
	"table.updated": "Last updated",
	"table.model": "Model",
	"table.effort": "Effort",
	"table.folder": "Folder",
	"stats.fiveHour": "5-hour window",
	"stats.sevenDay": "7-day window",
	"stats.resetsIn": "resets in {countdown}",
	"stats.metric.cost": "Cost",
	"stats.metric.costTip": "Total cost within this window",
	"stats.metric.tokens": "Tokens",
	"stats.metric.tokensTip": "Input + output + cache read + cache create (within this window)",
	"stats.metric.calls": "Calls",
	"stats.metric.callsTip": "Number of calls within this window",
	"stats.metric.sessions": "Sessions",
	"stats.metric.sessionsTip": "Number of sessions active within this window",
	"stats.categoryBar.title5h": "By category (5-hour window)",
	"stats.categoryBar.title7d": "By category (7-day window)",
	"stats.categoryBar.empty": "No usage in this window",
	"stats.categoryBar.itemCost": "{cost} ({share}%)",
	"stats.pace.unknown": "Usage percentage unavailable",
	"stats.pace.tooEarly": "Not enough elapsed time to judge yet",
	"stats.pace.onTrack": "On track — about {pct} by the end of the window at this pace",
	"stats.pace.overPace": "At this pace you'll run out {when} ({days}d {hours}h before reset)",
	"stats.pace.overPaceGuide": "Stay under {pct} per remaining day (about {cost}/day)",
	"stats.pace.overPaceGuideNoCost": "Stay under {pct} per remaining day",
	"stats.pace.tooltip": "{elapsedPct}% elapsed · {usedPct}% used",
	"category.other": "Other",
	"toolbar.filterPlaceholder": "Filter",
	"toolbar.filterByStatus": "Filter by status",
	"group.archived": "Archive ({count})",
	"group.other": "Other",
	"manager.analysis.title": "Analysis",

	// ---- Detail view (views/detail.ts) ----
	"detail.compacted": "Compacted",
	"detail.totalTokens": "Total tokens",
	"detail.totalCost": "Total cost",
	"detail.lastUser": "Last instruction",
	"detail.lastAssistant": "Last reply",
	"detail.tools": "Tools",
	"detail.folder": "Folder",

	// ---- Rate-limit view (views/limits.ts) ----
	"limits.countdownDays": "{days}d {h}:{mm}",

	// ---- Editor pane (views/editor-pane.ts) ----
	// Uses action.send and action.backToInput.

	// ---- Terminal exit screen (views/terminal.ts) ----
	"exit.exited": "The session has ended ({code})",
	"exit.disconnected": "Disconnected from the daemon",

	// ---- Tab/row state (views/terminal.ts's `terminalStatus`) ----
	"status.connecting": "Connecting",
	"status.working": "Working",
	"status.runningShell": "Running a command",
	// claude itself is waiting on a question, a permission prompt, or elicitation. Ranks above "waiting for input".
	"status.asking": "Waiting for your answer",
	"status.waiting": "Waiting for input",
	// Right after a /compact, before the next instruction has been sent. Ranks below "waiting
	// for input" — kept as a distinct state so it's clear the context was just reset.
	"status.compacted": "Compacted (context was reset)",
	"status.editing": "Editing",
	"status.idle": "Idle",
	"status.detached": "Not connected",
	"status.exited": "Exited",
	"status.error": "Error",

	// ---- Status groups (sessions/terminal-status.ts's `statusGroup`; the side panel's badge and
	// the manager's status-filter menu, matching Claude's own app's status buckets) ----
	"status.group.all": "All",
	"status.group.needsInput": "Needs input",
	"status.group.needsReview": "Needs review",
	"status.group.running": "Running",
	"status.group.done": "Done",
	"status.group.archived": "Archived",

	// ---- Session analytics modal (usage/usage-modal.ts) ----
	"usage.title": "Session analytics: {name}",
	"usage.loading": "Loading…",
	"usage.loadFailed": "Failed to load: {error}",
	"usage.col.time": "Time",
	"usage.col.prompt": "Prompt",
	"usage.col.input": "Input",
	"usage.col.output": "Output",
	"usage.col.cost": "Cost",
	"usage.emptyPrompt": "(empty)",
	"usage.beforeFirstPrompt": "(before first prompt)",
	"usage.whole": "Whole",
	"usage.rangePending": "#{from}– (click the end row)",
	"usage.range": "#{from}–#{to}",
	"usage.card.estimated": "estimated",
	"usage.card.tokens": "Tokens",
	"usage.card.outputSub": "output {output}",
	"usage.card.turns": "Turns",
	"usage.card.duration": "Duration",
	"usage.chart.input": "Input",
	"usage.chart.uncached": "uncached",
	"usage.chart.cacheRead": "cache read",
	"usage.chart.cacheCreate": "cache create",
	"usage.chart.output": "Output",
	"usage.chart.toolsTitle": "Tool use",
	"usage.chart.toolsEmpty": "No tool use",

	// ---- Markdown copy (usage/usage.ts's toMarkdown) ----
	"usage.md.title": "# Session analytics (#{lo}–#{hi})",
	"usage.md.cost": "- Cost: {cost}{estimated}",
	"usage.md.estimatedSuffix": " (estimated)",
	"usage.md.tokens": "- Tokens: input {input}, output {output}",
	"usage.md.turns": "- Turns: {count}",
	"usage.md.duration": "- Duration: {duration}",
	"usage.md.tableHeader": "| # | Time | Prompt | Input | Output | Cost |",

	// ---- terminal/keybindings.ts ----
	"error.keybindingsUnreadable": "Can't read {path}. You'll need to fix it by hand",
	"warning.manualFix": "You'll need to fix it by hand ({keys} still has an unexpected value)",

	// ---- sessions/store.ts ----
	"error.lockFailed": "Couldn't get the lock: {path}",

	// ---- backend/daemon-client.ts ----
	"error.unknownFrameKind": "Unknown frame kind: 0x{hex}",
	"error.socketClosed": "The socket closed",
	"error.notConnected": "Not connected to the daemon",
	"error.agentSessionsNotFound": "agent-sessions was not found: {path}",
	"error.daemonUnavailable": "Can't connect to the daemon. Python may be missing, or the socket couldn't be created.",
} as const;

/** Every translatable string key, derived from `en`'s own keys — the source of truth (see the
 * module comment above). */
export type MessageKey = keyof typeof en;

/** English's own name for itself, shown in the language-setting dropdown regardless of the
 * current display language (an autonym, not translated). */
export const EN_SELF_NAME = "English";

// 設定の型と既定値（§6.9）。obsidian には依存しない（純粋なデータ定義）。

export type Padding = "comfortable" | "compact" | "none";

export interface AgentSessionsSettings {
	fontFamily: string;
	fontSize: number;
	padding: Padding;
	recentCount: number;
	notifyOnIdle: boolean;
	claudePath: string;
	agentSessionsPath: string;
	pythonPath: string;
	scrollback: number;
}

export const DEFAULT_SETTINGS: AgentSessionsSettings = {
	fontFamily: 'Menlo, "Hiragino Sans", monospace',
	fontSize: 13,
	padding: "comfortable",
	recentCount: 10,
	notifyOnIdle: true,
	claudePath: "",
	agentSessionsPath: "",
	pythonPath: "/usr/bin/python3",
	scrollback: 5000,
};

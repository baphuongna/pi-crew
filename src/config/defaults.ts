export const DEFAULT_CHILD_PI: Readonly<{
	postExitStdioGuardMs: number;
	finalDrainMs: number;
	hardKillMs: number;
	responseTimeoutMs: number;
	maxCaptureBytes: number;
	maxAssistantTextChars: number;
	maxToolResultChars: number;
	maxToolInputChars: number;
	maxCompactContentChars: number;
}> = {
	postExitStdioGuardMs: 3000,
	finalDrainMs: 5000,
	hardKillMs: 3000,
	// Child workers can spend more than a few seconds in provider calls or long-running tools without emitting stdout.
	// Keep this as a coarse stuck-worker guard rather than a short per-message latency budget.
	responseTimeoutMs: 5 * 60_000,
	maxCaptureBytes: 256 * 1024,
	maxAssistantTextChars: 8192,
	maxToolResultChars: 1024,
	maxToolInputChars: 2048,
	maxCompactContentChars: 4096,
};

export const DEFAULT_LIVE_SESSION = {
	/** Maximum wall-clock time for a single live-session task before abort (ms). */
	responseTimeoutMs: 10 * 60_000,  // 10 minutes - increased from 5min for complex verification
	/** Maximum yield reminder attempts before accepting no-yield. */
	maxYieldRetries: 3,
	/** Polling interval for session idle check during yield enforcement (ms). */
	yieldPollIntervalMs: 500,
	/** Maximum time to wait for session idle after prompt (ms). */
	idleWaitTimeoutMs: 60_000,
};

export const DEFAULT_LOCKS = {
	staleMs: 30_000,
};

export const DEFAULT_CONCURRENCY = {
	hardCap: 8,
	workflow: {
		parallelResearch: 4,
		research: 3,
		implementation: 4,
		review: 3,
		default: 3,
	},
	fallback: 2,
};

export const DEFAULT_EVENT_LOG = {
	terminalEventTypes: ["run.blocked", "run.completed", "run.failed", "run.cancelled", "task.completed", "task.failed", "task.skipped", "task.cancelled", "task.needs_attention"],
};

export const DEFAULT_ARTIFACT_CLEANUP = {
	maxAgeDays: 7,
};

export const DEFAULT_PATHS = {
	state: {
		runsSubdir: "state/runs",
		artifactsSubdir: "artifacts",
		subagentsSubdir: "state/subagents",
		importsSubdir: "imports",
		worktreesSubdir: "worktrees",
		manifestFile: "manifest.json",
		tasksFile: "tasks.json",
		eventsFile: "events.jsonl",
	},
};

export const DEFAULT_UI = {
	refreshMs: 1000,
	notifierIntervalMs: 5000,
	widgetDefaultFrameMs: 1000,
	widgetPlacement: "aboveEditor" as const,
	widgetMaxLines: 8,
	powerbar: true,
	dashboardPlacement: "center" as const,
	dashboardWidth: 72,
	dashboardLiveRefreshMs: 1000,
	autoOpenDashboard: false,
	autoOpenDashboardForForegroundRuns: false,
	showModel: true,
	showTokens: true,
	showTools: true,
	transcriptTailBytes: 1024 * 1024,
	mascotStyle: "cat" as const,
	mascotEffect: "random" as const,
};

export const DEFAULT_NOTIFICATIONS = {
	severityFilter: ["warning", "error", "critical"] as const,
	dedupWindowMs: 30_000,
	batchWindowMs: 0,
	sinkRetentionDays: 7,
};

export const DEFAULT_CACHE = {
	manifestMaxEntries: 64,
};

export const DEFAULT_MAILBOX = {
	perFileThresholdBytes: 10 * 1024 * 1024, // 10MB per mailbox file
	maxArchivesPerDirection: 10, // Keep at most 10 archives per direction per run
};

export const DEFAULT_SUBAGENT = {
	stuckBlockedNotifyMs: 5 * 60_000,
};

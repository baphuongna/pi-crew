export const DEFAULT_CHILD_PI = {
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

export const DEFAULT_LOCKS = {
	staleMs: 30_000,
};

export const DEFAULT_CONCURRENCY = {
	workflow: {
		parallelResearch: 4,
		research: 2,
		implementation: 2,
		review: 2,
		default: 2,
	},
	fallback: 1,
};

export const DEFAULT_EVENT_LOG = {
	terminalEventTypes: ["run.blocked", "run.completed", "run.failed", "run.cancelled", "task.completed", "task.failed", "task.skipped", "task.cancelled"],
};

export const DEFAULT_ARTIFACT_CLEANUP = {
	maxAgeDays: 7,
};

export const DEFAULT_PATHS = {
	state: {
		projectBase: "teams",
		userBase: "runs",
		runsSubdir: "state/runs",
		artifactsSubdir: "artifacts",
		manifestFile: "manifest.json",
		tasksFile: "tasks.json",
		eventsFile: "events.jsonl",
	},
};

export const DEFAULT_UI = {
	refreshMs: 1000,
	notifierIntervalMs: 5000,
	widgetDefaultFrameMs: 1000,
};

export const DEFAULT_CACHE = {
	manifestMaxEntries: 64,
};

export const DEFAULT_SUBAGENT = {
	stuckBlockedNotifyMs: 5 * 60_000,
};

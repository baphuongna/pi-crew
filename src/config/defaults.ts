import type { CrewBrokerConfig } from "./types.ts";

export const DEFAULT_CHILD_PI: Readonly<{
	postExitStdioGuardMs: number;
	finalDrainMs: number;
	/** F12: early-exit the drain if stdout goes silent for ≥ this many ms after
	 *  the final assistant event AND the assistant already emitted
	 *  message_end with stopReason=stop. Lets well-behaved workers finish in
	 *  ~800 ms instead of the full 5 s ceiling. Set to >= finalDrainMs to disable. */
	finalDrainQuietMs: number;
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
	finalDrainQuietMs: 800,
	hardKillMs: 3000,
	// Child workers can spend more than a few seconds in provider calls or long-running tools without emitting stdout.
	// Keep this as a coarse stuck-worker guard rather than a short per-message latency budget.
	responseTimeoutMs: 10 * 60_000,
	// #3 unresponsive worker hardening: increased from 256KB to 512KB so critical
	// diagnostic stderr is less likely to be silently truncated during hang analysis.
	maxCaptureBytes: 512 * 1024,
	// L4 output-handling: thresholds sized from real worker-output data
	// (27 result artifacts measured: max 9226 bytes, median 8272, 100% < 16KB).
	// Previous values (8192/1024/4096) truncated 62% of real results.
	// See .crew/research/worker-output-handling.md + source/deer-flow/.research/.
	maxAssistantTextChars: 16_384,
	maxToolResultChars: 8_192,
	maxToolInputChars: 4_096,
	maxCompactContentChars: 8_192,
};

export const DEFAULT_LIVE_SESSION = {
	/** Maximum wall-clock time for a single live-session task before abort (ms). */
	responseTimeoutMs: 10 * 60_000, // 10 minutes - increased from 5min for complex verification
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
	terminalEventTypes: [
		"run.blocked",
		"run.completed",
		"run.failed",
		"run.cancelled",
		"task.completed",
		"task.failed",
		"task.skipped",
		"task.cancelled",
		"task.needs_attention",
	],
};

export const DEFAULT_ARTIFACT_CLEANUP = {
	maxAgeDays: 7,
};

/** Round 25 (L6): thresholds for task-output-context inline-bytes budget.
 *  Single source of truth for the per-dep cap, total dep cap, and tee
 *  recovery multiplier. Previously hardcoded in
 *  src/runtime/task-output-context.ts; moved here so that operators can
 *  override them via config (Phase 5 ship) without touching runtime code. */
export const DEFAULT_OUTPUT_CONTEXT = {
	/** Per-dep inline-bytes cap (chars). Set by plan §5 L4 (96 KB total). */
	maxResultInlineBytes: 32_000,
	/** Total inline-bytes budget across all deps for one downstream worker. */
	maxTotalDepInlineBytes: 96_000,
	/** Tee recovery threshold: only when file > TEE_THRESHOLD_MULTIPLIER *
	 *  maxResultInlineBytes, the truncated inline is also written to a
	 *  tee file (R2: 1.25x = 40 KB). */
	teeThresholdMultiplier: 1.25,
} as const;

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

/**
 * Phase 0 inter-pi broker defaults.
 * Phase 4 (v0.9.47): default is ON (enabled:true). The broker runs
 * automatically for users on supported platforms (Linux + macOS).
 * Three independent ways to disable:
 *   1. `broker.enabled: false` in user config
 *   2. env `PI_CREW_BROKER=0` (beats config=true)
 *   3. (Windows) auto-disabled — broker requires unix socket which Windows
 *      supports only via WSL1/2; native Windows perm model lacks the
 *      abstract-socket guarantees the broker relies on. See
 *      docs/decisions/2026-07-21-broker-windows-perms.md.
 * Limits are bounded by `src/schema/config-schema.ts` CrewBrokerConfigSchema:
 *   pathHashLen       4..32     (default 8)
 *   maxFrameBytes     1024..1048576 (default 262144 = 256 KiB)
 *   outboundQueueCap  32..4096  (default 256)
 */
export const DEFAULT_BROKER = {
	enabled: true,
	pathHashLen: 8,
	maxFrameBytes: 262144,
	outboundQueueCap: 256,
} as const;

/**
 * Apply `PI_CREW_BROKER` env override to a parsed broker config.
 * - `"1"` forces `enabled: true` (beats a config of `false` AND the
 *   default of `false` when no broker block is configured).
 * - `"0"` forces `enabled: false` (beats a config of `true`).
 * - unset / any other value falls through to the parsed value (which
 *   may itself be `undefined`; the loadConfig merge layer fills defaults).
 * Phase 0 scope: only the `enabled` flag is overridable via env; numeric
 * bounds must go through the schema + parser path, not env.
 */
export function resolveBrokerEnvOverride(parsed: CrewBrokerConfig | undefined): CrewBrokerConfig | undefined {
	const override = process.env.PI_CREW_BROKER;
	if (override === "1" || override === "0") {
		const base: CrewBrokerConfig = parsed ?? {};
		return { ...base, enabled: override === "1" };
	}
	return parsed;
}

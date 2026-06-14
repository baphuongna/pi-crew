// 2.9 — config interface types extracted from src/config/config.ts.
//
// All public surface types live here so that hot-path callers (loadConfig,
// merging helpers, schema validators) can import just the types without
// pulling in the parser graph. config.ts re-exports every name from this
// file for backwards compat — existing `import { CrewUiConfig } from "../config/config.ts"`
// continues to work.

export type PiTeamsAutonomyProfile =
	| "manual"
	| "suggested"
	| "assisted"
	| "aggressive";

export interface PiTeamsAutonomousConfig {
	profile?: PiTeamsAutonomyProfile;
	enabled?: boolean;
	injectPolicy?: boolean;
	preferAsyncForLongTasks?: boolean;
	allowWorktreeSuggestion?: boolean;
	magicKeywords?: Record<string, string[]>;
	/** Mark certain bash commands as excludeFromContext to reduce context tokens. Default: false */
	excludeContextBash?: boolean;
}

export interface CrewLimitsConfig {
	maxConcurrentWorkers?: number;
	allowUnboundedConcurrency?: boolean;
	maxTaskDepth?: number;
	maxChildrenPerTask?: number;
	maxRunMinutes?: number;
	maxRetriesPerTask?: number;
	maxTasksPerRun?: number;
	heartbeatStaleMs?: number;
}

export type CrewRuntimeMode =
	| "auto"
	| "scaffold"
	| "child-process"
	| "live-session";

export type CompletionMutationGuardMode = "off" | "warn" | "fail";
export type EffectivenessGuardMode = "off" | "warn" | "block" | "fail";

export interface CrewRuntimeConfig {
	mode?: CrewRuntimeMode;
	preferLiveSession?: boolean;
	allowChildProcessFallback?: boolean;
	maxTurns?: number;
	graceTurns?: number;
	inheritContext?: boolean;
	promptMode?: "replace" | "append";
	groupJoin?: "off" | "group" | "smart";
	groupJoinAckTimeoutMs?: number;
	requirePlanApproval?: boolean;
	completionMutationGuard?: CompletionMutationGuardMode;
	effectivenessGuard?: EffectivenessGuardMode;
	yield?: {
		enabled?: boolean;
		maxReminders?: number;
		reminderPrompt?: string;
	};
	/** Policy for per-role runtime selection. Not sensitive — safe to keep in project config. */
	isolationPolicy?: {
		/** Roles that should use child-process for crash isolation. Default: no roles. */
		isolatedRoles?: string[];
		/** Default runtime for roles not in isolatedRoles. Default: "live-session" (uses live-session). */
		defaultRuntime?: "live-session" | "child-process";
	};
	/** Mark certain bash commands as excludeFromContext to reduce context tokens. Default: false */
	excludeContextBash?: boolean;
}

export interface CrewControlConfig {
	enabled?: boolean;
	needsAttentionAfterMs?: number;
}

export interface CrewWorktreeConfig {
	setupHook?: string;
	setupHookTimeoutMs?: number;
	linkNodeModules?: boolean;
	seedPaths?: string[];
}

export interface CrewUiConfig {
	widgetPlacement?: "aboveEditor" | "belowEditor";
	widgetMaxLines?: number;
	powerbar?: boolean;
	dashboardPlacement?: "center" | "right";
	dashboardWidth?: number;
	dashboardLiveRefreshMs?: number;
	autoOpenDashboard?: boolean;
	autoOpenDashboardForForegroundRuns?: boolean;
	autoCloseDashboardMs?: number;
	showModel?: boolean;
	showTokens?: boolean;
	showTools?: boolean;
	transcriptTailBytes?: number;
	mascotStyle?: "cat" | "armin";
	mascotEffect?:
		| "random"
		| "none"
		| "typewriter"
		| "scanline"
		| "rain"
		| "fade"
		| "crt"
		| "glitch"
		| "dissolve";
}

export interface AgentOverrideConfig {
	disabled?: boolean;
	model?: string | false;
	fallbackModels?: string[] | false;
	thinking?: string | false;
	tools?: string[] | false;
	skills?: string[] | false;
}

export interface CrewAgentsConfig {
	disableBuiltins?: boolean;
	overrides?: Record<string, AgentOverrideConfig>;
}

export interface CrewToolsConfig {
	enableClaudeStyleAliases?: boolean;
	enableSteer?: boolean;
	terminateOnForeground?: boolean;
}

export interface CrewTelemetryConfig {
	enabled?: boolean;
}

export interface CrewPolicyConfig {
	requireIntentForDestructiveActions?: boolean;
	disabledCapabilities?: string[];
}

export type CrewNotificationSeverity =
	| "info"
	| "warning"
	| "error"
	| "critical";

export interface CrewNotificationsConfig {
	enabled?: boolean;
	severityFilter?: CrewNotificationSeverity[];
	dedupWindowMs?: number;
	batchWindowMs?: number;
	quietHours?: string;
	sinkRetentionDays?: number;
}

export interface CrewObservabilityConfig {
	enabled?: boolean;
	pollIntervalMs?: number;
	metricRetentionDays?: number;
}

export interface CrewRetryPolicyConfig {
	maxAttempts?: number;
	backoffMs?: number;
	jitterRatio?: number;
	exponentialFactor?: number;
	retryableErrors?: string[];
}

export interface CrewReliabilityConfig {
	autoRetry?: boolean;
	retryPolicy?: CrewRetryPolicyConfig;
	autoRecover?: boolean;
	deadletterThreshold?: number;
	/** Interval (ms) for periodic stale-run auto-repair. Default 60_000 (60s). Set to 0 to disable. */
	autoRepairIntervalMs?: number;
	/** Remove /tmp/pi-crew-* directories after their orphaned runs are reconciled. Default: true. */
	cleanupOrphanedTempDirs?: boolean;
}

export interface CrewOtlpConfig {
	enabled?: boolean;
	endpoint?: string;
	headers?: Record<string, string>;
	intervalMs?: number;
}

export interface PiTeamsConfig {
	asyncByDefault?: boolean;
	executeWorkers?: boolean;
	notifierIntervalMs?: number;
	requireCleanWorktreeLeader?: boolean;
	ignoreMethod?: "gitignore" | "exclude";
	autonomous?: PiTeamsAutonomousConfig;
	limits?: CrewLimitsConfig;
	runtime?: CrewRuntimeConfig;
	control?: CrewControlConfig;
	worktree?: CrewWorktreeConfig;
	agents?: CrewAgentsConfig;
	tools?: CrewToolsConfig;
	telemetry?: CrewTelemetryConfig;
	policy?: CrewPolicyConfig;
	notifications?: CrewNotificationsConfig;
	observability?: CrewObservabilityConfig;
	reliability?: CrewReliabilityConfig;
	otlp?: CrewOtlpConfig;
	ui?: CrewUiConfig;
}

export interface LoadedPiTeamsConfig {
	config: PiTeamsConfig;
	path: string;
	paths: string[];
	error?: string;
	warnings?: string[];
}

export interface ConfigValidationResult {
	config: PiTeamsConfig;
	warnings: string[];
}

export interface SavedPiTeamsConfig {
	config: PiTeamsConfig;
	path: string;
}

export interface UpdateConfigOptions {
	cwd?: string;
	scope?: "user" | "project";
	unsetPaths?: string[];
}

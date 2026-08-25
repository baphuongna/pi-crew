import { Type } from "@sinclair/typebox";

export {
	type ValidationFinding,
	type ValidationMode,
	type ValidationOutcome,
	type ValidationSeverity,
	validateWithSeverity,
} from "./validation-types.ts";

export const PiTeamsAutonomyProfileSchema = Type.Union([
	Type.Literal("manual"),
	Type.Literal("suggested"),
	Type.Literal("assisted"),
	Type.Literal("aggressive"),
]);

export const PiTeamsAutonomousConfigSchema = Type.Object(
	{
		profile: Type.Optional(
			Type.Union([Type.Literal("manual"), Type.Literal("suggested"), Type.Literal("assisted"), Type.Literal("aggressive")], {
				sensitive: true,
			}),
		),
		enabled: Type.Optional(Type.Boolean({ sensitive: true })),
		injectPolicy: Type.Optional(Type.Boolean({ sensitive: true })),
		preferAsyncForLongTasks: Type.Optional(Type.Boolean({ sensitive: true })),
		allowWorktreeSuggestion: Type.Optional(Type.Boolean({ sensitive: true })),
		// S19-5 (Wave 1A): magicKeywords alone flips effective autonomous mode on
		// (effectiveAutonomousConfig defaults profile "suggested" when only
		// magicKeywords is present) — untrusted project config must not set it.
		magicKeywords: Type.Optional(
			Type.Record(Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 })), { sensitive: true }),
		),
	},
	{ additionalProperties: false },
);

export const PiTeamsLimitsConfigSchema = Type.Object(
	{
		maxConcurrentWorkers: Type.Optional(Type.Integer({ minimum: 1 })),
		allowUnboundedConcurrency: Type.Optional(Type.Boolean()),
		maxTaskDepth: Type.Optional(Type.Integer({ minimum: 1 })),
		maxChildrenPerTask: Type.Optional(Type.Integer({ minimum: 1 })),
		maxRunMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
		maxRetriesPerTask: Type.Optional(Type.Integer({ minimum: 1 })),
		maxTasksPerRun: Type.Optional(Type.Integer({ minimum: 1 })),
		heartbeatStaleMs: Type.Optional(Type.Integer({ minimum: 1 })),
		serializeOnPathOverlap: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const PiTeamsModelFallbackConfigSchema = Type.Object(
	{
		maxAutoFallbacks: Type.Optional(Type.Integer({ minimum: 0 })),
		order: Type.Optional(Type.Union([Type.Literal("parentFirst"), Type.Literal("asIs")])),
		requireCredentials: Type.Optional(Type.Boolean()),
		quotaAwareOrdering: Type.Optional(Type.Boolean()),
		defaultSubagentModel: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const PiTeamsRuntimeConfigSchema = Type.Object(
	{
		mode: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("scaffold"), Type.Literal("child-process"), Type.Literal("live-session")], {
				sensitive: true,
			}),
		),
		preferLiveSession: Type.Optional(Type.Boolean({ sensitive: true })),
		allowChildProcessFallback: Type.Optional(Type.Boolean({ sensitive: true })),
		maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
		graceTurns: Type.Optional(Type.Integer({ minimum: 1 })),
		taskTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		inheritContext: Type.Optional(Type.Boolean({ sensitive: true })),
		promptMode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("append")])),
		groupJoin: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("group"), Type.Literal("smart")])),
		groupJoinAckTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		requirePlanApproval: Type.Optional(Type.Boolean()),
		completionMutationGuard: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("warn"), Type.Literal("fail")])),
		effectivenessGuard: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Literal("warn"), Type.Literal("block"), Type.Literal("fail")]),
		),
		yield: Type.Optional(
			Type.Object(
				{
					enabled: Type.Optional(Type.Boolean()),
					maxReminders: Type.Optional(Type.Integer({ minimum: 0 })),
					reminderPrompt: Type.Optional(Type.String({ maxLength: 1000 })),
				},
				{ additionalProperties: false },
			),
		),
		excludeContextBash: Type.Optional(Type.Boolean()),
		agentExtensions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { sensitive: true })),
		isolationPolicy: Type.Optional(
			Type.Object(
				{
					isolatedRoles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
					defaultRuntime: Type.Optional(Type.Union([Type.Literal("live-session"), Type.Literal("child-process")])),
				},
				{ additionalProperties: false, sensitive: true },
			),
		),
		modelFallback: Type.Optional(PiTeamsModelFallbackConfigSchema),
	},
	{ additionalProperties: false },
);

export const PiTeamsControlConfigSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		needsAttentionAfterMs: Type.Optional(Type.Integer({ minimum: 1 })),
		// F19-3 (Round 19 parity): read at agent-control.ts with defaults 3/10.
		consecutiveFailureThreshold: Type.Optional(Type.Integer({ minimum: 1 })),
		longRunningMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

export const PiTeamsWorktreeConfigSchema = Type.Object(
	{
		setupHook: Type.Optional(Type.String({ minLength: 1, sensitive: true })),
		setupHookTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		linkNodeModules: Type.Optional(Type.Boolean()),
		seedPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { sensitive: true })),
	},
	{ additionalProperties: false },
);

/**
 * Goal-wrap config (RFC v0.5 vision: apply `goal` completion-guarantee to builtin workflows).
 * Per-workflow toggle. When enabled, a builtin workflow runs as the WORKER TURN inside a
 * goal loop (worker → judge → feedback → redo until achieved / maxTurns / budget / stuck).
 * Default OFF — opt-in per workflow. Only applies to builtin workflows that have a clear
 * 'done' condition (implementation, fast-fix). Read-only workflows (review, research) are
 * not goal-wrappable.
 */
export const GoalWrapWorkflowConfigSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
		evaluatorModel: Type.Optional(Type.String({ minLength: 1 })),
		verification: Type.Optional(
			Type.Object(
				{
					commands: Type.Array(Type.String({ minLength: 1 })),
					mode: Type.Optional(Type.Literal("text-only")),
				},
				{ additionalProperties: false },
			),
		),
		budgetTotal: Type.Optional(Type.Integer({ minimum: 1000 })),
		budgetUnlimited: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

// S19-2 (Wave 1A): the whole goalWrap subtree is user-only — a project config
// must not enable silent auto-wrap, pick the evaluator model, or set
// budgetUnlimited (unbounded provider spend). Marking the Record is terminal:
// the walk collapses the subtree to the single top-level path `goalWrap`.
export const PiTeamsGoalWrapConfigSchema = Type.Record(Type.String({ minLength: 1 }), GoalWrapWorkflowConfigSchema, { sensitive: true });

export const AgentOverrideSchema = Type.Object(
	{
		disabled: Type.Optional(Type.Boolean()),
		model: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Literal(false)])),
		fallbackModels: Type.Optional(Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Literal(false)])),
		thinking: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Literal(false)])),
		tools: Type.Optional(Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Literal(false)])),
		skills: Type.Optional(Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Literal(false)])),
	},
	{ additionalProperties: false },
);

export const PiTeamsAgentsConfigSchema = Type.Object(
	{
		disableBuiltins: Type.Optional(Type.Boolean({ sensitive: true })),
		overrides: Type.Optional(Type.Record(Type.String({ minLength: 1 }), AgentOverrideSchema, { sensitive: true })),
	},
	{ additionalProperties: false },
);

export const PiTeamsToolsConfigSchema = Type.Object(
	{
		enableClaudeStyleAliases: Type.Optional(Type.Boolean()),
		enableSteer: Type.Optional(Type.Boolean({ sensitive: true })),
		terminateOnForeground: Type.Optional(Type.Boolean({ sensitive: true })),
	},
	{ additionalProperties: false },
);

export const PiTeamsTelemetryConfigSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const PiTeamsPolicyConfigSchema = Type.Object(
	{
		requireIntentForDestructiveActions: Type.Optional(Type.Boolean({ sensitive: true })),
		disabledCapabilities: Type.Optional(Type.Array(Type.String(), { sensitive: true })),
	},
	{ additionalProperties: false },
);

export const PiTeamsNotificationsConfigSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		severityFilter: Type.Optional(
			Type.Array(Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error"), Type.Literal("critical")])),
		),
		dedupWindowMs: Type.Optional(Type.Integer({ minimum: 1000 })),
		batchWindowMs: Type.Optional(Type.Integer({ minimum: 0 })),
		quietHours: Type.Optional(Type.String({ pattern: "^\\d{2}:\\d{2}-\\d{2}:\\d{2}$" })),
		sinkRetentionDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
	},
	{ additionalProperties: false },
);

export const PiTeamsObservabilityConfigSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		pollIntervalMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000 })),
		metricRetentionDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
	},
	{ additionalProperties: false },
);

export const PiTeamsReliabilityConfigSchema = Type.Object(
	{
		autoRetry: Type.Optional(Type.Boolean()),
		retryPolicy: Type.Optional(
			Type.Object(
				{
					maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
					backoffMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60000 })),
					jitterRatio: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
					exponentialFactor: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
					retryableErrors: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
					// F19-2 (Round 19 parity): parsed at config-validation.ts but
					// additionalProperties:false previously rejected it at the schema level.
					maxTotalSpawns: Type.Optional(Type.Integer({ minimum: 0 })),
				},
				{ additionalProperties: false },
			),
		),
		autoRecover: Type.Optional(Type.Boolean()),
		deadletterThreshold: Type.Optional(Type.Integer({ minimum: 1 })),
		cleanupOrphanedTempDirs: Type.Optional(Type.Boolean()),
		autoRepairIntervalMs: Type.Optional(Type.Integer({ minimum: 0 })),
		forcePreflight: Type.Optional(Type.Boolean()),
		ambientStatusInjection: Type.Optional(Type.Boolean()),
		perWriteValidation: Type.Optional(Type.Boolean()),
		scopeModels: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const PiTeamsOtlpConfigSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		endpoint: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 2048,
				pattern: "^https?://",
				sensitive: true,
			}),
		),
		headers: Type.Optional(
			Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.String({ maxLength: 4096 }), { sensitive: true }),
		),
		intervalMs: Type.Optional(Type.Integer({ minimum: 5000 })),
	},
	{ additionalProperties: false },
);

export const PiTeamsUiConfigSchema = Type.Object(
	{
		widgetPlacement: Type.Optional(Type.Union([Type.Literal("aboveEditor"), Type.Literal("belowEditor"), Type.Literal("bottom")])),
		widgetMaxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
		powerbar: Type.Optional(Type.Boolean()),
		dashboardPlacement: Type.Optional(Type.Union([Type.Literal("center"), Type.Literal("right")])),
		dashboardWidth: Type.Optional(Type.Integer({ minimum: 32, maximum: 120 })),
		dashboardLiveRefreshMs: Type.Optional(Type.Integer({ minimum: 250, maximum: 60000 })),
		autoOpenDashboard: Type.Optional(Type.Boolean()),
		autoOpenDashboardForForegroundRuns: Type.Optional(Type.Boolean()),
		autoCloseDashboardMs: Type.Optional(Type.Integer({ minimum: 0 })),
		showModel: Type.Optional(Type.Boolean()),
		showTokens: Type.Optional(Type.Boolean()),
		showTools: Type.Optional(Type.Boolean()),
		transcriptTailBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 50 * 1024 * 1024 })),
		mascotStyle: Type.Optional(Type.Union([Type.Literal("cat"), Type.Literal("armin")])),
		mascotEffect: Type.Optional(
			Type.Union([
				Type.Literal("random"),
				Type.Literal("none"),
				Type.Literal("typewriter"),
				Type.Literal("scanline"),
				Type.Literal("rain"),
				Type.Literal("fade"),
				Type.Literal("crt"),
				Type.Literal("glitch"),
				Type.Literal("dissolve"),
			]),
		),
	},
	{ additionalProperties: false },
);

/** Phase 0 inter-pi broker config schema. Numeric limits are bounded per
 *  the plan: pathHashLen 4..32, maxFrameBytes 1024..1048576 (default 256 KiB),
 *  outboundQueueCap 32..4096 (default 256). */
export const CrewBrokerConfigSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		pathHashLen: Type.Optional(Type.Integer({ minimum: 4, maximum: 32 })),
		maxFrameBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 1_048_576 })),
		outboundQueueCap: Type.Optional(Type.Integer({ minimum: 32, maximum: 4096 })),
		/** WP-2/R2 (ADR-0 2026-08-17-waiting-producer-ask item 7): gate for the
		 *  broker wait.* methods. Default false — fail-closed. */
		waitMethodsEnabled: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const PiTeamsNestingConfigSchema = Type.Object(
	{
		// Privilege-raising flag (spawns grandchildren): project-level config must
		// not be able to enable it — sensitive → user config only (ADR-5 §12 posture,
		// same treatment as autonomous.enabled / broker gates).
		enabled: Type.Optional(Type.Boolean({ sensitive: true })),
		maxSlots: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
		maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
	},
	{ additionalProperties: false },
);

/** State-layer persistence schema (perf round 2, Task 3). Opt-in only.
 *  Does affect write cost, but never correctness: tasks.json is
 *  reconstructible from the fsync'd event log, so no privilege surface. */
export const PiTeamsPersistenceConfigSchema = Type.Object(
	{
		skipTasksFsync: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const PiTeamsConfigSchema = Type.Object(
	{
		asyncByDefault: Type.Optional(Type.Boolean({ sensitive: true })),
		executeWorkers: Type.Optional(Type.Boolean({ sensitive: true })),
		notifierIntervalMs: Type.Optional(Type.Number({ minimum: 1000 })),
		requireCleanWorktreeLeader: Type.Optional(Type.Boolean({ sensitive: true })),
		ignoreMethod: Type.Optional(Type.Union([Type.Literal("gitignore"), Type.Literal("exclude")])),
		autonomous: Type.Optional(PiTeamsAutonomousConfigSchema),
		limits: Type.Optional(PiTeamsLimitsConfigSchema),
		runtime: Type.Optional(PiTeamsRuntimeConfigSchema),
		control: Type.Optional(PiTeamsControlConfigSchema),
		worktree: Type.Optional(PiTeamsWorktreeConfigSchema),
		goalWrap: Type.Optional(PiTeamsGoalWrapConfigSchema),
		agents: Type.Optional(PiTeamsAgentsConfigSchema),
		tools: Type.Optional(PiTeamsToolsConfigSchema),
		telemetry: Type.Optional(PiTeamsTelemetryConfigSchema),
		policy: Type.Optional(PiTeamsPolicyConfigSchema),
		notifications: Type.Optional(PiTeamsNotificationsConfigSchema),
		observability: Type.Optional(PiTeamsObservabilityConfigSchema),
		reliability: Type.Optional(PiTeamsReliabilityConfigSchema),
		otlp: Type.Optional(PiTeamsOtlpConfigSchema),
		ui: Type.Optional(PiTeamsUiConfigSchema),
		broker: Type.Optional(CrewBrokerConfigSchema),
		nesting: Type.Optional(PiTeamsNestingConfigSchema),
		persistence: Type.Optional(PiTeamsPersistenceConfigSchema),
	},
	{ additionalProperties: false },
);

import { validateWithSeverity as _validateWithSeverity, type ValidationMode, type ValidationOutcome } from "./validation-types.ts";

/**
 * Convenience wrapper — validate a raw config value with severity-tagged findings.
 * Delegates to `validateWithSeverity` from validation-types.ts.
 */
export function validateConfig(raw: unknown, mode?: ValidationMode): ValidationOutcome {
	return _validateWithSeverity(raw, mode);
}

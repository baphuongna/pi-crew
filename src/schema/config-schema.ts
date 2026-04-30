import { Type } from "typebox";

export const PiTeamsAutonomyProfileSchema = Type.Union([
	Type.Literal("manual"),
	Type.Literal("suggested"),
	Type.Literal("assisted"),
	Type.Literal("aggressive"),
]);

export const PiTeamsAutonomousConfigSchema = Type.Object({
	profile: Type.Optional(PiTeamsAutonomyProfileSchema),
	enabled: Type.Optional(Type.Boolean()),
	injectPolicy: Type.Optional(Type.Boolean()),
	preferAsyncForLongTasks: Type.Optional(Type.Boolean()),
	allowWorktreeSuggestion: Type.Optional(Type.Boolean()),
	magicKeywords: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 })))),
}, { additionalProperties: false });

export const PiTeamsLimitsConfigSchema = Type.Object({
	maxConcurrentWorkers: Type.Optional(Type.Integer({ minimum: 1 })),
	allowUnboundedConcurrency: Type.Optional(Type.Boolean()),
	maxTaskDepth: Type.Optional(Type.Integer({ minimum: 1 })),
	maxChildrenPerTask: Type.Optional(Type.Integer({ minimum: 1 })),
	maxRunMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
	maxRetriesPerTask: Type.Optional(Type.Integer({ minimum: 1 })),
	maxTasksPerRun: Type.Optional(Type.Integer({ minimum: 1 })),
	heartbeatStaleMs: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

export const PiTeamsRuntimeConfigSchema = Type.Object({
	mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("scaffold"), Type.Literal("child-process"), Type.Literal("live-session")])),
	preferLiveSession: Type.Optional(Type.Boolean()),
	allowChildProcessFallback: Type.Optional(Type.Boolean()),
	maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
	graceTurns: Type.Optional(Type.Integer({ minimum: 1 })),
	inheritContext: Type.Optional(Type.Boolean()),
	promptMode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("append")])),
	groupJoin: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("group"), Type.Literal("smart")])),
	requirePlanApproval: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const PiTeamsControlConfigSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	needsAttentionAfterMs: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

export const PiTeamsWorktreeConfigSchema = Type.Object({
	setupHook: Type.Optional(Type.String({ minLength: 1 })),
	setupHookTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	linkNodeModules: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const AgentOverrideSchema = Type.Object({
	disabled: Type.Optional(Type.Boolean()),
	model: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Literal(false)])),
	fallbackModels: Type.Optional(Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Literal(false)])),
	thinking: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Literal(false)])),
	tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
}, { additionalProperties: false });

export const PiTeamsAgentsConfigSchema = Type.Object({
	disableBuiltins: Type.Optional(Type.Boolean()),
	overrides: Type.Optional(Type.Record(Type.String({ minLength: 1 }), AgentOverrideSchema)),
}, { additionalProperties: false });

export const PiTeamsToolsConfigSchema = Type.Object({
	enableClaudeStyleAliases: Type.Optional(Type.Boolean()),
	enableSteer: Type.Optional(Type.Boolean()),
	terminateOnForeground: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const PiTeamsTelemetryConfigSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const PiTeamsNotificationsConfigSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	severityFilter: Type.Optional(Type.Array(Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error"), Type.Literal("critical")]))),
	dedupWindowMs: Type.Optional(Type.Integer({ minimum: 1000 })),
	batchWindowMs: Type.Optional(Type.Integer({ minimum: 0 })),
	quietHours: Type.Optional(Type.String({ pattern: "^\\d{2}:\\d{2}-\\d{2}:\\d{2}$" })),
	sinkRetentionDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
}, { additionalProperties: false });

export const PiTeamsObservabilityConfigSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	pollIntervalMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000 })),
	metricRetentionDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
}, { additionalProperties: false });

export const PiTeamsReliabilityConfigSchema = Type.Object({
	autoRetry: Type.Optional(Type.Boolean()),
	retryPolicy: Type.Optional(Type.Object({
		maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		backoffMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60000 })),
		jitterRatio: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		exponentialFactor: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
		retryableErrors: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	}, { additionalProperties: false })),
	autoRecover: Type.Optional(Type.Boolean()),
	deadletterThreshold: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

export const PiTeamsOtlpConfigSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	endpoint: Type.Optional(Type.String({ minLength: 1 })),
	headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
	intervalMs: Type.Optional(Type.Integer({ minimum: 5000 })),
}, { additionalProperties: false });

export const PiTeamsUiConfigSchema = Type.Object({
	widgetPlacement: Type.Optional(Type.Union([Type.Literal("aboveEditor"), Type.Literal("belowEditor")])),
	widgetMaxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
	powerbar: Type.Optional(Type.Boolean()),
	dashboardPlacement: Type.Optional(Type.Union([Type.Literal("center"), Type.Literal("right")])),
	dashboardWidth: Type.Optional(Type.Integer({ minimum: 32, maximum: 120 })),
	dashboardLiveRefreshMs: Type.Optional(Type.Integer({ minimum: 250, maximum: 60000 })),
	autoOpenDashboard: Type.Optional(Type.Boolean()),
	autoOpenDashboardForForegroundRuns: Type.Optional(Type.Boolean()),
	showModel: Type.Optional(Type.Boolean()),
	showTokens: Type.Optional(Type.Boolean()),
	showTools: Type.Optional(Type.Boolean()),
	transcriptTailBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 50 * 1024 * 1024 })),
	mascotStyle: Type.Optional(Type.Union([Type.Literal("cat"), Type.Literal("armin")])),
	mascotEffect: Type.Optional(Type.Union([Type.Literal("random"), Type.Literal("none"), Type.Literal("typewriter"), Type.Literal("scanline"), Type.Literal("rain"), Type.Literal("fade"), Type.Literal("crt"), Type.Literal("glitch"), Type.Literal("dissolve")])),
}, { additionalProperties: false });

export const PiTeamsConfigSchema = Type.Object({
	asyncByDefault: Type.Optional(Type.Boolean()),
	executeWorkers: Type.Optional(Type.Boolean()),
	notifierIntervalMs: Type.Optional(Type.Number({ minimum: 1000 })),
	requireCleanWorktreeLeader: Type.Optional(Type.Boolean()),
	autonomous: Type.Optional(PiTeamsAutonomousConfigSchema),
	limits: Type.Optional(PiTeamsLimitsConfigSchema),
	runtime: Type.Optional(PiTeamsRuntimeConfigSchema),
	control: Type.Optional(PiTeamsControlConfigSchema),
	worktree: Type.Optional(PiTeamsWorktreeConfigSchema),
	agents: Type.Optional(PiTeamsAgentsConfigSchema),
	tools: Type.Optional(PiTeamsToolsConfigSchema),
	telemetry: Type.Optional(PiTeamsTelemetryConfigSchema),
	notifications: Type.Optional(PiTeamsNotificationsConfigSchema),
	observability: Type.Optional(PiTeamsObservabilityConfigSchema),
	reliability: Type.Optional(PiTeamsReliabilityConfigSchema),
	otlp: Type.Optional(PiTeamsOtlpConfigSchema),
	ui: Type.Optional(PiTeamsUiConfigSchema),
}, { additionalProperties: false });

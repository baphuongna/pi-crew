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
});

export const PiTeamsLimitsConfigSchema = Type.Object({
	maxConcurrentWorkers: Type.Optional(Type.Integer({ minimum: 1 })),
	allowUnboundedConcurrency: Type.Optional(Type.Boolean()),
	maxTaskDepth: Type.Optional(Type.Integer({ minimum: 1 })),
	maxChildrenPerTask: Type.Optional(Type.Integer({ minimum: 1 })),
	maxRunMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
	maxRetriesPerTask: Type.Optional(Type.Integer({ minimum: 1 })),
	maxTasksPerRun: Type.Optional(Type.Integer({ minimum: 1 })),
	heartbeatStaleMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const PiTeamsRuntimeConfigSchema = Type.Object({
	mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("scaffold"), Type.Literal("child-process"), Type.Literal("live-session")])),
	preferLiveSession: Type.Optional(Type.Boolean()),
	allowChildProcessFallback: Type.Optional(Type.Boolean()),
	maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
	graceTurns: Type.Optional(Type.Integer({ minimum: 1 })),
	inheritContext: Type.Optional(Type.Boolean()),
	promptMode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("append")])),
	groupJoin: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("group"), Type.Literal("smart")])),
});

export const PiTeamsControlConfigSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	needsAttentionAfterMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const PiTeamsWorktreeConfigSchema = Type.Object({
	setupHook: Type.Optional(Type.String({ minLength: 1 })),
	setupHookTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	linkNodeModules: Type.Optional(Type.Boolean()),
});

export const AgentOverrideSchema = Type.Object({
	disabled: Type.Optional(Type.Boolean()),
	model: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Literal(false)])),
	fallbackModels: Type.Optional(Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Literal(false)])),
	thinking: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Literal(false)])),
	tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

export const PiTeamsAgentsConfigSchema = Type.Object({
	disableBuiltins: Type.Optional(Type.Boolean()),
	overrides: Type.Optional(Type.Record(Type.String({ minLength: 1 }), AgentOverrideSchema)),
});

export const PiTeamsUiConfigSchema = Type.Object({
	widgetPlacement: Type.Optional(Type.Union([Type.Literal("aboveEditor"), Type.Literal("belowEditor")])),
	widgetMaxLines: Type.Optional(Type.Integer({ minimum: 1 })),
	powerbar: Type.Optional(Type.Boolean()),
	dashboardPlacement: Type.Optional(Type.Union([Type.Literal("center"), Type.Literal("right")])),
	dashboardWidth: Type.Optional(Type.Integer({ minimum: 1 })),
	dashboardLiveRefreshMs: Type.Optional(Type.Number({ minimum: 1 })),
	autoOpenDashboard: Type.Optional(Type.Boolean()),
	autoOpenDashboardForForegroundRuns: Type.Optional(Type.Boolean()),
	showModel: Type.Optional(Type.Boolean()),
	showTokens: Type.Optional(Type.Boolean()),
	showTools: Type.Optional(Type.Boolean()),
	mascotStyle: Type.Optional(Type.Union([Type.Literal("cat"), Type.Literal("armin")])),
	mascotEffect: Type.Optional(Type.Union([Type.Literal("random"), Type.Literal("none"), Type.Literal("typewriter"), Type.Literal("scanline"), Type.Literal("rain"), Type.Literal("fade"), Type.Literal("crt"), Type.Literal("glitch"), Type.Literal("dissolve")])),
});

export const PiTeamsConfigSchema = Type.Object({
	asyncByDefault: Type.Optional(Type.Boolean()),
	executeWorkers: Type.Optional(Type.Boolean()),
	notifierIntervalMs: Type.Optional(Type.Integer({ minimum: 1000 })),
	requireCleanWorktreeLeader: Type.Optional(Type.Boolean()),
	autonomous: Type.Optional(PiTeamsAutonomousConfigSchema),
	limits: Type.Optional(PiTeamsLimitsConfigSchema),
	runtime: Type.Optional(PiTeamsRuntimeConfigSchema),
	control: Type.Optional(PiTeamsControlConfigSchema),
	worktree: Type.Optional(PiTeamsWorktreeConfigSchema),
	agents: Type.Optional(PiTeamsAgentsConfigSchema),
	ui: Type.Optional(PiTeamsUiConfigSchema),
});

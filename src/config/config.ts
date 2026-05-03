import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PiTeamsAutonomyProfileSchema, PiTeamsConfigSchema } from "../schema/config-schema.ts";
import { projectCrewRoot } from "../utils/paths.ts";

export type PiTeamsAutonomyProfile = "manual" | "suggested" | "assisted" | "aggressive";

export interface PiTeamsAutonomousConfig {
	profile?: PiTeamsAutonomyProfile;
	enabled?: boolean;
	injectPolicy?: boolean;
	preferAsyncForLongTasks?: boolean;
	allowWorktreeSuggestion?: boolean;
	magicKeywords?: Record<string, string[]>;
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

export type CrewRuntimeMode = "auto" | "scaffold" | "child-process" | "live-session";

export type CompletionMutationGuardMode = "off" | "warn" | "fail";

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
}

export interface CrewControlConfig {
	enabled?: boolean;
	needsAttentionAfterMs?: number;
}

export interface CrewWorktreeConfig {
	setupHook?: string;
	setupHookTimeoutMs?: number;
	linkNodeModules?: boolean;
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
	showModel?: boolean;
	showTokens?: boolean;
	showTools?: boolean;
	transcriptTailBytes?: number;
	mascotStyle?: "cat" | "armin";
	mascotEffect?: "random" | "none" | "typewriter" | "scanline" | "rain" | "fade" | "crt" | "glitch" | "dissolve";
}

export interface AgentOverrideConfig {
	disabled?: boolean;
	model?: string | false;
	fallbackModels?: string[] | false;
	thinking?: string | false;
	tools?: string[] | false;
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

export type CrewNotificationSeverity = "info" | "warning" | "error" | "critical";

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
	autonomous?: PiTeamsAutonomousConfig;
	limits?: CrewLimitsConfig;
	runtime?: CrewRuntimeConfig;
	control?: CrewControlConfig;
	worktree?: CrewWorktreeConfig;
	agents?: CrewAgentsConfig;
	tools?: CrewToolsConfig;
	telemetry?: CrewTelemetryConfig;
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

export function configPath(): string {
	const home = process.env.PI_TEAMS_HOME?.trim() || os.homedir();
	return path.join(home, ".pi", "agent", "extensions", "pi-crew", "config.json");
}

export function projectConfigPath(cwd: string): string {
	return path.join(projectCrewRoot(cwd), "config.json");
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function errorPathFromValidation(error: unknown): string {
	if (error && typeof error === "object") {
		if (typeof (error as { path?: unknown }).path === "string") return (error as { path: string }).path;
		if (typeof (error as { instancePath?: unknown }).instancePath === "string") return (error as { instancePath: string }).instancePath;
		if (typeof (error as { keyword?: unknown }).keyword === "string" && typeof (error as { schemaPath?: unknown }).schemaPath === "string") return (error as { schemaPath: string }).schemaPath;
	}
	return "config";
}

function validateConfigWithWarnings(raw: unknown): string[] {
	if (!Value.Check(PiTeamsConfigSchema, raw)) {
		return [...Value.Errors(PiTeamsConfigSchema, raw)].map((error) => {
			return `${errorPathFromValidation(error)}: ${(error as { message?: unknown }).message ?? "invalid value"}`;
		});
	}
	return [];
}

function projectOverrideWarning(projectPath: string, dottedPath: string): string {
	return `${projectPath}: project-level sensitive config '${dottedPath}' is ignored; set it in user config to trust it explicitly`;
}

function sanitizeProjectConfig(projectPath: string, userConfig: PiTeamsConfig, config: PiTeamsConfig): ConfigValidationResult {
	const sanitized: PiTeamsConfig = { ...config };
	const warnings: string[] = [];
	const dropTopLevel = (key: keyof PiTeamsConfig): void => {
		if (config[key] === undefined) return;
		delete sanitized[key];
		warnings.push(projectOverrideWarning(projectPath, String(key)));
	};
	dropTopLevel("executeWorkers");
	dropTopLevel("asyncByDefault");
	dropTopLevel("requireCleanWorktreeLeader");
	if (config.runtime) {
		const runtime = { ...config.runtime };
		for (const key of ["mode", "preferLiveSession", "allowChildProcessFallback", "inheritContext"] as const) {
			if (runtime[key] !== undefined) {
				delete runtime[key];
				warnings.push(projectOverrideWarning(projectPath, `runtime.${key}`));
			}
		}
		if (runtime.requirePlanApproval === false) {
			delete runtime.requirePlanApproval;
			warnings.push(projectOverrideWarning(projectPath, "runtime.requirePlanApproval"));
		}
		sanitized.runtime = Object.values(runtime).some((entry) => entry !== undefined) ? runtime : undefined;
	}
	if (config.autonomous) {
		const autonomous = { ...config.autonomous };
		for (const key of ["profile", "enabled", "injectPolicy", "preferAsyncForLongTasks", "allowWorktreeSuggestion"] as const) {
			if (autonomous[key] !== undefined) {
				delete autonomous[key];
				warnings.push(projectOverrideWarning(projectPath, `autonomous.${key}`));
			}
		}
		sanitized.autonomous = Object.values(autonomous).some((entry) => entry !== undefined) ? autonomous : undefined;
	}
	if (config.worktree?.setupHook !== undefined) {
		sanitized.worktree = { ...config.worktree, setupHook: undefined };
		if (!Object.values(sanitized.worktree).some((entry) => entry !== undefined)) sanitized.worktree = undefined;
		warnings.push(projectOverrideWarning(projectPath, "worktree.setupHook"));
	}
	if (config.otlp?.headers !== undefined) {
		sanitized.otlp = { ...config.otlp, headers: undefined };
		if (!Object.values(sanitized.otlp).some((entry) => entry !== undefined)) sanitized.otlp = undefined;
		warnings.push(projectOverrideWarning(projectPath, "otlp.headers"));
	}
	if (config.agents?.disableBuiltins !== undefined || config.agents?.overrides !== undefined) {
		const agents = { ...config.agents };
		if (agents.disableBuiltins !== undefined) {
			delete agents.disableBuiltins;
			warnings.push(projectOverrideWarning(projectPath, "agents.disableBuiltins"));
		}
		if (agents.overrides !== undefined) {
			delete agents.overrides;
			warnings.push(projectOverrideWarning(projectPath, "agents.overrides"));
		}
		sanitized.agents = Object.values(agents).some((entry) => entry !== undefined) ? agents : undefined;
	}
	if (config.tools?.enableSteer !== undefined || config.tools?.terminateOnForeground !== undefined) {
		const tools = { ...config.tools };
		if (tools.enableSteer !== undefined) {
			delete tools.enableSteer;
			warnings.push(projectOverrideWarning(projectPath, "tools.enableSteer"));
		}
		if (tools.terminateOnForeground !== undefined) {
			delete tools.terminateOnForeground;
			warnings.push(projectOverrideWarning(projectPath, "tools.terminateOnForeground"));
		}
		sanitized.tools = Object.values(tools).some((entry) => entry !== undefined) ? tools : undefined;
	}
	return { config: sanitized, warnings };
}

function mergeConfig(base: PiTeamsConfig, override: PiTeamsConfig): PiTeamsConfig {
	const merged: PiTeamsConfig = { ...base, ...withoutUndefined(override as Record<string, unknown>) };
	if (base.autonomous || override.autonomous) {
		merged.autonomous = {
			...(base.autonomous ?? {}),
			...withoutUndefined((override.autonomous ?? {}) as Record<string, unknown>),
		};
	}
	if (base.limits || override.limits) {
		merged.limits = {
			...(base.limits ?? {}),
			...withoutUndefined((override.limits ?? {}) as Record<string, unknown>),
		};
	}
	if (base.runtime || override.runtime) {
		merged.runtime = {
			...(base.runtime ?? {}),
			...withoutUndefined((override.runtime ?? {}) as Record<string, unknown>),
		};
	}
	if (base.control || override.control) {
		merged.control = {
			...(base.control ?? {}),
			...withoutUndefined((override.control ?? {}) as Record<string, unknown>),
		};
	}
	if (base.worktree || override.worktree) {
		merged.worktree = {
			...(base.worktree ?? {}),
			...withoutUndefined((override.worktree ?? {}) as Record<string, unknown>),
		};
	}
	if (base.ui || override.ui) {
		merged.ui = {
			...(base.ui ?? {}),
			...withoutUndefined((override.ui ?? {}) as Record<string, unknown>),
		};
	}
	if (base.agents || override.agents) {
		merged.agents = {
			...(base.agents ?? {}),
			...withoutUndefined((override.agents ?? {}) as Record<string, unknown>),
			overrides: {
				...(base.agents?.overrides ?? {}),
				...withoutUndefined((override.agents?.overrides ?? {}) as Record<string, unknown>) as Record<string, AgentOverrideConfig>,
			},
		};
	}
	if (base.tools || override.tools) {
		merged.tools = {
			...(base.tools ?? {}),
			...withoutUndefined((override.tools ?? {}) as Record<string, unknown>),
		};
	}
	if (base.telemetry || override.telemetry) {
		merged.telemetry = {
			...(base.telemetry ?? {}),
			...withoutUndefined((override.telemetry ?? {}) as Record<string, unknown>),
		};
	}
	if (base.notifications || override.notifications) {
		merged.notifications = {
			...(base.notifications ?? {}),
			...withoutUndefined((override.notifications ?? {}) as Record<string, unknown>),
		};
	}
	if (base.observability || override.observability) {
		merged.observability = {
			...(base.observability ?? {}),
			...withoutUndefined((override.observability ?? {}) as Record<string, unknown>),
		};
	}
	if (base.reliability || override.reliability) {
		merged.reliability = {
			...(base.reliability ?? {}),
			...withoutUndefined((override.reliability ?? {}) as Record<string, unknown>),
			retryPolicy: base.reliability?.retryPolicy || override.reliability?.retryPolicy ? { ...(base.reliability?.retryPolicy ?? {}), ...withoutUndefined((override.reliability?.retryPolicy ?? {}) as Record<string, unknown>) } : undefined,
		};
	}
	if (base.otlp || override.otlp) {
		merged.otlp = {
			...(base.otlp ?? {}),
			...withoutUndefined((override.otlp ?? {}) as Record<string, unknown>),
			headers: { ...(base.otlp?.headers ?? {}), ...(override.otlp?.headers ?? {}) },
		};
		if (Object.keys(merged.otlp.headers ?? {}).length === 0) delete merged.otlp.headers;
	}
	if (merged.agents?.overrides && Object.keys(merged.agents.overrides).length === 0) delete merged.agents.overrides;
	return merged;
}

const LIMIT_CEILINGS = {
	maxConcurrentWorkers: 1024,
	maxTaskDepth: 100,
	maxChildrenPerTask: 1000,
	maxRunMinutes: 1440,
	maxRetriesPerTask: 100,
	maxTasksPerRun: 10_000,
	heartbeatStaleMs: 24 * 60 * 60 * 1000,
	runtimeMaxTurns: 10_000,
	runtimeGraceTurns: 1_000,
} as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function parseWithSchema<T extends TSchema>(schema: T, value: unknown): Static<T> | undefined {
	if (!Value.Check(schema, value)) return undefined;
	return Value.Decode(schema, value);
}

function parseIntegerInRange(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
	return parseWithSchema(Type.Integer({ minimum, maximum }), value);
}

function parsePositiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
	return parseIntegerInRange(value, 1, max);
}

function parseProfile(value: unknown): PiTeamsAutonomyProfile | undefined {
	return parseWithSchema(PiTeamsAutonomyProfileSchema, value);
}

function parseStringList(value: unknown): string[] | undefined {
	const items = parseWithSchema(Type.Array(Type.String()), value);
	if (!items || items.length === 0) return undefined;
	const normalized = items.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	return normalized.length > 0 ? normalized : undefined;
}

function parseStringArrayOrFalse(value: unknown): string[] | false | undefined {
	if (value === false) return false;
	if (typeof value === "string") return parseStringList(value.split(","));
	return parseStringList(value);
}

export function effectiveAutonomousConfig(config: PiTeamsAutonomousConfig | undefined): Required<Pick<PiTeamsAutonomousConfig, "profile" | "enabled" | "injectPolicy" | "preferAsyncForLongTasks" | "allowWorktreeSuggestion">> & Pick<PiTeamsAutonomousConfig, "magicKeywords"> {
	const profile = config?.enabled === false ? "manual" : (config?.profile ?? "suggested");
	const profileDefaults: Record<PiTeamsAutonomyProfile, { enabled: boolean; injectPolicy: boolean; preferAsyncForLongTasks: boolean; allowWorktreeSuggestion: boolean }> = {
		manual: { enabled: false, injectPolicy: false, preferAsyncForLongTasks: false, allowWorktreeSuggestion: false },
		suggested: { enabled: true, injectPolicy: true, preferAsyncForLongTasks: false, allowWorktreeSuggestion: true },
		assisted: { enabled: true, injectPolicy: true, preferAsyncForLongTasks: true, allowWorktreeSuggestion: true },
		aggressive: { enabled: true, injectPolicy: true, preferAsyncForLongTasks: true, allowWorktreeSuggestion: true },
	};
	const defaults = profileDefaults[profile];
	return {
		profile,
		enabled: config?.enabled ?? defaults.enabled,
		injectPolicy: config?.injectPolicy ?? defaults.injectPolicy,
		preferAsyncForLongTasks: config?.preferAsyncForLongTasks ?? defaults.preferAsyncForLongTasks,
		allowWorktreeSuggestion: config?.allowWorktreeSuggestion ?? defaults.allowWorktreeSuggestion,
		magicKeywords: config?.magicKeywords,
	};
}

function parseStringArrayRecord(value: unknown): Record<string, string[]> | undefined {
	const record = parseWithSchema(Type.Record(Type.String({ minLength: 1 }), Type.Array(Type.String())), value);
	if (!record) return undefined;
	const result: Record<string, string[]> = {};
	for (const [key, rawValues] of Object.entries(record)) {
		const parsed = parseStringList(rawValues);
		if (parsed && parsed.length > 0) result[key] = parsed;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function parseAutonomousConfig(value: unknown): PiTeamsAutonomousConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const config: PiTeamsAutonomousConfig = {
		profile: parseProfile(obj.profile),
		enabled: parseWithSchema(Type.Boolean(), obj.enabled),
		injectPolicy: parseWithSchema(Type.Boolean(), obj.injectPolicy),
		preferAsyncForLongTasks: parseWithSchema(Type.Boolean(), obj.preferAsyncForLongTasks),
		allowWorktreeSuggestion: parseWithSchema(Type.Boolean(), obj.allowWorktreeSuggestion),
		magicKeywords: parseStringArrayRecord(obj.magicKeywords),
	};
	return Object.values(config).some((entry) => entry !== undefined) ? config : undefined;
}

function parseLimitsConfig(value: unknown): CrewLimitsConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const limits: CrewLimitsConfig = {
		maxConcurrentWorkers: parsePositiveInteger(obj.maxConcurrentWorkers, LIMIT_CEILINGS.maxConcurrentWorkers),
		allowUnboundedConcurrency: parseWithSchema(Type.Boolean(), obj.allowUnboundedConcurrency),
		maxTaskDepth: parsePositiveInteger(obj.maxTaskDepth, LIMIT_CEILINGS.maxTaskDepth),
		maxChildrenPerTask: parsePositiveInteger(obj.maxChildrenPerTask, LIMIT_CEILINGS.maxChildrenPerTask),
		maxRunMinutes: parsePositiveInteger(obj.maxRunMinutes, LIMIT_CEILINGS.maxRunMinutes),
		maxRetriesPerTask: parsePositiveInteger(obj.maxRetriesPerTask, LIMIT_CEILINGS.maxRetriesPerTask),
		maxTasksPerRun: parsePositiveInteger(obj.maxTasksPerRun, LIMIT_CEILINGS.maxTasksPerRun),
		heartbeatStaleMs: parsePositiveInteger(obj.heartbeatStaleMs, LIMIT_CEILINGS.heartbeatStaleMs),
	};
	return Object.values(limits).some((entry) => entry !== undefined) ? limits : undefined;
}

function parseRuntimeConfig(value: unknown): CrewRuntimeConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const runtime: CrewRuntimeConfig = {
		mode: parseWithSchema(Type.Union([Type.Literal("auto"), Type.Literal("scaffold"), Type.Literal("child-process"), Type.Literal("live-session")]), obj.mode),
		preferLiveSession: parseWithSchema(Type.Boolean(), obj.preferLiveSession),
		allowChildProcessFallback: parseWithSchema(Type.Boolean(), obj.allowChildProcessFallback),
		maxTurns: parsePositiveInteger(obj.maxTurns, LIMIT_CEILINGS.runtimeMaxTurns),
		graceTurns: parsePositiveInteger(obj.graceTurns, LIMIT_CEILINGS.runtimeGraceTurns),
		inheritContext: parseWithSchema(Type.Boolean(), obj.inheritContext),
		promptMode: parseWithSchema(Type.Union([Type.Literal("replace"), Type.Literal("append")]), obj.promptMode),
		groupJoin: parseWithSchema(Type.Union([Type.Literal("off"), Type.Literal("group"), Type.Literal("smart")]), obj.groupJoin),
		groupJoinAckTimeoutMs: parsePositiveInteger(obj.groupJoinAckTimeoutMs, 86_400_000),
		requirePlanApproval: parseWithSchema(Type.Boolean(), obj.requirePlanApproval),
		completionMutationGuard: parseWithSchema(Type.Union([Type.Literal("off"), Type.Literal("warn"), Type.Literal("fail")]), obj.completionMutationGuard),
	};
	return Object.values(runtime).some((entry) => entry !== undefined) ? runtime : undefined;
}

function parseControlConfig(value: unknown): CrewControlConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const control: CrewControlConfig = {
		enabled: parseWithSchema(Type.Boolean(), obj.enabled),
		needsAttentionAfterMs: parsePositiveInteger(obj.needsAttentionAfterMs),
	};
	return Object.values(control).some((entry) => entry !== undefined) ? control : undefined;
}

function parseWorktreeConfig(value: unknown): CrewWorktreeConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const rawSetupHook = parseWithSchema(Type.String(), obj.setupHook);
	const setupHook = rawSetupHook?.trim();
	const worktree: CrewWorktreeConfig = {
		setupHook: setupHook ? setupHook : undefined,
		setupHookTimeoutMs: parsePositiveInteger(obj.setupHookTimeoutMs, 300_000),
		linkNodeModules: parseWithSchema(Type.Boolean(), obj.linkNodeModules),
	};
	return Object.values(worktree).some((entry) => entry !== undefined) ? worktree : undefined;
}

function parseAgentOverride(value: unknown): AgentOverrideConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const override: AgentOverrideConfig = {
		disabled: parseWithSchema(Type.Boolean(), obj.disabled),
		model: parseWithSchema(Type.Union([Type.String(), Type.Literal(false)]), obj.model),
		fallbackModels: parseStringArrayOrFalse(obj.fallbackModels),
		thinking: parseWithSchema(Type.Union([Type.String(), Type.Literal(false)]), obj.thinking),
		tools: parseStringArrayOrFalse(obj.tools),
	};
	return Object.values(override).some((entry) => entry !== undefined) ? override : undefined;
}

function parseUiConfig(value: unknown): CrewUiConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const rawWidgetPlacement = parseWithSchema(Type.Union([Type.Literal("aboveEditor"), Type.Literal("belowEditor")]), obj.widgetPlacement);
	const rawDashboardPlacement = parseWithSchema(Type.Union([Type.Literal("center"), Type.Literal("right")]), obj.dashboardPlacement);
	const ui: CrewUiConfig = {
		widgetPlacement: rawWidgetPlacement,
		widgetMaxLines: parsePositiveInteger(obj.widgetMaxLines, 50),
		powerbar: parseWithSchema(Type.Boolean(), obj.powerbar),
		dashboardPlacement: rawDashboardPlacement,
		dashboardWidth: parseIntegerInRange(obj.dashboardWidth, 32, 120),
		dashboardLiveRefreshMs: parseIntegerInRange(obj.dashboardLiveRefreshMs, 250, 60_000),
		autoOpenDashboard: parseWithSchema(Type.Boolean(), obj.autoOpenDashboard),
		autoOpenDashboardForForegroundRuns: parseWithSchema(Type.Boolean(), obj.autoOpenDashboardForForegroundRuns),
		showModel: parseWithSchema(Type.Boolean(), obj.showModel),
		showTokens: parseWithSchema(Type.Boolean(), obj.showTokens),
		showTools: parseWithSchema(Type.Boolean(), obj.showTools),
		transcriptTailBytes: parseIntegerInRange(obj.transcriptTailBytes, 1024, 50 * 1024 * 1024),
		mascotStyle: parseWithSchema(Type.Union([Type.Literal("cat"), Type.Literal("armin")]), obj.mascotStyle),
		mascotEffect: parseWithSchema(Type.Union([Type.Literal("random"), Type.Literal("none"), Type.Literal("typewriter"), Type.Literal("scanline"), Type.Literal("rain"), Type.Literal("fade"), Type.Literal("crt"), Type.Literal("glitch"), Type.Literal("dissolve")]), obj.mascotEffect),
	};
	return Object.values(ui).some((entry) => entry !== undefined) ? ui : undefined;
}

function parseAgentsConfig(value: unknown): CrewAgentsConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const overrides: Record<string, AgentOverrideConfig> = {};
	if (obj.overrides && typeof obj.overrides === "object" && !Array.isArray(obj.overrides)) {
		for (const [name, rawOverride] of Object.entries(obj.overrides as Record<string, unknown>)) {
			const parsed = parseAgentOverride(rawOverride);
			if (parsed && name.trim()) overrides[name.trim()] = parsed;
		}
	}
	const agents: CrewAgentsConfig = {
		disableBuiltins: parseWithSchema(Type.Boolean(), obj.disableBuiltins),
		overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
	};
	return Object.values(agents).some((entry) => entry !== undefined) ? agents : undefined;
}

function parseToolsConfig(value: unknown): CrewToolsConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const tools: CrewToolsConfig = {
		enableClaudeStyleAliases: parseWithSchema(Type.Boolean(), obj.enableClaudeStyleAliases),
		enableSteer: parseWithSchema(Type.Boolean(), obj.enableSteer),
		terminateOnForeground: parseWithSchema(Type.Boolean(), obj.terminateOnForeground),
	};
	return Object.values(tools).some((entry) => entry !== undefined) ? tools : undefined;
}

function parseTelemetryConfig(value: unknown): CrewTelemetryConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const telemetry: CrewTelemetryConfig = {
		enabled: parseWithSchema(Type.Boolean(), obj.enabled),
	};
	return Object.values(telemetry).some((entry) => entry !== undefined) ? telemetry : undefined;
}

function parseNotificationsConfig(value: unknown): CrewNotificationsConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const notifications: CrewNotificationsConfig = {
		enabled: parseWithSchema(Type.Boolean(), obj.enabled),
		severityFilter: parseWithSchema(Type.Array(Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error"), Type.Literal("critical")])), obj.severityFilter),
		dedupWindowMs: parsePositiveInteger(obj.dedupWindowMs, 24 * 60 * 60 * 1000),
		batchWindowMs: parseWithSchema(Type.Integer({ minimum: 0, maximum: 60_000 }), obj.batchWindowMs),
		quietHours: parseWithSchema(Type.String({ pattern: "^\\d{2}:\\d{2}-\\d{2}:\\d{2}$" }), obj.quietHours),
		sinkRetentionDays: parsePositiveInteger(obj.sinkRetentionDays, 90),
	};
	return Object.values(notifications).some((entry) => entry !== undefined) ? notifications : undefined;
}

function parseObservabilityConfig(value: unknown): CrewObservabilityConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const observability: CrewObservabilityConfig = {
		enabled: parseWithSchema(Type.Boolean(), obj.enabled),
		pollIntervalMs: parseWithSchema(Type.Integer({ minimum: 1000, maximum: 60_000 }), obj.pollIntervalMs),
		metricRetentionDays: parsePositiveInteger(obj.metricRetentionDays, 365),
	};
	return Object.values(observability).some((entry) => entry !== undefined) ? observability : undefined;
}

function parseReliabilityConfig(value: unknown): CrewReliabilityConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const retryObj = asRecord(obj.retryPolicy);
	const retryPolicy: CrewRetryPolicyConfig | undefined = retryObj ? {
		maxAttempts: parsePositiveInteger(retryObj.maxAttempts, 10),
		backoffMs: parseWithSchema(Type.Integer({ minimum: 100, maximum: 60_000 }), retryObj.backoffMs),
		jitterRatio: parseWithSchema(Type.Number({ minimum: 0, maximum: 1 }), retryObj.jitterRatio),
		exponentialFactor: parseWithSchema(Type.Number({ minimum: 1, maximum: 5 }), retryObj.exponentialFactor),
		retryableErrors: parseStringList(retryObj.retryableErrors),
	} : undefined;
	const reliability: CrewReliabilityConfig = {
		autoRetry: parseWithSchema(Type.Boolean(), obj.autoRetry),
		retryPolicy: retryPolicy && Object.values(retryPolicy).some((entry) => entry !== undefined) ? retryPolicy : undefined,
		autoRecover: parseWithSchema(Type.Boolean(), obj.autoRecover),
		deadletterThreshold: parsePositiveInteger(obj.deadletterThreshold),
	};
	return Object.values(reliability).some((entry) => entry !== undefined) ? reliability : undefined;
}

function parseOtlpConfig(value: unknown): CrewOtlpConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const headers: Record<string, string> = Object.create(null);
	const rawHeaders = asRecord(obj.headers);
	if (rawHeaders) for (const [key, entry] of Object.entries(rawHeaders)) {
		if (typeof entry !== "string") continue;
		// Prevent prototype pollution via __proto__ / constructor / prototype keys.
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		headers[key] = entry;
	}
	const otlp: CrewOtlpConfig = {
		enabled: parseWithSchema(Type.Boolean(), obj.enabled),
		endpoint: parseWithSchema(Type.String({ minLength: 1 }), obj.endpoint),
		headers: Object.keys(headers).length > 0 ? headers : undefined,
		intervalMs: parseWithSchema(Type.Integer({ minimum: 5000 }), obj.intervalMs),
	};
	return Object.values(otlp).some((entry) => entry !== undefined) ? otlp : undefined;
}

export function parseConfig(raw: unknown): PiTeamsConfig {
	const obj = asRecord(raw);
	if (!obj) return {};
	return {
		asyncByDefault: parseWithSchema(Type.Boolean(), obj.asyncByDefault),
		executeWorkers: parseWithSchema(Type.Boolean(), obj.executeWorkers),
		notifierIntervalMs: parseWithSchema(Type.Number({ minimum: 1_000 }), obj.notifierIntervalMs),
		requireCleanWorktreeLeader: parseWithSchema(Type.Boolean(), obj.requireCleanWorktreeLeader),
		autonomous: parseAutonomousConfig(obj.autonomous),
		limits: parseLimitsConfig(obj.limits),
		runtime: parseRuntimeConfig(obj.runtime),
		control: parseControlConfig(obj.control),
		worktree: parseWorktreeConfig(obj.worktree),
		agents: parseAgentsConfig(obj.agents),
		tools: parseToolsConfig(obj.tools),
		telemetry: parseTelemetryConfig(obj.telemetry),
		notifications: parseNotificationsConfig(obj.notifications),
		observability: parseObservabilityConfig(obj.observability),
		reliability: parseReliabilityConfig(obj.reliability),
		otlp: parseOtlpConfig(obj.otlp),
		ui: parseUiConfig(obj.ui),
	};
}

export function parseConfigWithWarnings(raw: unknown): ConfigValidationResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config: {}, warnings: [] };
	const parsed = parseConfig(raw);
	const warnings = validateConfigWithWarnings(raw as Record<string, unknown>);
	return { config: parsed, warnings };
}


function unsetPath(record: Record<string, unknown>, dottedPath: string): void {
	const parts = dottedPath.split(".").filter(Boolean);
	if (parts.length === 0) return;
	let target: Record<string, unknown> = record;
	for (const part of parts.slice(0, -1)) {
		const current = target[part];
		if (!current || typeof current !== "object" || Array.isArray(current)) return;
		target = current as Record<string, unknown>;
	}
	delete target[parts[parts.length - 1]!];
}

function readConfigRecord(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	return raw as Record<string, unknown>;
}

export function loadConfig(cwd?: string): LoadedPiTeamsConfig {
	const filePath = configPath();
	const paths = cwd ? [filePath, projectConfigPath(cwd)] : [filePath];
	try {
		const userRaw = readConfigRecord(filePath);
		const userConfig = parseConfigWithWarnings(userRaw);
		let config = userConfig.config;
		const warnings: string[] = userConfig.warnings.map((warning) => `${filePath}: ${warning}`);
		if (cwd) {
			const projectPath = projectConfigPath(cwd);
			const projectConfig = parseConfigWithWarnings(readConfigRecord(projectPath));
			const projectSafeConfig = sanitizeProjectConfig(projectPath, config, projectConfig.config);
			warnings.push(...projectConfig.warnings.map((warning) => `${projectPath}: ${warning}`), ...projectSafeConfig.warnings);
			config = mergeConfig(config, projectSafeConfig.config);
		}
		return { path: filePath, paths, config, warnings: warnings.length > 0 ? warnings : undefined };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { path: filePath, paths, config: {}, error: message };
	}
}

export function updateConfig(patch: PiTeamsConfig, options: UpdateConfigOptions = {}): SavedPiTeamsConfig {
	const filePath = options.scope === "project" && options.cwd ? projectConfigPath(options.cwd) : configPath();
	let current: Record<string, unknown>;
	try {
		current = readConfigRecord(filePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not update pi-crew config: ${message}`);
	}
	let merged = mergeConfig(parseConfig(current), patch);
	if (options.unsetPaths?.length) {
		const raw = JSON.parse(JSON.stringify(merged)) as Record<string, unknown>;
		for (const unset of options.unsetPaths) unsetPath(raw, unset);
		merged = parseConfig(raw);
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
	return { path: filePath, config: merged };
}

export function updateAutonomousConfig(patch: PiTeamsAutonomousConfig): SavedPiTeamsConfig {
	const filePath = configPath();
	let current: Record<string, unknown>;
	try {
		current = readConfigRecord(filePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not update pi-crew config: ${message}`);
	}
	const currentAutonomous = current.autonomous && typeof current.autonomous === "object" && !Array.isArray(current.autonomous)
		? current.autonomous as Record<string, unknown>
		: {};
	current.autonomous = { ...currentAutonomous, ...patch };
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`, "utf-8");
	return { path: filePath, config: parseConfig(current) };
}

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { PiTeamsAutonomyProfileSchema, PiTeamsConfigSchema } from "../schema/config-schema.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { suggestConfigKey } from "./suggestions.ts";
import type {
	AgentOverrideConfig,
	ConfigValidationResult,
	CrewAgentsConfig,
	CrewBrokerConfig,
	CrewControlConfig,
	CrewLimitsConfig,
	CrewNotificationsConfig,
	CrewObservabilityConfig,
	CrewOtlpConfig,
	CrewPolicyConfig,
	CrewReliabilityConfig,
	CrewRetryPolicyConfig,
	CrewRuntimeConfig,
	CrewTelemetryConfig,
	CrewToolsConfig,
	CrewUiConfig,
	CrewWorktreeConfig,
	GoalWrapWorkflowConfig,
	PiTeamsAutonomousConfig,
	PiTeamsAutonomyProfile,
	PiTeamsConfig,
} from "./types.ts";

function errorPathFromValidation(error: unknown): string {
	if (error && typeof error === "object") {
		if (typeof (error as { path?: unknown }).path === "string") return (error as { path: string }).path;
		if (typeof (error as { instancePath?: unknown }).instancePath === "string") return (error as { instancePath: string }).instancePath;
		if (
			typeof (error as { keyword?: unknown }).keyword === "string" &&
			typeof (error as { schemaPath?: unknown }).schemaPath === "string"
		)
			return (error as { schemaPath: string }).schemaPath;
	}
	return "config";
}

/** Known top-level config keys from the schema — used for fuzzy suggestions. */
const KNOWN_TOP_LEVEL_KEYS = Object.keys(PiTeamsConfigSchema.properties ?? {}) as string[];

function validateConfigWithWarnings(raw: unknown): string[] {
	if (!Value.Check(PiTeamsConfigSchema, raw)) {
		return [...Value.Errors(PiTeamsConfigSchema, raw)].map((error) => {
			const path = errorPathFromValidation(error);
			const message = (error as { message?: unknown }).message ?? "invalid value";
			// Enhance "additionalProperties" errors with fuzzy suggestions
			if ((error as { keyword?: unknown }).keyword === "additionalProperties") {
				const offendingKey = path.split("/").pop() ?? path;
				const suggestion = suggestConfigKey(offendingKey, KNOWN_TOP_LEVEL_KEYS);
				if (suggestion) return `${path}: ${message} (did you mean '${suggestion}'?)`;
			}
			return `${path}: ${message}`;
		});
	}
	return [];
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
	// RT-NEW-1: taskTimeoutMs is in MILLISECONDS — it must NOT reuse runtimeMaxTurns
	// (10_000 turns), which capped the effective timeout at 10s and silently disabled
	// any larger value (e.g. 300_000 = 5min) via parsePositiveInteger returning undefined.
	runtimeTaskTimeoutMs: 24 * 60 * 60 * 1000,
} as const;

/**
 * Keys that could allow prototype pollution if merged into plain objects.
 * NOTE: This set is comprehensive for ES2023 and earlier. When upgrading JavaScript
 * versions, verify whether new dangerous Object.prototype properties have been added
 * that could enable prototype pollution attacks.
 */
export const DANGEROUS_OBJECT_KEYS = new Set([
	"__proto__",
	"constructor",
	"prototype",
	"hasOwnProperty",
	"toString",
	"valueOf",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
]);

/**
 * Strips dangerous Object.prototype keys from an object.
 * Returns a new object built with Object.create(null) to prevent
 * prototype pollution attacks.
 */
function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
	const sanitized: Record<string, unknown> = Object.create(null);
	for (const [key, value] of Object.entries(obj)) {
		// Case-insensitive check to catch __Proto__, CONSTRUCTOR, etc.
		const lowerKey = key.toLowerCase();
		if (DANGEROUS_OBJECT_KEYS.has(lowerKey)) continue;
		if (value && typeof value === "object" && !Array.isArray(value)) {
			sanitized[key] = sanitizeObject(value as Record<string, unknown>);
		} else {
			sanitized[key] = value;
		}
	}
	return sanitized;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	// Defensive: create a sanitized copy to prevent prototype pollution.
	// Uses Object.create(null) so the result has no prototype chain.
	// WARNING: The returned object has no prototype methods (no hasOwnProperty,
	// toString, etc.). Use Object.hasOwn(obj, key) or
	// Object.prototype.hasOwnProperty.call(obj, key) for property checks.
	return sanitizeObject(value as Record<string, unknown>);
}

function parseWithSchema<T extends TSchema>(schema: T, value: unknown, context?: string): Static<T> | undefined {
	if (!Value.Check(schema, value)) {
		if (context) {
			logInternalError("config.parseWithSchema", undefined, `${context}: schema validation failed`);
		}
		return undefined;
	}
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
	if (typeof value === "string") return value.trim() === "" ? [] : parseStringList(value.split(","));
	return parseStringList(value);
}

export function effectiveAutonomousConfig(
	config: PiTeamsAutonomousConfig | undefined,
): Required<Pick<PiTeamsAutonomousConfig, "profile" | "enabled" | "injectPolicy" | "preferAsyncForLongTasks" | "allowWorktreeSuggestion">> &
	Pick<PiTeamsAutonomousConfig, "magicKeywords"> {
	const profile = config?.enabled === false ? "manual" : (config?.profile ?? "suggested");
	const profileDefaults: Record<
		PiTeamsAutonomyProfile,
		{
			enabled: boolean;
			injectPolicy: boolean;
			preferAsyncForLongTasks: boolean;
			allowWorktreeSuggestion: boolean;
		}
	> = {
		manual: {
			enabled: false,
			injectPolicy: false,
			preferAsyncForLongTasks: false,
			allowWorktreeSuggestion: false,
		},
		suggested: {
			enabled: true,
			injectPolicy: true,
			preferAsyncForLongTasks: false,
			allowWorktreeSuggestion: true,
		},
		assisted: {
			enabled: true,
			injectPolicy: true,
			preferAsyncForLongTasks: true,
			allowWorktreeSuggestion: true,
		},
		aggressive: {
			enabled: true,
			injectPolicy: true,
			preferAsyncForLongTasks: true,
			allowWorktreeSuggestion: true,
		},
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
		serializeOnPathOverlap: parseWithSchema(Type.Boolean(), obj.serializeOnPathOverlap),
	};
	return Object.values(limits).some((entry) => entry !== undefined) ? limits : undefined;
}

function parseIsolationPolicy(value: unknown): CrewRuntimeConfig["isolationPolicy"] | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const isolatedRoles = parseStringList(obj.isolatedRoles);
	const defaultRuntime = parseWithSchema(Type.Union([Type.Literal("live-session"), Type.Literal("child-process")]), obj.defaultRuntime);
	if (isolatedRoles === undefined && defaultRuntime === undefined) return undefined;
	return {
		...(isolatedRoles !== undefined ? { isolatedRoles } : {}),
		...(defaultRuntime !== undefined ? { defaultRuntime } : {}),
	};
}

function parseRuntimeConfig(value: unknown): CrewRuntimeConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return { inheritContext: true } as CrewRuntimeConfig;
	const runtime: CrewRuntimeConfig = {
		mode: parseWithSchema(
			Type.Union([Type.Literal("auto"), Type.Literal("scaffold"), Type.Literal("child-process"), Type.Literal("live-session")]),
			obj.mode,
		),
		preferLiveSession: parseWithSchema(Type.Boolean(), obj.preferLiveSession),
		allowChildProcessFallback: parseWithSchema(Type.Boolean(), obj.allowChildProcessFallback),
		maxTurns: parsePositiveInteger(obj.maxTurns, LIMIT_CEILINGS.runtimeMaxTurns),
		graceTurns: parsePositiveInteger(obj.graceTurns, LIMIT_CEILINGS.runtimeGraceTurns),
		taskTimeoutMs: parsePositiveInteger(obj.taskTimeoutMs, LIMIT_CEILINGS.runtimeTaskTimeoutMs),
		inheritContext: parseWithSchema(Type.Boolean(), obj.inheritContext) ?? true,
		promptMode: parseWithSchema(Type.Union([Type.Literal("replace"), Type.Literal("append")]), obj.promptMode),
		groupJoin: parseWithSchema(Type.Union([Type.Literal("off"), Type.Literal("group"), Type.Literal("smart")]), obj.groupJoin),
		groupJoinAckTimeoutMs: parsePositiveInteger(obj.groupJoinAckTimeoutMs, 86_400_000),
		requirePlanApproval: parseWithSchema(Type.Boolean(), obj.requirePlanApproval),
		completionMutationGuard: parseWithSchema(
			Type.Union([Type.Literal("off"), Type.Literal("warn"), Type.Literal("fail")]),
			obj.completionMutationGuard,
		),
		effectivenessGuard: parseWithSchema(
			Type.Union([Type.Literal("off"), Type.Literal("warn"), Type.Literal("block"), Type.Literal("fail")]),
			obj.effectivenessGuard,
		),
		yield: (() => {
			const y = asRecord(obj.yield);
			if (!y) return undefined;
			const parsed: NonNullable<CrewRuntimeConfig["yield"]> = {
				enabled: parseWithSchema(Type.Boolean(), y.enabled),
				maxReminders: parseWithSchema(Type.Integer({ minimum: 0 }), y.maxReminders),
				reminderPrompt: parseWithSchema(Type.String({ maxLength: 1000 }), y.reminderPrompt),
			};
			return Object.values(parsed).some((v) => v !== undefined) ? parsed : undefined;
		})(),
		excludeContextBash: parseWithSchema(Type.Boolean(), obj.excludeContextBash),
		agentExtensions: parseStringList(obj.agentExtensions),
		isolationPolicy: parseIsolationPolicy(obj.isolationPolicy),
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

/**
 * Phase 0 broker parser. Returns `undefined` only when input is not an object;
 * otherwise returns the broker config (with only defined fields populated)
 * so the caller can layer defaults on top.
 */
function parseBrokerConfig(value: unknown): CrewBrokerConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	// Use the exact schema bounds (4..32 / 1024..1048576 / 32..4096). The
	// previous version used parsePositiveInteger(value, default) which clamps
	// the UPPER bound to the default — effectively pathHashLen was capped
	// at 8, much narrower than the schema advertises.
	const broker: CrewBrokerConfig = {
		enabled: parseWithSchema(Type.Boolean(), obj.enabled),
		pathHashLen: parseIntegerInRange(obj.pathHashLen, 4, 32),
		maxFrameBytes: parseIntegerInRange(obj.maxFrameBytes, 1024, 1_048_576),
		outboundQueueCap: parseIntegerInRange(obj.outboundQueueCap, 32, 4096),
	};
	return Object.values(broker).some((entry) => entry !== undefined) ? broker : undefined;
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
		// C6: seedPaths was declared in the type + schema but never parsed here, so
		// loadedConfig.config.worktree?.seedPaths was always undefined -> the global
		// worktree seed overlay (worktree-manager.ts) silently never applied.
		seedPaths: parseStringList(obj.seedPaths),
	};
	return Object.values(worktree).some((entry) => entry !== undefined) ? worktree : undefined;
}

/** Parse goalWrap config (RFC v0.5 vision: apply goal completion-guarantee to builtins). */
function parseGoalWrapConfig(value: unknown): Record<string, GoalWrapWorkflowConfig> | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const result: Record<string, GoalWrapWorkflowConfig> = {};
	let hasAny = false;
	for (const [workflowName, entry] of Object.entries(obj)) {
		const entryObj = asRecord(entry);
		if (!entryObj) continue;
		const parsed: GoalWrapWorkflowConfig = {
			enabled: parseWithSchema(Type.Boolean(), entryObj.enabled),
			maxTurns: parseWithSchema(Type.Integer({ minimum: 1, maximum: 50 }), entryObj.maxTurns),
			evaluatorModel: parseWithSchema(Type.String({ minLength: 1 }), entryObj.evaluatorModel),
			budgetTotal: parseWithSchema(Type.Integer({ minimum: 1000 }), entryObj.budgetTotal),
			budgetUnlimited: parseWithSchema(Type.Boolean(), entryObj.budgetUnlimited),
		};
		// Parse verification sub-object.
		const verObj = asRecord(entryObj.verification);
		if (verObj) {
			const commands = Array.isArray(verObj.commands)
				? verObj.commands.filter((c): c is string => typeof c === "string" && c.length > 0)
				: undefined;
			const mode = verObj.mode === "text-only" ? ("text-only" as const) : undefined;
			if (commands || mode) {
				parsed.verification = {
					...(commands ? { commands } : { commands: [] }),
					...(mode ? { mode } : {}),
				};
			}
		}
		if (Object.values(parsed).some((v) => v !== undefined)) {
			result[workflowName] = parsed;
			hasAny = true;
		}
	}
	return hasAny ? result : undefined;
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
		skills: parseStringArrayOrFalse(obj.skills),
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
		autoCloseDashboardMs: parseWithSchema(Type.Integer({ minimum: 0 }), obj.autoCloseDashboardMs),
		showModel: parseWithSchema(Type.Boolean(), obj.showModel),
		showTokens: parseWithSchema(Type.Boolean(), obj.showTokens),
		showTools: parseWithSchema(Type.Boolean(), obj.showTools),
		transcriptTailBytes: parseIntegerInRange(obj.transcriptTailBytes, 1024, 50 * 1024 * 1024),
		mascotStyle: parseWithSchema(Type.Union([Type.Literal("cat"), Type.Literal("armin")]), obj.mascotStyle),
		mascotEffect: parseWithSchema(
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
			obj.mascotEffect,
		),
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

function parsePolicyConfig(value: unknown): CrewPolicyConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const policy: CrewPolicyConfig = {
		requireIntentForDestructiveActions: parseWithSchema(Type.Boolean(), obj.requireIntentForDestructiveActions),
		disabledCapabilities: parseWithSchema(Type.Array(Type.String()), obj.disabledCapabilities),
	};
	return Object.values(policy).some((entry) => entry !== undefined) ? policy : undefined;
}

function parseNotificationsConfig(value: unknown): CrewNotificationsConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const notifications: CrewNotificationsConfig = {
		enabled: parseWithSchema(Type.Boolean(), obj.enabled),
		severityFilter: parseWithSchema(
			Type.Array(Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error"), Type.Literal("critical")])),
			obj.severityFilter,
		),
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
	const retryPolicy: CrewRetryPolicyConfig | undefined = retryObj
		? {
				maxAttempts: parsePositiveInteger(retryObj.maxAttempts, 10),
				backoffMs: parseWithSchema(Type.Integer({ minimum: 100, maximum: 60_000 }), retryObj.backoffMs),
				jitterRatio: parseWithSchema(Type.Number({ minimum: 0, maximum: 1 }), retryObj.jitterRatio),
				exponentialFactor: parseWithSchema(Type.Number({ minimum: 1, maximum: 5 }), retryObj.exponentialFactor),
				retryableErrors: parseStringList(retryObj.retryableErrors),
				maxTotalSpawns: parsePositiveInteger(retryObj.maxTotalSpawns),
			}
		: undefined;
	const reliability: CrewReliabilityConfig = {
		autoRetry: parseWithSchema(Type.Boolean(), obj.autoRetry),
		retryPolicy: retryPolicy && Object.values(retryPolicy).some((entry) => entry !== undefined) ? retryPolicy : undefined,
		autoRecover: parseWithSchema(Type.Boolean(), obj.autoRecover),
		deadletterThreshold: parsePositiveInteger(obj.deadletterThreshold),
		cleanupOrphanedTempDirs: parseWithSchema(Type.Boolean(), obj.cleanupOrphanedTempDirs),
		autoRepairIntervalMs: parseWithSchema(Type.Integer({ minimum: 0 }), obj.autoRepairIntervalMs),
		forcePreflight: parseWithSchema(Type.Boolean(), obj.forcePreflight),
		ambientStatusInjection: parseWithSchema(Type.Boolean(), obj.ambientStatusInjection),
		perWriteValidation: parseWithSchema(Type.Boolean(), obj.perWriteValidation),
		scopeModels: parseWithSchema(Type.Boolean(), obj.scopeModels),
	};
	return Object.values(reliability).some((entry) => entry !== undefined) ? reliability : undefined;
}

function parseOtlpConfig(value: unknown): CrewOtlpConfig | undefined {
	const obj = asRecord(value);
	if (!obj) return undefined;
	const headers: Record<string, string> = Object.create(null);
	const rawHeaders = asRecord(obj.headers);
	if (rawHeaders)
		for (const [key, entry] of Object.entries(rawHeaders)) {
			if (typeof entry !== "string") continue;
			// Prevent prototype pollution via dangerous Object.prototype keys.
			// Case-insensitive check to catch __Proto__, CONSTRUCTOR, etc.
			const lowerKey = key.toLowerCase();
			if (
				lowerKey === "__proto__" ||
				lowerKey === "constructor" ||
				lowerKey === "prototype" ||
				lowerKey === "hasownproperty" ||
				lowerKey === "tostring" ||
				lowerKey === "valueof" ||
				lowerKey === "isprototypeof" ||
				lowerKey === "propertyisenumerable" ||
				lowerKey === "tolocalestring" ||
				lowerKey === "__definegetter__" ||
				lowerKey === "__definesetter__" ||
				lowerKey === "__lookupgetter__" ||
				lowerKey === "__lookupsetter__"
			)
				continue;
			// Validate key format: must start with letter, then alphanumeric/hyphen/underscore.
			// Blocks CRLF, NUL, spaces, shell metacharacters in header keys.
			if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(key)) continue;
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
		ignoreMethod: parseWithSchema(Type.Union([Type.Literal("gitignore"), Type.Literal("exclude")]), obj.ignoreMethod),
		autonomous: parseAutonomousConfig(obj.autonomous),
		limits: parseLimitsConfig(obj.limits),
		runtime: parseRuntimeConfig(obj.runtime),
		control: parseControlConfig(obj.control),
		worktree: parseWorktreeConfig(obj.worktree),
		goalWrap: parseGoalWrapConfig(obj.goalWrap),
		agents: parseAgentsConfig(obj.agents),
		tools: parseToolsConfig(obj.tools),
		telemetry: parseTelemetryConfig(obj.telemetry),
		policy: parsePolicyConfig(obj.policy),
		notifications: parseNotificationsConfig(obj.notifications),
		observability: parseObservabilityConfig(obj.observability),
		reliability: parseReliabilityConfig(obj.reliability),
		otlp: parseOtlpConfig(obj.otlp),
		ui: parseUiConfig(obj.ui),
		broker: parseBrokerConfig(obj.broker),
	};
}

export function parseConfigWithWarnings(raw: unknown): ConfigValidationResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config: {}, warnings: [] };
	const parsed = parseConfig(raw);
	const warnings = validateConfigWithWarnings(raw as Record<string, unknown>);
	return { config: parsed, warnings };
}

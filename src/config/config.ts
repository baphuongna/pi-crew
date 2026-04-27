import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
	maxTaskDepth?: number;
	maxChildrenPerTask?: number;
	maxRunMinutes?: number;
	maxRetriesPerTask?: number;
	maxTasksPerRun?: number;
	heartbeatStaleMs?: number;
}

export type CrewRuntimeMode = "auto" | "scaffold" | "child-process" | "live-session";

export interface CrewRuntimeConfig {
	mode?: CrewRuntimeMode;
	preferLiveSession?: boolean;
	allowChildProcessFallback?: boolean;
	maxTurns?: number;
	graceTurns?: number;
	inheritContext?: boolean;
	promptMode?: "replace" | "append";
	groupJoin?: "off" | "group" | "smart";
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
	showModel?: boolean;
	showTokens?: boolean;
	showTools?: boolean;
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
	ui?: CrewUiConfig;
}

export interface LoadedPiTeamsConfig {
	config: PiTeamsConfig;
	path: string;
	paths: string[];
	error?: string;
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
	return path.join(cwd, ".pi", "teams", "config.json");
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
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
				...(override.agents?.overrides ?? {}),
			},
		};
	}
	if (merged.agents?.overrides && Object.keys(merged.agents.overrides).length === 0) delete merged.agents.overrides;
	return merged;
}

function parseAutonomyProfile(value: unknown): PiTeamsAutonomyProfile | undefined {
	return value === "manual" || value === "suggested" || value === "assisted" || value === "aggressive" ? value : undefined;
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
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const result: Record<string, string[]> = {};
	for (const [key, rawValues] of Object.entries(value)) {
		if (!Array.isArray(rawValues)) continue;
		const values = rawValues.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
		if (values.length > 0) result[key] = values;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function parseAutonomousConfig(value: unknown): PiTeamsAutonomousConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	return {
		profile: parseAutonomyProfile(obj.profile),
		enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
		injectPolicy: typeof obj.injectPolicy === "boolean" ? obj.injectPolicy : undefined,
		preferAsyncForLongTasks: typeof obj.preferAsyncForLongTasks === "boolean" ? obj.preferAsyncForLongTasks : undefined,
		allowWorktreeSuggestion: typeof obj.allowWorktreeSuggestion === "boolean" ? obj.allowWorktreeSuggestion : undefined,
		magicKeywords: parseStringArrayRecord(obj.magicKeywords),
	};
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

function parsePositiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max ? value : undefined;
}

function parseLimitsConfig(value: unknown): CrewLimitsConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	const limits: CrewLimitsConfig = {
		maxConcurrentWorkers: parsePositiveInteger(obj.maxConcurrentWorkers, LIMIT_CEILINGS.maxConcurrentWorkers),
		maxTaskDepth: parsePositiveInteger(obj.maxTaskDepth, LIMIT_CEILINGS.maxTaskDepth),
		maxChildrenPerTask: parsePositiveInteger(obj.maxChildrenPerTask, LIMIT_CEILINGS.maxChildrenPerTask),
		maxRunMinutes: parsePositiveInteger(obj.maxRunMinutes, LIMIT_CEILINGS.maxRunMinutes),
		maxRetriesPerTask: parsePositiveInteger(obj.maxRetriesPerTask, LIMIT_CEILINGS.maxRetriesPerTask),
		maxTasksPerRun: parsePositiveInteger(obj.maxTasksPerRun, LIMIT_CEILINGS.maxTasksPerRun),
		heartbeatStaleMs: parsePositiveInteger(obj.heartbeatStaleMs, LIMIT_CEILINGS.heartbeatStaleMs),
	};
	return Object.values(limits).some((entry) => entry !== undefined) ? limits : undefined;
}

function parseRuntimeMode(value: unknown): CrewRuntimeMode | undefined {
	return value === "auto" || value === "scaffold" || value === "child-process" || value === "live-session" ? value : undefined;
}

function parseRuntimeConfig(value: unknown): CrewRuntimeConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	const runtime: CrewRuntimeConfig = {
		mode: parseRuntimeMode(obj.mode),
		preferLiveSession: typeof obj.preferLiveSession === "boolean" ? obj.preferLiveSession : undefined,
		allowChildProcessFallback: typeof obj.allowChildProcessFallback === "boolean" ? obj.allowChildProcessFallback : undefined,
		maxTurns: parsePositiveInteger(obj.maxTurns, LIMIT_CEILINGS.runtimeMaxTurns),
		graceTurns: parsePositiveInteger(obj.graceTurns, LIMIT_CEILINGS.runtimeGraceTurns),
		inheritContext: typeof obj.inheritContext === "boolean" ? obj.inheritContext : undefined,
		promptMode: obj.promptMode === "replace" || obj.promptMode === "append" ? obj.promptMode : undefined,
		groupJoin: obj.groupJoin === "off" || obj.groupJoin === "group" || obj.groupJoin === "smart" ? obj.groupJoin : undefined,
	};
	return Object.values(runtime).some((entry) => entry !== undefined) ? runtime : undefined;
}

function parseControlConfig(value: unknown): CrewControlConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	const control: CrewControlConfig = {
		enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
		needsAttentionAfterMs: parsePositiveInteger(obj.needsAttentionAfterMs),
	};
	return Object.values(control).some((entry) => entry !== undefined) ? control : undefined;
}

function parseWorktreeConfig(value: unknown): CrewWorktreeConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	const worktree: CrewWorktreeConfig = {
		setupHook: typeof obj.setupHook === "string" && obj.setupHook.trim() ? obj.setupHook.trim() : undefined,
		setupHookTimeoutMs: parsePositiveInteger(obj.setupHookTimeoutMs, 300_000),
		linkNodeModules: typeof obj.linkNodeModules === "boolean" ? obj.linkNodeModules : undefined,
	};
	return Object.values(worktree).some((entry) => entry !== undefined) ? worktree : undefined;
}

function parseStringArrayOrFalse(value: unknown): string[] | false | undefined {
	if (value === false) return false;
	if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
	if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
	return undefined;
}

function parseAgentOverride(value: unknown): AgentOverrideConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	const override: AgentOverrideConfig = {
		disabled: typeof obj.disabled === "boolean" ? obj.disabled : undefined,
		model: typeof obj.model === "string" || obj.model === false ? obj.model : undefined,
		fallbackModels: parseStringArrayOrFalse(obj.fallbackModels),
		thinking: typeof obj.thinking === "string" || obj.thinking === false ? obj.thinking : undefined,
		tools: parseStringArrayOrFalse(obj.tools),
	};
	return Object.values(override).some((entry) => entry !== undefined) ? override : undefined;
}

function parseUiConfig(value: unknown): CrewUiConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	const ui: CrewUiConfig = {
		widgetPlacement: obj.widgetPlacement === "aboveEditor" || obj.widgetPlacement === "belowEditor" ? obj.widgetPlacement : undefined,
		widgetMaxLines: parsePositiveInteger(obj.widgetMaxLines, 50),
		powerbar: typeof obj.powerbar === "boolean" ? obj.powerbar : undefined,
		dashboardPlacement: obj.dashboardPlacement === "center" || obj.dashboardPlacement === "right" ? obj.dashboardPlacement : undefined,
		dashboardWidth: parsePositiveInteger(obj.dashboardWidth, 120),
		showModel: typeof obj.showModel === "boolean" ? obj.showModel : undefined,
		showTokens: typeof obj.showTokens === "boolean" ? obj.showTokens : undefined,
		showTools: typeof obj.showTools === "boolean" ? obj.showTools : undefined,
	};
	return Object.values(ui).some((entry) => entry !== undefined) ? ui : undefined;
}

function parseAgentsConfig(value: unknown): CrewAgentsConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	const overrides: Record<string, AgentOverrideConfig> = {};
	if (obj.overrides && typeof obj.overrides === "object" && !Array.isArray(obj.overrides)) {
		for (const [name, rawOverride] of Object.entries(obj.overrides)) {
			const parsed = parseAgentOverride(rawOverride);
			if (parsed) overrides[name] = parsed;
		}
	}
	const agents: CrewAgentsConfig = {
		disableBuiltins: typeof obj.disableBuiltins === "boolean" ? obj.disableBuiltins : undefined,
		overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
	};
	return Object.values(agents).some((entry) => entry !== undefined) ? agents : undefined;
}

function parseConfig(raw: unknown): PiTeamsConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const obj = raw as Record<string, unknown>;
	return {
		asyncByDefault: typeof obj.asyncByDefault === "boolean" ? obj.asyncByDefault : undefined,
		executeWorkers: typeof obj.executeWorkers === "boolean" ? obj.executeWorkers : undefined,
		notifierIntervalMs: typeof obj.notifierIntervalMs === "number" && Number.isFinite(obj.notifierIntervalMs) && obj.notifierIntervalMs >= 1000 ? obj.notifierIntervalMs : undefined,
		requireCleanWorktreeLeader: typeof obj.requireCleanWorktreeLeader === "boolean" ? obj.requireCleanWorktreeLeader : undefined,
		autonomous: parseAutonomousConfig(obj.autonomous),
		limits: parseLimitsConfig(obj.limits),
		runtime: parseRuntimeConfig(obj.runtime),
		control: parseControlConfig(obj.control),
		worktree: parseWorktreeConfig(obj.worktree),
		agents: parseAgentsConfig(obj.agents),
		ui: parseUiConfig(obj.ui),
	};
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
		let config = parseConfig(readConfigRecord(filePath));
		if (cwd) config = mergeConfig(config, parseConfig(readConfigRecord(projectConfigPath(cwd))));
		return { path: filePath, paths, config };
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

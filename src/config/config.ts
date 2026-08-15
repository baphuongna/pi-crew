import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../state/atomic-write.ts";
import { withFileLockSync } from "../state/coordination/locks.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { projectCrewRoot, projectPiRoot } from "../utils/paths.ts";
import { mergeConfig } from "./config-merge.ts";
import { parseConfig, parseConfigWithWarnings } from "./config-validation.ts";
import { DEFAULT_BROKER, resolveBrokerEnvOverride } from "./defaults.ts";
import { getCrewEnv } from "./env-vars.ts";
import { sanitizeProjectConfig } from "./sanitize-project-config.ts";

// 2.9: interface types extracted to ./types.ts; re-export for back-compat.
export type {
	AgentOverrideConfig,
	CompletionMutationGuardMode,
	ConfigValidationResult,
	CrewAgentsConfig,
	CrewControlConfig,
	CrewLimitsConfig,
	CrewNotificationSeverity,
	CrewNotificationsConfig,
	CrewObservabilityConfig,
	CrewOtlpConfig,
	CrewPolicyConfig,
	CrewReliabilityConfig,
	CrewRetryPolicyConfig,
	CrewRuntimeConfig,
	CrewRuntimeMode,
	CrewTelemetryConfig,
	CrewToolsConfig,
	CrewUiConfig,
	CrewWorktreeConfig,
	EffectivenessGuardMode,
	LoadedPiTeamsConfig,
	PiTeamsAutonomousConfig,
	PiTeamsAutonomyProfile,
	PiTeamsConfig,
	SavedPiTeamsConfig,
	UpdateConfigOptions,
} from "./types.ts";

import type {
	CrewBrokerConfig,
	LoadedPiTeamsConfig,
	PiTeamsAutonomousConfig,
	PiTeamsConfig,
	SavedPiTeamsConfig,
	UpdateConfigOptions,
} from "./types.ts";

export { __test__mergeConfig } from "./config-merge.ts";
// Phase 2.2 split: config.ts is the loader + public re-export shim.
// Public surface moved to sub-modules is re-exported here unchanged.
export { asRecord, effectiveAutonomousConfig } from "./config-validation.ts";
export { __test__sanitizeProjectConfig } from "./sanitize-project-config.ts";
export { parseConfig, parseConfigWithWarnings };

// (F16) loadConfig was called 1 Hz idle / 6 Hz active with 0 cache — added 2s TTL+mtime cache following the manifestCache pattern in state-store.ts:75-130.
const CONFIG_CACHE_TTL_MS = 2000;

interface ConfigCacheEntry {
	value: LoadedPiTeamsConfig;
	mtimes: Record<string, number>;
	cachedAt: number;
}

interface ConfigCacheKeyParts {
	filePath: string;
	legacyPath: string;
	projectPath: string;
	projectPiCrewJsonPath: string;
	cwd: string | null;
}

const configCache = new Map<string, ConfigCacheEntry>();

/** @internal — TTL override for unit tests (matches __test__setManifestCache pattern in state-store.ts:82). */
export function __test__setConfigCacheTtlMs(ttlMs: number): void {
	configCacheTtlMsOverride = ttlMs;
}

/** @internal — read the effective TTL in use by the cache. */
export function __test__getConfigCacheTtlMs(): number {
	return configCacheTtlMsOverride ?? CONFIG_CACHE_TTL_MS;
}

/** @internal — peek at the cached entry for a given key shape. */
export function __test__getConfigCacheEntry(parts: ConfigCacheKeyParts): ConfigCacheEntry | undefined {
	return configCache.get(buildConfigCacheKey(parts));
}

/** @internal — number of cached entries (for tests/diagnostics). */
export function __test__configCacheSize(): number {
	return configCache.size;
}

let configCacheTtlMsOverride: number | null = null;

function buildConfigCacheKey(parts: ConfigCacheKeyParts): string {
	return JSON.stringify([parts.filePath, parts.legacyPath, parts.projectPath, parts.projectPiCrewJsonPath, parts.cwd]);
}

function statMtimeMs(filePath: string): number | undefined {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function readCachedConfigParts(filePath: string, legacyPath: string, cwd: string | undefined): ConfigCacheKeyParts {
	const projectPath = cwd ? projectConfigPath(cwd) : "";
	const piCrewJsonPath = cwd ? projectPiCrewJsonPath(cwd) : "";
	return {
		filePath,
		legacyPath,
		projectPath,
		projectPiCrewJsonPath: piCrewJsonPath,
		cwd: cwd ?? null,
	};
}

function readCacheMtimes(parts: ConfigCacheKeyParts): Record<string, number> {
	const mtimes: Record<string, number> = {};
	for (const p of [parts.filePath, parts.legacyPath, parts.projectPath, parts.projectPiCrewJsonPath]) {
		if (!p) continue; // skip empty (cwd-undefined project paths)
		const m = statMtimeMs(p);
		if (m !== undefined) mtimes[p] = m;
	}
	return mtimes;
}

function matchesCachedMtimes(cached: Record<string, number>, current: Record<string, number>): boolean {
	const cachedKeys = Object.keys(cached);
	const currentKeys = Object.keys(current);
	if (cachedKeys.length !== currentKeys.length) return false;
	for (const key of cachedKeys) {
		if (current[key] !== cached[key]) return false;
	}
	return true;
}

function setConfigCache(key: string, value: LoadedPiTeamsConfig, mtimes: Record<string, number>): void {
	if (configCache.has(key)) configCache.delete(key);
	configCache.set(key, { value, mtimes, cachedAt: Date.now() });
	const ttlMs = configCacheTtlMsOverride ?? CONFIG_CACHE_TTL_MS;
	// TTL eviction on insert (mirrors manifestCache eviction in state-store.ts:108-117)
	const now = Date.now();
	for (const [k, entry] of configCache.entries()) {
		if (now - entry.cachedAt > ttlMs) configCache.delete(k);
	}
}

/** Drop all cached loadConfig results. Call after config writes or from tests. */
export function invalidateConfigCache(): void {
	configCache.clear();
}

function resolveHomeDir(): string {
	const envValue = getCrewEnv("PI_CREW_HOME")?.trim();
	const defaultHome = os.homedir();
	if (!envValue) return defaultHome;
	// FIX (Round 14): When PI_TEAMS_HOME is explicitly set, validate that
	// it points within the real user home directory. This prevents a
	// malicious .env file from redirecting config loading to an
	// attacker-controlled path. We compare against fs.realpath to defeat
	// symlink-based escapes. Tests that intentionally override the home
	// directory (e.g. withIsolatedHome) set PI_TEAMS_HOME to a tmp dir
	// under /tmp; we skip the check in test environments (NODE_ENV=test)
	// so existing tests don't break.
	if (getCrewEnv("PI_CREW_SKIP_HOME_CHECK") === "1") {
		return envValue;
	}
	// M-7 fix (code-review 2026-06-23): the previous `NODE_ENV === "test"` bypass
	// was reachable from any production-ish environment that happened to set
	// NODE_ENV=test (CI smoke tests, staging), allowing a malicious .env to
	// redirect PI_TEAMS_HOME anywhere. The explicit opt-out flag above is the only
	// bypass now; the test runner sets it (scripts/test-runner.mjs).
	try {
		const userHome = fs.realpathSync(defaultHome);
		const resolvedHome = fs.realpathSync(envValue);
		if (!resolvedHome.startsWith(userHome + path.sep) && resolvedHome !== userHome) {
			logInternalError(
				"config.pi-teams-home-escape",
				new Error(`PI_TEAMS_HOME=${envValue} resolves outside user home; falling back to os.homedir()`),
				`resolvedHome=${resolvedHome}; userHome=${userHome}`,
			);
			return defaultHome;
		}
		return resolvedHome;
	} catch (error) {
		logInternalError("config.pi-teams-home-resolve", error, `home=${envValue}`);
		return defaultHome;
	}
}

export function configPath(): string {
	return path.join(resolveHomeDir(), ".pi", "agent", "pi-crew.json");
}

export function legacyConfigPath(): string {
	return path.join(resolveHomeDir(), ".pi", "agent", "extensions", "pi-crew", "config.json");
}

export function projectConfigPath(cwd: string): string {
	return path.join(projectCrewRoot(cwd), "config.json");
}

/**
 * Alternative project config path: `.pi/pi-crew.json` in the project root.
 * This is a convenience path alongside the standard `config.json` in crewRoot.
 */
export function projectPiCrewJsonPath(cwd: string): string {
	return path.join(projectPiRoot(cwd), "pi-crew.json");
}

/**
 * Apply PI_CREW_BROKER env override to the parsed broker config, then
 * layer in DEFAULT_BROKER for any field the user did not set. Keeps the
 * kill switch (enabled:false) reachable in three independent ways: env,
 * config block, or default.
 */
function applyBrokerEnvOverrideAndDefaults(parsed: CrewBrokerConfig | undefined): CrewBrokerConfig {
	const envOverridden = resolveBrokerEnvOverride(parsed);
	return { ...DEFAULT_BROKER, ...envOverridden };
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
	// Defense-in-depth: reject config files larger than 10 MB before parsing.
	// This prevents memory exhaustion and blocks deeply nested JSON that could
	// cause stack overflow during parsing.
	const MAX_CONFIG_SIZE = 10 * 1024 * 1024;
	const stat = fs.statSync(filePath);
	if (stat.size > MAX_CONFIG_SIZE) {
		logInternalError(
			"config.file-too-large",
			new Error(`config file exceeds ${MAX_CONFIG_SIZE} bytes`),
			`path=${filePath}; size=${stat.size}`,
		);
		return {};
	}
	// Parse with depth limit to prevent stack overflow from deeply nested JSON.
	// Nesting beyond 100 levels is almost certainly an attack or malformed file.
	const MAX_JSON_DEPTH = 100;
	let depth = 0;
	const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"), (_key, value) => {
		if (++depth > MAX_JSON_DEPTH) {
			throw new Error(`config JSON exceeds max depth ${MAX_JSON_DEPTH}`);
		}
		return value;
	}) as unknown;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	return raw as Record<string, unknown>;
}

function readOptionalConfig(filePath: string): {
	exists: boolean;
	config: PiTeamsConfig;
	warnings: string[];
} {
	if (!fs.existsSync(filePath)) return { exists: false, config: {}, warnings: [] };
	try {
		const raw = readConfigRecord(filePath);
		const parsed = parseConfigWithWarnings(raw);
		return {
			exists: true,
			config: parsed.config,
			warnings: parsed.warnings.map((warning) => `${filePath}: ${warning}`),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			exists: true,
			config: {},
			warnings: [`${filePath}: invalid config ignored: ${message}`],
		};
	}
}

export function loadConfig(cwd?: string): LoadedPiTeamsConfig {
	const filePath = configPath();
	const legacyPath = legacyConfigPath();

	// (F16) Quick-win cache: skip the expensive full-reparse on hot paths
	// (preload tick 1 Hz, per-write validation, subagent completion) when the
	// on-disk config files are unchanged. See CONFIG_CACHE_TTL_MS at the
	// top of this file for the rationale and the manifestCache pattern in
	// state-store.ts:75-130 for the canonical implementation we mirror.
	const cacheParts = readCachedConfigParts(filePath, legacyPath, cwd);
	const cacheKey = buildConfigCacheKey(cacheParts);
	const cached = configCache.get(cacheKey);
	const ttlMs = configCacheTtlMsOverride ?? CONFIG_CACHE_TTL_MS;
	if (cached && Date.now() - cached.cachedAt <= ttlMs) {
		const currentMtimes = readCacheMtimes(cacheParts);
		if (matchesCachedMtimes(cached.mtimes, currentMtimes)) {
			// Refresh insertion order so a frequently-accessed key isn't
			// evicted from the Map on the next eviction sweep.
			configCache.delete(cacheKey);
			configCache.set(cacheKey, cached);
			return cached.value;
		}
	}

	const paths = cwd ? [filePath, projectConfigPath(cwd)] : [filePath];
	const warnings: string[] = [];
	const legacyConfig = readOptionalConfig(legacyPath);
	if (legacyConfig.exists && legacyPath !== filePath) {
		warnings.push(...legacyConfig.warnings);
		paths.unshift(legacyPath);
	}
	const userConfig = readOptionalConfig(filePath);
	warnings.push(...userConfig.warnings);
	let config = mergeConfig(legacyConfig.exists && legacyPath !== filePath ? legacyConfig.config : {}, userConfig.config);
	if (cwd) {
		const projectPath = projectConfigPath(cwd);
		const projectConfig = readOptionalConfig(projectPath);
		// SECURITY FIX: Merge project config FIRST, then user config on top.
		// Precedence formula: merge(projectConfig, userConfig) = userConfig wins.
		// Sensitive fields have already been sanitized by sanitizeProjectConfig.
		let effectiveConfig = {};
		if (projectConfig.exists) {
			const projectSafeConfig = sanitizeProjectConfig(projectPath, config, projectConfig.config);
			warnings.push(...projectConfig.warnings, ...projectSafeConfig.warnings);
			// merge(base=projectConfig, override=userConfig) → override wins
			effectiveConfig = mergeConfig(effectiveConfig, projectSafeConfig.config);
		}
		// User config always takes precedence over project config
		effectiveConfig = mergeConfig(effectiveConfig, config);
		config = effectiveConfig;

		// `.pi/pi-crew.json` is the project-owned config file.
		// Merge project config FIRST (base), then user config on top (override).
		// This ensures user preferences always take precedence over project settings.
		// Sensitive fields have already been sanitized by sanitizeProjectConfig.
		const piCrewJsonPath = projectPiCrewJsonPath(cwd);
		const piCrewJsonConfig = readOptionalConfig(piCrewJsonPath);
		if (piCrewJsonConfig.exists) {
			warnings.push(...piCrewJsonConfig.warnings);
			const projectPart = sanitizeProjectConfig(piCrewJsonPath, config, piCrewJsonConfig.config);
			warnings.push(...projectPart.warnings);
			// base=project config, override=user config → user wins
			const mergedProject = mergeConfig(projectPart.config, config);
			config = mergedProject;
			paths.push(piCrewJsonPath);
		}
	}
	const result: LoadedPiTeamsConfig = {
		path: filePath,
		paths,
		config: {
			...config,
			// Phase 0 broker: layer in env override + defaults. Env wins over
			// config; defaults fill any missing field. Env `"1"`/`"0"` forces
			// the enabled flag even when no broker block is configured.
			broker: applyBrokerEnvOverrideAndDefaults(config.broker),
		},
		warnings: warnings.length > 0 ? warnings : undefined,
	};
	// Only cache when at least one of the watched paths exists — this avoids
	// pinning stale empty results when a user later creates one of these files
	// in the cache window. mtime stat below picks up the new file (it appears
	// in currentMtimes but not in cached.mtimes) and triggers a re-parse.
	if (Object.keys(readCacheMtimes(cacheParts)).length > 0) {
		setConfigCache(cacheKey, result, readCacheMtimes(cacheParts));
	}
	return result;
}

export function updateConfig(patch: PiTeamsConfig, options: UpdateConfigOptions = {}): SavedPiTeamsConfig {
	const filePath = options.scope === "project" && options.cwd ? projectConfigPath(options.cwd) : configPath();
	const lockPath = filePath + ".lock";
	return withFileLockSync(lockPath, () => {
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
		// Skip-if-unchanged: an empty/identical patch must not rewrite the file
		// (e.g. `team action='config'` with an empty patch — read-only path).
		// Both sides are parseConfig-normalized, so JSON.stringify key order is
		// deterministic (same construction path); no key sorting needed.
		const normalizedCurrent = parseConfig(current);
		if (JSON.stringify(merged) === JSON.stringify(normalizedCurrent)) {
			return { path: filePath, config: merged, written: false }; // unchanged — skip write
		}
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		atomicWriteFile(filePath, `${JSON.stringify(merged, null, 2)}\n`);
		// (F16) Invalidate the loadConfig cache after a write — the next
		// caller must see the new value, not a 0-2s stale snapshot.
		invalidateConfigCache();
		return { path: filePath, config: merged, written: true };
	});
}

export function updateAutonomousConfig(patch: PiTeamsAutonomousConfig): SavedPiTeamsConfig {
	const filePath = configPath();
	const lockPath = filePath + ".lock";
	return withFileLockSync(lockPath, () => {
		let current: Record<string, unknown>;
		try {
			current = readConfigRecord(filePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not update pi-crew config: ${message}`);
		}
		const currentAutonomous =
			current.autonomous && typeof current.autonomous === "object" && !Array.isArray(current.autonomous)
				? (current.autonomous as Record<string, unknown>)
				: {};
		// Skip-if-unchanged (raw shape): a no-op autonomous patch must not
		// rewrite the file. NOTE: compare the RAW on-disk record, NOT the
		// parseConfig-normalized shape — normalizing would add default keys and
		// false-positive the equality check.
		const next = { ...current, autonomous: { ...currentAutonomous, ...patch } };
		if (JSON.stringify(next) === JSON.stringify(current)) {
			return { path: filePath, config: parseConfig(current), written: false }; // unchanged — skip write
		}
		current.autonomous = next.autonomous;
		atomicWriteFile(filePath, `${JSON.stringify(current, null, 2)}\n`);
		// (F16) Invalidate the loadConfig cache after a write — see updateConfig.
		invalidateConfigCache();
		return { path: filePath, config: parseConfig(current), written: true };
	});
}

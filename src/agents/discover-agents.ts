import * as fs from "node:fs";
import * as path from "node:path";
import { type LoadedPiTeamsConfig, loadConfig } from "../config/config.ts";
import { parseCsv, parseFrontmatter } from "../utils/frontmatter.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { findRepoRoot, packageRoot, projectCrewRoot, userPiRoot } from "../utils/paths.ts";
import type { AgentConfig, ResourceSource } from "./agent-config.ts";
import { parseToolsField } from "./agent-config.ts";

// ═══════════════════════════════════════════════════════════════════════════
// SEC-001 Fix: Protected Agent Names Blocklist
// Prevents privilege escalation via agent shadowing attacks.
// See: SECURITY-ISSUES.md SEC-001
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// SEC-005 Fix: Version-based Cache for Atomic Invalidation
// Uses a global version counter for atomic cache invalidation instead of
// relying on TTL alone. This eliminates race conditions where concurrent
// callers might get stale cached snapshots.
// See: SECURITY-ISSUES.md SEC-005
// ═══════════════════════════════════════════════════════════════════════════

/** Version counter for atomic cache invalidation. Incremented on every mutation. */
let cacheVersion = 0;

/** Get current cache version. Used for atomic cache stamping. */
export function getCacheVersion(): number {
	return cacheVersion;
}

/**
 * Increment cache version for atomic invalidation.
 * All cached entries with versions older than this are considered stale.
 */
function incrementCacheVersion(): void {
	cacheVersion++;
}

/** Exact match blocklist for protected builtin agent names. */
const PROTECTED_AGENT_NAMES = new Set([
	"executor",
	"test-engineer",
	"explorer",
	"planner",
	"analyst",
	"critic",
	"reviewer",
	"verifier",
	"cold-verifier", // T9 (v0.8.4): adversarial cold cross-check agent
	"writer",
	"security-reviewer",
]);

/**
 * Pattern blocklist for agent names that would likely confuse or deceive
 * workflows looking for builtin agents.
 *
 * Covers:
 * - Name variations: "executor-v2", "my-executor", "custom-executor"
 * - Misspellings that could be typo-squatted: "execultor", "explroer"
 * - Prefix/suffix combinations with protected names
 */
const PROTECTED_AGENT_PATTERNS: Array<{ pattern: RegExp; example: string }> = [
	// Exact variations with delimiters
	{ pattern: /^executor[-_]?v?[0-9]/i, example: "executor-v2, executor_1" },
	{ pattern: /^test[-_]?engineer/i, example: "test-engineer-proxy" },
	{ pattern: /^explorer[-_]/i, example: "explorer-debug" },
	{ pattern: /^planner[-_]/i, example: "planner-v3" },
	// Generic prefixes that could impersonate builtins
	{
		pattern: /^(my|custom|new|local)[-_](executor|test[-_]?engineer|explorer|planner)$/i,
		example: "my-executor",
	},
	{
		pattern: /^(executor|test[-_]?engineer|explorer|planner)[-_]?(proxy|hook|override)$/i,
		example: "executor-override",
	},
	// Common typosquatting patterns (intentional misspellings)
	{ pattern: /^exec[au]t[o0]r$/i, example: "execator" },
	{ pattern: /^expl[o0]rer$/i, example: "explorer" },
	{ pattern: /^plann[ae]r$/i, example: "plannar" },
	// Suffixes that indicate override意图
	{
		pattern: /^(executor|test[-_]?engineer|explorer|planner)[-_]?(override|replacement|shadow)$/i,
		example: "executor-override",
	},
];

/**
 * Check if an agent name matches any protected pattern.
 * Returns the matched pattern description for error messages.
 */
function matchProtectedPattern(name: string): string | null {
	const key = name.toLowerCase();
	for (const { pattern, example } of PROTECTED_AGENT_PATTERNS) {
		if (pattern.test(key)) {
			return `pattern "${pattern}" (example: ${example})`;
		}
	}
	return null;
}

/**
 * Security event types for audit logging.
 */
interface SecurityEvent {
	type: "AGENT_REGISTRATION_BLOCKED" | "PROJECT_AGENT_SHADOW_WARNING";
	name: string;
	reason: string;
	timestamp: number;
}

/**
 * Security event log. In production, this should be sent to a security SIEM.
 * Bounded at MAX_SECURITY_LOG_ENTRIES to prevent unbounded memory growth.
 */
const MAX_SECURITY_LOG_ENTRIES = 1000;
const securityEventLog: SecurityEvent[] = [];

/**
 * Log a security event for audit purposes.
 * TODO(security-siem): tracked — integrate with project's logging infrastructure
 *       (e.g., send to SIEM, log aggregator, or security webhook).
 */
function logSecurityEvent(event: SecurityEvent): void {
	securityEventLog.push(event);
	// Evict oldest entries when cap exceeded
	while (securityEventLog.length > MAX_SECURITY_LOG_ENTRIES) {
		securityEventLog.shift();
	}

	// Log security events via structured logger
	logInternalError(`security.${event.type}`, undefined, `agent="${event.name}" reason="${event.reason}"`);
}

/**
 * Get recent security events (for debugging/testing).
 */
export function getSecurityEventLog(): readonly SecurityEvent[] {
	return securityEventLog;
}

/**
 * Clear security event log (for testing).
 */
export function clearSecurityEventLog(): void {
	securityEventLog.length = 0;
}

/**
 * Security check: throws if the agent name is protected.
 *
 * Checks in order:
 * 1. Exact match against PROTECTED_AGENT_NAMES
 * 2. Pattern match against PROTECTED_AGENT_PATTERNS
 *
 * Throws with detailed error message on violation.
 * Logs the event to securityEventLog for audit.
 */
function assertAgentNameAllowed(name: string): void {
	const key = name.toLowerCase();

	// Check 1: Exact match
	if (PROTECTED_AGENT_NAMES.has(key)) {
		logSecurityEvent({
			type: "AGENT_REGISTRATION_BLOCKED",
			name,
			reason: `exact_match:${key}`,
			timestamp: Date.now(),
		});
		throw new Error(
			`SECURITY: Cannot register agent '${name}': protected builtin name. ` +
				`Dynamic agents cannot shadow builtin agents (executor, explorer, planner, etc.) to prevent privilege escalation.`,
		);
	}

	// Check 2: Pattern match (custom-executor, my-planner, etc.)
	const matchedPattern = matchProtectedPattern(key);
	if (matchedPattern !== null) {
		logSecurityEvent({
			type: "AGENT_REGISTRATION_BLOCKED",
			name,
			reason: `pattern_match:${matchedPattern}`,
			timestamp: Date.now(),
		});
		throw new Error(
			`SECURITY: Cannot register agent '${name}': name matches protected pattern (${matchedPattern}). ` +
				`This pattern is blocked to prevent privilege escalation via similar-named agents.`,
		);
	}
}

/**
 * Check if a project agent name would shadow a builtin agent.
 * Logs a warning if so, but does NOT block (project agents can be legitimate overrides).
 *
 * Called during agent discovery to flag potential security concerns.
 */
function checkProjectAgentShadowsBuiltin(name: string): void {
	const key = name.toLowerCase();

	// Check exact match
	if (PROTECTED_AGENT_NAMES.has(key)) {
		logSecurityEvent({
			type: "PROJECT_AGENT_SHADOW_WARNING",
			name,
			reason: "project_shadows_protected_builtin",
			timestamp: Date.now(),
		});
		logInternalError(
			`security.agent_shadow_warning`,
			undefined,
			`Project agent "${name}" shadows a protected builtin. Builtin agents take priority.`,
		);
		return;
	}

	// Check pattern match
	const matchedPattern = matchProtectedPattern(key);
	if (matchedPattern !== null) {
		logSecurityEvent({
			type: "PROJECT_AGENT_SHADOW_WARNING",
			name,
			reason: `project_shadows_pattern:${matchedPattern}`,
			timestamp: Date.now(),
		});
	}
}

export interface AgentDiscoveryResult {
	builtin: AgentConfig[];
	user: AgentConfig[];
	/**
	 * Project agents from the pi-crew legacy directory (`.crew/agents/`, or
	 * `.pi/teams/agents/` fallback). F1 (v0.7.9): the `.pi/agents/` Pi-standard
	 * project directory is read into `projectPi` (the 4th tier) so users who
	 * author agents under either convention find them.
	 */
	project: AgentConfig[];
	/**
	 * F1 (v0.7.9): project agents read from `<repoRoot>/.pi/agents/` (Pi
	 * standard). Merged into the same priority order as `project` (project
	 * overrides user, but `.crew/agents/` and `.pi/agents/` are peers
	 * within the project tier — first hit per `name` wins, with a
	 * warning logged on shadow). Optional in the result shape so existing
	 * test fixtures that construct `AgentDiscoveryResult` literally don't
	 * have to add an empty array (treated as `[]` by `allAgents`).
	 */
	projectPi?: AgentConfig[];
}

function parseCost(value: string | undefined): "free" | "cheap" | "expensive" | undefined {
	return value === "free" || value === "cheap" || value === "expensive" ? value : undefined;
}

function parseMemory(value: string | undefined): "user" | "project" | "local" | undefined {
	return value === "user" || value === "project" || value === "local" ? value : undefined;
}

function parseLoadMode(value: string | undefined): "essential" | "lean" | undefined {
	return value === "essential" || value === "lean" ? value : undefined;
}

function parseContextMode(value: string | undefined): "fresh" | "fork" | undefined {
	return value === "fresh" || value === "fork" ? value : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// SEC-002 Fix: Agent System Prompt Sanitization
// Prevents prompt injection via malicious agent files.
// See: SECURITY-ISSUES.md SEC-002
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Trust levels for agent source classification.
 * Determines how strictly to sanitize the system prompt.
 */
type TrustLevel = "builtin" | "user" | "project";

/**
 * Convert ResourceSource to TrustLevel for sanitization.
 */
function sourceToTrustLevel(source: ResourceSource): TrustLevel {
	switch (source) {
		case "builtin":
			return "builtin";
		case "user":
			return "user";
		case "project":
			return "project";
		default:
			return "project";
	}
}

/**
 * Sanitize agent system prompt content to reduce prompt injection risk.
 *
 * Uses OWASP Agent Memory Guard-inspired patterns:
 * - Strip zero-width Unicode (potential bypass vectors)
 * - Strip HTML/JS comments and script tags
 * - Strip known prompt injection directives
 * - Strip encoded payloads (base64, hex)
 * - Collapse excessive whitespace
 *
 * Trust levels affect sanitization strictness:
 * - builtin: Minimal sanitization (trusted source)
 * - user: Standard sanitization
 * - project: Strict sanitization (untrusted source)
 */
export function sanitizeAgentSystemPrompt(content: string, source: ResourceSource): string {
	const trustLevel = sourceToTrustLevel(source);
	let sanitized = content;

	// 1. Strip zero-width and invisible Unicode characters (all trust levels)
	sanitized = sanitized.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "");

	// 2. Strip HTML/JS comments (instruction hiding) — all trust levels
	sanitized = sanitized.replace(/<!--[\s\S]*?-->|<\/?script[^>]*>/gi, "");

	// 3. Strip known prompt injection directive patterns — user and project
	if (trustLevel !== "builtin") {
		// Strip lines that look like system directives
		sanitized = sanitized.replace(
			/^\s*(?:SYSTEM|INSTRUCTION|IGNORE(?:\s+ALL)?\s+(?:PREVIOUS|INSTRUCTIONS)?|OVERRIDE|YOUR\s+ROLE\s+IS|MALICIOUS|BACKDOOR)\s*:.*$/gim,
			"",
		);

		// Strip embedded instruction patterns in brackets
		sanitized = sanitized.replace(/\[(?:SYSTEM|INSTRUCTION|OVERRIDE|MALICIOUS)\s*:[^\]]*\]/gi, "");

		// Strip base64/hex-encoded command payloads
		sanitized = sanitized.replace(/\b(base64|base32|hex)\s*['":]\s*([A-Za-z0-9+\/=]{20,})/gi, "[encoded-command-redacted]");

		// Strip eval/exec patterns with encoded content
		sanitized = sanitized.replace(/\b(eval|exec|spawn|subprocess)\s*\(\s*(?:base64|Buffer\.from)\s*\(/gi, "[suspicious-call-redacted]");

		// Strip markdown that attempts to hide instructions
		sanitized = sanitized.replace(/```\s*(?:system|instruction|prompt)\n[\s\S]*?```/gi, "");
	}

	// 4. Project-level strict sanitization
	if (trustLevel === "project") {
		// Strip YAML-like assignment patterns that could override behavior
		sanitized = sanitized.replace(/^\s*(?:role|persona|behavior|directive)\s*[=:].*$/gim, "");

		// Strip potential exfiltration patterns
		sanitized = sanitized.replace(/\b(write|append)\s+.*(?:secrets?|keys?|token|credential)/gi, "[suspicious-write-redacted]");

		// Strip network exfiltration patterns
		sanitized = sanitized.replace(/\b(fetch|curl|wget|axios)\s+.*(?:exfil|steal|leak|send)/gi, "[suspicious-network-redacted]");
	}

	// 5. Collapse multiple blank lines (cleanup after removals)
	sanitized = sanitized.replace(/\n{3,}/g, "\n\n");

	return sanitized.trim();
}

/**
 * M4: per-process dedup set of agent filePaths for which we've already
 * emitted the `contextMode: fork` warn-only notice. Avoids spam when
 * the discovery cache reloads or the same agent is parsed multiple
 * times in a session. Exported for test reset.
 */
const warnedForkAgents = new Set<string>();
export function __test_resetForkWarnings(): void {
	warnedForkAgents.clear();
}

function parseAgentFile(filePath: string, source: ResourceSource): AgentConfig | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter(content);
		const name = frontmatter.name?.trim() || path.basename(filePath, path.extname(filePath));
		const description = frontmatter.description?.trim() || "No description provided.";
		const triggers = parseCsv(frontmatter.triggers ?? frontmatter.trigger);
		const useWhen = parseCsv(frontmatter.useWhen);
		const avoidWhen = parseCsv(frontmatter.avoidWhen);
		const cost = parseCost(frontmatter.cost);
		const category = frontmatter.category?.trim() || undefined;

		// SEC-002: Sanitize system prompt based on source trust level
		const rawSystemPrompt = body.trim();
		const systemPrompt = sanitizeAgentSystemPrompt(rawSystemPrompt, source);

		const contextMode = parseContextMode(frontmatter.contextMode);

		// M4: warn-only when contextMode=fork is configured but the
		// runtime is the default child-process path. `contextMode: fork`
		// is only effective in the live-session runtime (the experimental
		// path that runs the agent IN the parent pi's session). The
		// default child-process path (runChildPi in src/runtime/child-pi.ts)
		// spawns a NEW pi process and has no parent session to inherit,
		// so the agent will behave as `fresh` regardless of the setting.
		// We warn (not throw) so existing configs that predate live-session
		// keep working. Deduped per-filePath so we don't spam on cache
		// reload. Use console.warn (no logger hook here yet; a future
		// refactor could pipe through the same log channel as
		// logInternalError below).
		if (contextMode === "fork" && !warnedForkAgents.has(filePath)) {
			console.warn(
				"contextMode: 'fork' is only effective in live-session runtime; current default child-process will behave as 'fresh'. See docs/runtime-modes.md.",
			);
			warnedForkAgents.add(filePath);
		}

		return {
			name,
			description,
			source,
			filePath,
			systemPrompt,
			// ... rest unchanged
			model: frontmatter.model === "false" ? undefined : frontmatter.model || undefined,
			fallbackModels: parseCsv(frontmatter.fallbackModels),
			thinking: frontmatter.thinking === "false" ? undefined : frontmatter.thinking || undefined,
			tools: parseToolsField(frontmatter.tools),
			extensions: frontmatter.extensions === "" ? [] : parseCsv(frontmatter.extensions),
			excludeExtensions: parseCsv(frontmatter.excludeExtensions ?? frontmatter.exclude_extensions),
			skills: parseCsv(frontmatter.skills ?? frontmatter.skill),
			systemPromptMode: frontmatter.systemPromptMode === "append" ? "append" : "replace",
			inheritProjectContext: frontmatter.inheritProjectContext === "true",
			inheritSkills: frontmatter.inheritSkills === "true",
			memory: parseMemory(frontmatter.memory),
			loadMode: parseLoadMode(frontmatter.loadMode),
			defaultTools: frontmatter.defaultTools !== undefined ? (parseCsv(frontmatter.defaultTools) ?? null) : undefined,
			contextMode,
			maxTurns: (() => {
				const n = Number.parseInt(frontmatter.maxTurns, 10);
				return Number.isFinite(n) && n > 0 ? n : undefined;
			})(),
			maxTokens: (() => {
				const n = Number.parseInt(frontmatter.maxTokens, 10);
				return Number.isFinite(n) && n > 0 ? n : undefined;
			})(),
			effort:
				frontmatter.effort === "low" || frontmatter.effort === "medium" || frontmatter.effort === "high"
					? frontmatter.effort
					: undefined,
			disabled: frontmatter.disabled === "true" || frontmatter.enabled === "false",
			routing: triggers || useWhen || avoidWhen || cost || category ? { triggers, useWhen, avoidWhen, cost, category } : undefined,
		};
	} catch (error) {
		logInternalError("discoverAgents.parseAgentFile", error, `filePath=${filePath}`);
		return undefined;
	}
}

function readAgentDir(dir: string, source: ResourceSource): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];
	const agents = fs
		.readdirSync(dir)
		.filter((entry) => entry.endsWith(".md") && !entry.endsWith(".team.md") && !entry.endsWith(".workflow.md"))
		.map((entry) => parseAgentFile(path.join(dir, entry), source))
		.filter((agent): agent is AgentConfig => agent !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name));

	// SEC-001: Warn about project agents that shadow protected builtins
	if (source === "project") {
		for (const agent of agents) {
			checkProjectAgentShadowsBuiltin(agent.name);
		}
	}

	return agents;
}

function applyAgentOverrides(agents: AgentConfig[], cwd: string, loadedConfig?: LoadedPiTeamsConfig): AgentConfig[] {
	const loaded = loadedConfig ?? loadConfig(cwd);
	const agentsConfig = loaded.config.agents;
	const overrides = agentsConfig?.overrides ?? {};
	return agents
		.filter((agent) => !(agentsConfig?.disableBuiltins && agent.source === "builtin"))
		.map((agent) => {
			const overrideEntry = Object.entries(overrides).find(([name]) => name.toLowerCase() === agent.name.toLowerCase());
			if (!overrideEntry) return agent;
			const [, override] = overrideEntry;
			return {
				...agent,
				disabled: override.disabled ?? agent.disabled,
				model: override.model === false ? undefined : (override.model ?? agent.model),
				fallbackModels: override.fallbackModels === false ? undefined : (override.fallbackModels ?? agent.fallbackModels),
				thinking: override.thinking === false ? undefined : (override.thinking ?? agent.thinking),
				tools: override.tools === false ? undefined : (override.tools ?? agent.tools),
				skills: override.skills === false ? undefined : (override.skills ?? agent.skills),
				override: { source: "config", path: loaded.path },
			};
		});
}

// ─── Agent Discovery Cache (Phase 3a) ────────────────────────────────────
// SEC-005 Fix: Uses version-based cache for atomic invalidation.
// ═══════════════════════════════════════════════════════════════════════════

// F15: raised from 500 ms -> 5 s. The cache-version stamp (SEC-005) plus
// explicit `invalidateAgentDiscoveryCache()` calls from management actions
// (create/update/delete) cover correctness on edit; 5 s TTL is plenty for the
// powerbar / scheduler hot path (~5 Hz when a run is active) and matches the
// TTL we use for workflow / team discovery caches.
const DISCOVERY_CACHE_TTL_MS = 5000;
interface CachedDiscoveryEntry {
	result: AgentDiscoveryResult;
	expiresAt: number;
	cacheVersion: number; // SEC-005: Version stamp for atomic invalidation
}
const discoveryCache = new Map<string, CachedDiscoveryEntry>();
const DISCOVERY_CACHE_MAX_ENTRIES = 32;

function pruneDiscoveryCache(): void {
	const now = Date.now();
	const currentVersion = cacheVersion;
	for (const [key, entry] of discoveryCache) {
		if (entry.expiresAt <= now || entry.cacheVersion < currentVersion) {
			discoveryCache.delete(key);
		}
	}
}

export function invalidateAgentDiscoveryCache(cwd?: string): void {
	incrementCacheVersion();
	if (cwd) {
		discoveryCache.delete(cwd);
	} else {
		discoveryCache.clear();
	}
}

export function discoverAgents(cwd: string): AgentDiscoveryResult {
	pruneDiscoveryCache();
	const currentVersion = cacheVersion;
	const cached = discoveryCache.get(cwd);
	// SEC-005: Check both TTL expiry AND version stamp
	if (cached && cached.expiresAt > Date.now() && cached.cacheVersion >= currentVersion) {
		return cached.result;
	}
	const loaded = loadConfig(cwd);
	const result: AgentDiscoveryResult = {
		builtin: applyAgentOverrides(readAgentDir(path.join(packageRoot(), "agents"), "builtin"), cwd, loaded),
		user: applyAgentOverrides(readAgentDir(path.join(userPiRoot(), "agents"), "user"), cwd, loaded),
		// F1 (v0.7.9): two project roots — the legacy pi-crew `.crew/agents/`
		// (or `.pi/teams/agents/` fallback) AND the Pi-standard `.pi/agents/`.
		// Both are read; `allAgents` merges them in priority order (project
		// first, then project-pi) so a project can override a global agent
		// from either location. Same-name shadows within the project tier
		// log a warning (SEC-001).
		project: applyAgentOverrides(readAgentDir(path.join(projectCrewRoot(cwd), "agents"), "project"), cwd, loaded),
		projectPi: applyAgentOverrides(readAgentDir(path.join(findRepoRoot(cwd) ?? cwd, ".pi", "agents"), "project-pi"), cwd, loaded),
	};
	// SEC-005: Store with current version stamp
	discoveryCache.set(cwd, {
		result,
		expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS,
		cacheVersion: currentVersion,
	});
	while (discoveryCache.size > DISCOVERY_CACHE_MAX_ENTRIES) {
		const oldest = discoveryCache.keys().next().value;
		if (oldest !== undefined) discoveryCache.delete(oldest);
	}
	return result;
}

// ─── Dynamic Agent Registry (Phase 3b) ───────────────────────────────────
// In-memory store for runtime-registered agents. Merged into discovery results
// with highest priority (after project agents).

const dynamicAgents = new Map<string, AgentConfig>();

/** Register a dynamic agent at runtime. Throws if already registered or if name is protected. */
export function registerDynamicAgent(config: AgentConfig): void {
	const key = config.name.toLowerCase();
	// Security check: prevent shadowing of builtin agents (SEC-001)
	assertAgentNameAllowed(config.name);
	if (dynamicAgents.has(key)) {
		throw new Error(`Agent already registered: ${config.name}`);
	}
	dynamicAgents.set(key, { ...config, source: "dynamic" }); // Always "dynamic" — cannot be spoofed
	invalidateAgentDiscoveryCache();
}

/** Unregister a previously registered dynamic agent. Throws if not found. */
export function unregisterDynamicAgent(name: string): void {
	const removed = dynamicAgents.delete(name.toLowerCase());
	if (!removed) {
		throw new Error(`Agent not found: ${name}`);
	}
	invalidateAgentDiscoveryCache();
}

/** List all currently registered dynamic agents. */
export function listDynamicAgents(): AgentConfig[] {
	return [...dynamicAgents.values()];
}

export function allAgents(discovery: AgentDiscoveryResult | undefined): AgentConfig[] {
	if (!discovery) return [];
	const byName = new Map<string, AgentConfig>();
	// Priority for disambiguation (security): project < builtin < user.
	// Project config cannot override trusted builtins (security-hardening).
	// Later entries in the loop overwrite earlier ones, so user wins.
	// F1 (v0.7.9): `projectPi` is appended AFTER `project` so a `.pi/agents/foo.md`
	// is a fallback to `.crew/agents/foo.md` within the project tier (the
	// legacy pi-crew directory takes precedence when both exist). This
	// matches `applyAgentOverrides` semantics and keeps the SECURITY warning
	// gate on the same source. `projectPi` is optional in the result type
	// (older test fixtures may omit it) — fall back to an empty array.
	for (const agent of [...discovery.project, ...(discovery.projectPi ?? []), ...discovery.builtin, ...discovery.user]) {
		byName.set(agent.name.toLowerCase(), agent);
	}
	// Dynamic agents only fill gaps — they cannot override builtin/user agents.
	// SECURITY: Dynamic agents are less trusted (registered at runtime by extensions/hooks).
	// They are only used if no builtin/user agent with the same name exists.
	for (const agent of dynamicAgents.values()) {
		const key = agent.name.toLowerCase();
		if (!byName.has(key)) {
			byName.set(key, agent);
		}
		// NOTE: If an agent with the same name exists, the dynamic version is ignored.
		// This prevents privilege escalation via agent shadowing (SEC-001).
	}
	return [...byName.values()].filter((agent) => !agent.disabled).sort((a, b) => a.name.localeCompare(b.name));
}

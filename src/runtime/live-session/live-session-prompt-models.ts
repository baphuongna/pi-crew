/**
 * Model resolution + system-prompt building for the live-session path.
 *
 * PROVENANCE (pure move, 2026-10-27): every declaration in this file was
 * moved verbatim from `live-session-runtime.ts` @ 39fe0b3a (ranges 133-174,
 * 240-260, 455-725) to open wc-gate headroom. Byte-identical bodies except
 * added `export` keywords. Public surface of live-session-runtime.ts is
 * preserved via re-exports there (LiveSessionSpawnInput, liveSystemPrompt,
 * resolveScopedSessionModels, resolveParentModelFromRegistry).
 */

import type { AgentConfig } from "../../agents/agent-config.ts";
import { resolveToolPolicy } from "../../agents/agent-config.ts";
import type { CrewRuntimeConfig } from "../../config/config.ts";
import { loadConfig } from "../../config/config.ts";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import type { WorkflowStep } from "../../workflows/workflow-config.ts";
import { mcpPermittedForRole } from "../mcp-proxy.ts";
import {
	availableModelInfosFromRegistry,
	type ModelFallbackPolicy,
	modelRefToString,
	providerOfModelRef,
	resolveDefaultSubagentModel,
	resolveModelFallbackPolicy,
} from "../model/model-fallback.ts";
import { readEnabledModelsPatterns } from "../model/model-scope.ts";
import { buildSensitivePathConstraint } from "../sensitive-paths.ts";
import type { LiveSessionEmbeddedMitigations } from "./embedded-tier.ts";
import { asRecord, type SessionStatsLike } from "./usage-bridge.ts";

export interface LiveSessionSpawnInput {
	manifest: TeamRunManifest;
	task: TeamTaskState;
	step: WorkflowStep;
	agent: AgentConfig;
	prompt: string;
	signal?: AbortSignal;
	transcriptPath?: string;
	onEvent?: (event: unknown) => void;
	onOutput?: (text: string) => void;
	runtimeConfig?: CrewRuntimeConfig;
	parentContext?: string;
	parentModel?: unknown;
	modelRegistry?: unknown;
	modelOverride?: string;
	teamRoleModel?: string;
	teamRoleFallbackModels?: string[];
	teamRoleThinking?: string;
	isCurrent?: () => boolean;
	/** Workspace where this run was initiated — used for session-scoped live-agent visibility. */
	workspaceId: string;
	/** Phase 2: Output schema for validating yield data. */
	outputSchema?: unknown;
	/**
	 * U3 test seam: optional pi-ai `Provider`-like object registered on the
	 * created session's ModelRuntime immediately after session creation, before
	 * anything streams. Lets tests run the REAL in-process live-session worker
	 * key-free and network-free against `@earendil-works/pi-ai/providers/faux`
	 * (tests construct the provider and pass it here; runtime code never
	 * imports the faux module). Must stay undefined in production runs.
	 */
	modelProviderOverride?: unknown;
	/**
	 * U11 embedded-tier mitigations (DEFAULT-OFF). Present ONLY when the hybrid
	 * orchestration layer routed this task to the embedded tier for an
	 * opted-in role: builtin-tools-only enforcement, provider timeoutMs,
	 * turn-count watchdog, embedded concurrency cap, process-level fault
	 * guard, bounded memory metrics and factory/global-state asserts. When
	 * undefined this function behaves byte-identically to pre-U11.
	 */
	embeddedMitigations?: LiveSessionEmbeddedMitigations;
}

export type LiveSessionLike = {
	subscribe?: (listener: (event: unknown) => void) => () => void;
	prompt?: (text: string, options?: Record<string, unknown>) => Promise<void>;
	steer?: (text: string) => Promise<void>;
	abort?: () => Promise<void> | void;
	dispose?: () => void;
	/** U16: SDK AgentSession session-level stats surface (aggregate tokens + cost) — shape: usage-bridge.ts (SessionStatsLike). */
	getSessionStats?: () => SessionStatsLike;
	bindExtensions?: (bindings?: Record<string, unknown>) => Promise<void>;
	getActiveToolNames?: () => string[];
	setActiveToolsByName?: (names: string[]) => void;
	/** U3 test-seam surface: SDK AgentSession exposes its ModelRuntime here. */
	modelRuntime?: {
		registerNativeProvider?: (provider: unknown) => void;
		/** U11 (b): surfaces used to wrap/restore the provider with a default timeoutMs. */
		getProvider?: (providerId: string) => unknown;
		getRegisteredNativeProvider?: (providerId: string) => unknown;
	};
	/** U4 recursion guard (layer 1): public SDK accessor for loaded extension paths. */
	extensionRunner?: { getExtensionPaths?: () => string[] };
};

export function applyModelProviderOverride(session: LiveSessionLike | undefined, provider: unknown): void {
	if (!session || !provider) return;
	const runtime = asRecord(session.modelRuntime);
	const register = runtime?.registerNativeProvider;
	if (typeof register !== "function") return;
	try {
		register.call(runtime, provider);
	} catch (error) {
		logInternalError("live-session.model-provider-override", error, "registerNativeProvider failed");
	}
}

/**
 * F7: resolve the enabledModels allowlist for the current project, but only
 * if the `reliability.scopeModels` toggle is ON. Returns an empty
 * array when the toggle is off or no allowlist is configured — the routing
 * gate treats empty patterns as "no enforcement" (no-op). Best-effort:
 * any failure to read the toggle or the allowlist silently disables the gate
 * rather than blocking spawn.
 */
export async function resolveScopeModelsPatterns(cwd: string, agentDir?: string): Promise<string[]> {
	let scopeModels = false;
	try {
		scopeModels = loadConfig(cwd).config.reliability?.scopeModels === true;
	} catch {
		return [];
	}
	if (!scopeModels) return [];
	return readEnabledModelsPatterns(cwd, agentDir);
}

/** Resolve model fallback policy from crew config + env (best-effort). */
export function resolveLiveModelFallbackPolicy(cwd: string): ModelFallbackPolicy | undefined {
	try {
		return resolveModelFallbackPolicy(loadConfig(cwd).config.runtime?.modelFallback);
	} catch {
		return undefined;
	}
}

/** Resolve the default subagent model from crew config + env. */
export function resolveLiveDefaultSubagentModel(cwd: string): string | undefined {
	try {
		return resolveDefaultSubagentModel(loadConfig(cwd).config.runtime?.modelFallback);
	} catch {
		return undefined;
	}
}

export function modelFromRegistry(modelRegistry: unknown, modelId: string | undefined): unknown {
	if (!modelId?.includes("/")) return undefined;
	const registry = asRecord(modelRegistry);
	const find = registry?.find;
	if (typeof find !== "function") return undefined;
	const [provider, ...modelParts] = modelId.split("/");
	const id = modelParts.join("/");
	try {
		return find.call(modelRegistry, provider, id);
	} catch {
		return undefined;
	}
}

/**
 * R3-12: resolve pi-crew's fallback chain into pi SDK `scopedModels` entries.
 *
 * SDK semantics (pi-coding-agent docs/sdk.md; dist/core/agent-session.js):
 * `scopedModels` bounds the session's CYCLING scope and what extensions see
 * through `getScopedModels` — it is NOT a hard access gate (`setModel` still
 * accepts any credentialed model), so binding the fallback chain cannot break
 * a legitimate user/model override. Candidates that don't resolve in the
 * registry are skipped; an empty result means the caller passes NO option so
 * pi keeps its default scope (all available models) — the "explicit
 * non-empty" guard from the R3 spec.
 */
export function resolveScopedSessionModels(modelRegistry: unknown, candidates: readonly string[]): Array<{ model: unknown }> {
	const scoped: Array<{ model: unknown }> = [];
	for (const candidate of candidates) {
		const model = modelFromRegistry(modelRegistry, candidate);
		if (!model || typeof model !== "object") continue;
		if (scoped.some((entry) => entry.model === model)) continue;
		scoped.push({ model });
	}
	return scoped;
}

/**
 * Round 18: when agent declares `model: false`, the inherited `parentModel`
 * (= `ctx.model` from Pi runtime, set via `team-tool.ts:541/655`) is the
 * session's SAVED model. That saved model can be stale (e.g. a previous
 * session used claude-sonnet-4-5 and saved it as session.model; the new
 * session actually runs on minimax-M3 displayed in the footer). If the
 * saved model has no auth in `modelRegistry`, the worker fails immediately
 * with "No API key found" before reaching any fallback candidate.
 *
 * This helper prefers the saved model when it is in the auth-available
 * registry; otherwise falls back to the first auth-available registry
 * model (e.g. minimax/MiniMax-M3, zai/glm-5.2); otherwise returns the
 * raw `parentModel` unchanged so the caller surfaces E008.
 */
export function resolveParentModelFromRegistry(modelRegistry: unknown, rawParentModel: unknown): string | undefined {
	// `ctx.model` is a pi `Model` OBJECT, not a string. The old string-only
	// guard silently discarded it, so every live-session subagent that inherited
	// the parent model landed on `getAvailable()[0]` instead — i.e. the parent
	// model was never actually honoured on this path.
	const raw = modelRefToString(rawParentModel);
	if (raw) {
		const candidate = raw.includes("/")
			? raw
			: (() => {
					const m = modelFromRegistry(modelRegistry, raw);
					if (m && typeof m === "object" && "fullId" in m) {
						return String((m as { fullId?: unknown }).fullId ?? raw);
					}
					return undefined;
				})();
		if (candidate && modelFromRegistry(modelRegistry, candidate)) return candidate;
	}
	const available = availableModelInfosFromRegistry(modelRegistry);
	if (available && available.length > 0) {
		// Staying on the parent's provider keeps the same auth + cost profile;
		// only cross providers when the parent's provider has nothing available.
		const parentProvider = providerOfModelRef(raw);
		const sameProvider = parentProvider ? available.find((entry) => entry.provider === parentProvider) : undefined;
		return (sameProvider ?? available[0]).fullId;
	}
	return raw;
}

/** Communication intensity by role (caveman-inspired token optimization) */
const ROLE_INTENSITY: Record<string, "lite" | "full" | "ultra"> = {
	explorer: "ultra",
	analyst: "full",
	planner: "full",
	critic: "full",
	executor: "full",
	reviewer: "full",
	"security-reviewer": "full",
	"test-engineer": "full",
	verifier: "full",
	writer: "lite",
};

function buildCommunicationStyle(role: string): string {
	const intensity = ROLE_INTENSITY[role] ?? "full";
	if (intensity === "lite") return "## Communication\nProfessional concise. No filler/hedging. Full sentences OK.";
	if (intensity === "ultra")
		return [
			"## Communication (ultra-compressed)",
			"Drop: articles, filler, hedging, pleasantries. Fragments OK.",
			"Pattern: [thing] [action] [reason].",
			"Code/paths/symbols: exact, never abbreviated. Errors quoted exact.",
			"Abbreviate prose words: DB/auth/config/req/res/fn/impl.",
			"Arrows for causality: X → Y. One word when one word enough.",
			"Security/destructive: write normal English. Resume compressed after.",
		].join("\n");
	return [
		"## Communication (compressed)",
		"Drop: articles (a/an/the), filler (just/really/basically/actually/simply), hedging, pleasantries.",
		"Short synonyms. Fragments OK. Pattern: [thing] [action] [reason]. [next step].",
		"Code/paths/symbols: exact. Errors quoted exact.",
		"Security/destructive: write normal English. Resume compressed after.",
	].join("\n");
}

function buildOutputContract(role: string): string {
	if (role === "explorer")
		return [
			"## Output Contract",
			"<path>:<line> — `<symbol>` — <≤6 word note>",
			"Group: Defs: / Refs: / Callers: / Tests: / Sites:",
			'Zero hits → "No match."',
			"Last line → totals: N defs, M refs.",
		].join("\n");
	if (role === "executor")
		return [
			"## Output Contract",
			"<path>:<line-range> — <change ≤10 words>.",
			"verified: <re-read OK | mismatch @ path:line>.",
			"Refusal tokens: too-big. / needs-confirm. / ambiguous. / regressed.",
		].join("\n");
	if (role === "reviewer" || role === "security-reviewer")
		return [
			"## Output Contract",
			"<path>:<line>: <emoji> <severity>: <problem>. <fix>.",
			"Severity: 🔴 bug, 🟡 risk, 🔵 nit, ❓ question.",
			'Zero findings → "No issues."',
			"Sorted: file order → ascending line numbers.",
		].join("\n");
	if (role === "verifier")
		return [
			"## Output Contract",
			"PASS: <what verified> — <evidence ≤20 words>.",
			"FAIL: <what failed> — <reason>. <expected vs actual>.",
			"Evidence: file paths, test output, or diffs.",
		].join("\n");
	if (role === "writer") return "## Output Contract\nWrite clear documentation. Full sentences. No compression.";
	return ""; // planner, critic, analyst, test-engineer: no strict format
}

/**
 * Phase 3 (caveman): Compress tool descriptions in a live session to reduce
 * input token cost per tool call. MCP tools often have verbose descriptions
 * (e.g. "This tool allows you to search for files in the filesystem..." → "Search files in filesystem.").
 * Compresses only description text, never modifies tool names or parameters.
 */
export function compressSessionToolDescriptions(session: LiveSessionLike): void {
	if (typeof session.getActiveToolNames !== "function") return;
	// The Pi SDK doesn't expose a setDescription API, but we can attempt
	// to compress via setActiveToolsByName if the session supports it.
	// For now, this is a no-op that documents the intent for future SDK support.
	// When Pi SDK adds tool description mutation, this function will compress.
	// Side benefit: the import of compressToolDescription ensures the module
	// is loaded and tree-shakeable, so adding the actual logic later is trivial.
}

export function liveSystemPrompt(input: LiveSessionSpawnInput): string {
	// Agent MEMORY is intentionally omitted here — it is already injected via
	// renderTaskPrompt().full (the user prompt, shared with the child-pi path).
	// See the import-block note above and the G3 fix.
	const role = input.task.role;
	const styleBlock = buildCommunicationStyle(role);
	const contractBlock = buildOutputContract(role);
	const sensitiveConstraint = buildSensitivePathConstraint();
	return [
		"# pi-crew Live Subagent",
		`Run ID: ${input.manifest.runId}`,
		`Task ID: ${input.task.id}`,
		`Role: ${role}`,
		`Agent: ${input.agent.name}`,
		`Working directory: ${input.task.cwd}`,
		"",
		styleBlock,
		contractBlock,
		sensitiveConstraint,
		"",
		input.agent.systemPrompt || "Follow the user task exactly and report verification evidence.",
	]
		.filter(Boolean)
		.join("\n");
}

export function filterActiveTools(session: LiveSessionLike, agent: AgentConfig, role?: string): void {
	if (typeof session.getActiveToolNames !== "function" || typeof session.setActiveToolsByName !== "function") return;
	const recursiveTools = new Set(["team", "Team", "Agent", "get_subagent_result", "steer_subagent"]);
	// U4 hung-tool mitigation (a) "builtin-tools-only": hard floor on the
	// active set — built-in tools (bash honors AbortSignal via killProcessTree),
	// MCP tools for MCP-permitted roles, and pi-crew's own custom tools. Any
	// other tool name (extension drift the loader-level guard missed) is
	// dropped from the ACTIVE set here (layer 2).
	const builtinFloor = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "submit_result", "irc"]);
	const mcpPermitted = mcpPermittedForRole(role);
	// F1 unify (v0.8.0): use the shared resolveToolPolicy so this path agrees
	// with child-pi (pi-args.ts). Before this, live-session used frontmatter
	// only and ignored role-config entirely — so a builtin explorer on the
	// live-session path wasn't bound by the role's read-only security constraint.
	// Now allowlist precedence is source-aware and the denylist is additive.
	const policy = resolveToolPolicy(agent, role);
	const disallowed = policy.excludeTools?.length ? new Set(policy.excludeTools) : undefined;
	const allowed = policy.tools?.length ? new Set(policy.tools) : undefined;
	const active = session
		.getActiveToolNames()
		.filter(
			(name) =>
				!recursiveTools.has(name) &&
				!disallowed?.has(name) &&
				(!allowed || allowed.has(name)) &&
				(builtinFloor.has(name) || (mcpPermitted && name.startsWith("mcp__"))),
		);
	session.setActiveToolsByName(active);
}

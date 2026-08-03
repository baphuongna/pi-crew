/**
 * model-scope.ts — Opt-in model-scope enforcement (F7).
 *
 * When `runtime.reliability.scopeModels` is enabled, subagent model choices
 * that fall outside the user's pi `enabledModels` allowlist are flagged:
 *   - Caller-supplied (per-spawn override / step / team role) out-of-scope
 *     → HARD ERROR to orchestrator (fail fast before spawn).
 *   - Frontmatter-pinned (AgentConfig.model) out-of-scope
 *     → WARNING + runs anyway (frontmatter is authoritative; the agent
 *     author made a deliberate choice).
 *
 * Pattern semantics match pi's `--models` CLI / `enabledModels` allowlist:
 *   - `"anthropic/claude-opus-4-5"` — exact match (case-insensitive).
 *   - `"claude-*"`, `"*sonnet*"`, `"github-copilot/*"` — glob (single `*`).
 *   - Any other string — case-insensitive substring fallback (pi's
 *     `tryMatchModel` behavior, model-resolver.ts).
 *
 * This module is pure (no I/O, no globals). Reading the actual
 * `enabledModels` from pi's settings is the caller's job (instantiate
 * `SettingsManager.create(cwd, agentDir).getEnabledModels()`).
 *
 * The toggle itself lives in `config/defaults.ts` (`reliability.scopeModels`,
 * default `false` = opt-in, fully back-compat).
 */

export type ModelScopeSource = "caller" | "frontmatter" | "resolved" | "fallback";

export interface ModelScopeCheck {
	/** True when the model is in scope, or no allowlist is configured. */
	inScope: boolean;
	/** What the model came from. Informational; the gate decision lives in `enforce`. */
	source: ModelScopeSource;
	/** The model id that was checked. */
	model: string;
	/** The pattern(s) that matched, or undefined when no allowlist was configured. */
	matchedPattern?: string;
	/** Human-readable reason for out-of-scope (caller-facing when rejected). */
	reason?: string;
}

/**
 * Convert a glob pattern with `*` wildcards into a RegExp.
 * Escape all regex meta-characters except `*`, which becomes `.*`.
 * Anchored (^...$) and case-insensitive.
 */
export function patternToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${escaped.replace(/\*/g, ".*")}`, "i");
}

/**
 * Does a model id match a single allowlist pattern?
 * Semantics (in order):
 *   1. Exact case-insensitive match.
 *   2. Glob match (pattern contains `*`).
 *   3. Case-insensitive substring match (pi's fallback).
 * Returns true on first hit; false otherwise.
 */
export function matchesModelPattern(modelId: string, pattern: string): boolean {
	if (!modelId || !pattern) return false;
	const id = modelId.trim();
	const pat = pattern.trim();
	if (!id || !pat) return false;
	if (id.toLowerCase() === pat.toLowerCase()) return true;
	if (pat.includes("*")) {
		try {
			return patternToRegExp(pat).test(id);
		} catch {
			return false;
		}
	}
	return id.toLowerCase().includes(pat.toLowerCase());
}

/**
 * Is the model id accepted by ANY of the allowlist patterns?
 * Returns false when patterns is empty/undefined (caller treats as "no scope").
 */
export function isModelInScope(modelId: string | undefined, patterns: readonly string[] | undefined): boolean {
	if (!modelId || !patterns || patterns.length === 0) return false;
	return patterns.some((p) => matchesModelPattern(modelId, p));
}

/**
 * Check a model against the allowlist and return a verdict.
 * Returns `inScope: true` with no `reason` when no allowlist is configured
 * (so callers can no-op cleanly).
 */
export function checkModelScope(
	modelId: string | undefined,
	patterns: readonly string[] | undefined,
	source: ModelScopeSource,
): ModelScopeCheck {
	if (!modelId) {
		return {
			inScope: true,
			source,
			model: "",
			reason: "no model specified",
		};
	}
	if (!patterns || patterns.length === 0) {
		// No allowlist → not enforcing. The toggle is opt-in; the user hasn't
		// configured `enabledModels` so there is nothing to enforce against.
		return { inScope: true, source, model: modelId };
	}
	for (const pattern of patterns) {
		if (matchesModelPattern(modelId, pattern)) {
			return {
				inScope: true,
				source,
				model: modelId,
				matchedPattern: pattern,
			};
		}
	}
	return {
		inScope: false,
		source,
		model: modelId,
		reason: `model "${modelId}" is not in enabledModels allowlist (${patterns.join(", ")})`,
	};
}

/**
 * Read the user's `enabledModels` allowlist from pi's SettingsManager.
 * Returns an empty array when the SettingsManager export is unavailable, the
 * allowlist is unset, or any error occurs (best-effort, never throws). The
 * caller should still gate on `runtime.reliability.scopeModels` — an empty
 * patterns array is a no-op (nothing to enforce against).
 *
 * @internal Only the runtime spawn layers should call this. Pure module: pure
 * function over a cwd + optional agentDir.
 */
export async function readEnabledModelsPatterns(cwd: string, agentDir?: string): Promise<string[]> {
	try {
		// Match the pattern live-session-runtime.ts:428 uses to bridge to pi's
		// SDK. SettingsManager is dynamically imported because the module
		// shape differs across pi versions; the create() factory is the
		// canonical, version-stable entry point.
		// LAZY: defer dynamic import of @earendil-works/pi-coding-agent to its call site.
		const mod = await import("@earendil-works/pi-coding-agent" as string).catch(() => null);
		if (!mod) return [];
		const SettingsManagerCtor = (
			mod as {
				SettingsManager?: {
					create?: (cwd: string, agentDir?: string) => { getEnabledModels?: () => string[] | undefined };
				};
			}
		).SettingsManager;
		if (!SettingsManagerCtor?.create) return [];
		const sm = SettingsManagerCtor.create(cwd, agentDir);
		const patterns = sm.getEnabledModels?.();
		return Array.isArray(patterns) ? patterns : [];
	} catch {
		return [];
	}
}

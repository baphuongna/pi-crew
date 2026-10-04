/**
 * model-scope.ts — Opt-in model-scope enforcement (F7).
 *
 * When `reliability.scopeModels` is enabled, subagent model choices
 * that fall outside the user's pi `enabledModels` allowlist are flagged:
 *   - Caller-supplied (per-spawn override / step / team role) out-of-scope
 *     → HARD ERROR to orchestrator (fail fast before spawn).
 *   - Frontmatter-pinned (AgentConfig.model) out-of-scope
 *     → WARNING + runs anyway (frontmatter is authoritative; the agent
 *     author made a deliberate choice).
 *   - defaultSubagentModel / parentModel-inherited out-of-scope
 *     → WARNING + runs anyway (soft warn, same as frontmatter).
 *
 * Pattern semantics mirror pi 1.0.0's canonical `resolveModelScopeFromModels()`
 * (SDK `core/model-resolver.js:204-270`) and `parseModelPattern()` (:155-200) —
 * R3-20 alignment (docs/reviews/pi-1.0.0-deep-learn-r3-2026-10-03.md §R3b.3):
 *   - Optional `:<thinking>` suffix (`off|minimal|low|medium|high|xhigh|max`,
 *     case-sensitive) is stripped from patterns AND resolved model ids before
 *     matching, so `anthropic/claude-sonnet-5:high` in enabledModels no longer
 *     falsely rejects the plain model id (hard-error bug).
 *   - A pattern containing ANY of `*`, `?`, `[` is a glob, translated with
 *     minimatch semantics (`*`/`?` do not cross `/`, `[...]`/`[!...]` classes,
 *     whole-segment `**` crosses separators), anchored + case-insensitive.
 *   - Globs are tried against BOTH the configured `provider/id` form and the
 *     bare model id (after the first `/`), mirroring
 *     `minimatch(fullId, p) || minimatch(id, p)` — so `gpt-5*` matches
 *     `openai/gpt-5-mini`.
 *   - Non-glob patterns fall back to case-insensitive substring, progressively
 *     stripping trailing colon suffixes (mirrors parseModelPattern's
 *     recursion: valid levels become thinking hints, invalid ones are
 *     recursed through with a warning — membership still follows the prefix).
 *
 * Why reimplement instead of importing the canonical matcher: the SDK does
 * NOT export `resolveModelScopeFromModels` from the package root (runtime-
 * verified: only `resolveModelScopeWithDiagnostics` is exported, and it needs
 * a live async `ModelRuntime` + catalog I/O). This gate is synchronous and
 * this module is pure by design, so an exact-semantics reimplementation is
 * the only import-compatible option. Residual divergence (documented, not
 * fixable string-level): canonical fuzzy also matches model display `name`s
 * (`model-resolver.js:114-115`), which requires the catalog — display-name-
 * only patterns (e.g. `"Claude Opus 4.5"`) stay unmatched here.
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
 * Valid `:<thinking>` level names — mirrors pi's `VALID_THINKING_LEVELS`
 * (SDK `cli/args.js`). Matched case-sensitively, exactly like the canonical
 * `isValidThinkingLevel()`, so OpenRouter-style ids (`foo:exacto`) and
 * mistyped levels (`:HIGH`) are NOT treated as thinking suffixes.
 */
const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function isValidThinkingLevel(level: string): boolean {
	return (VALID_THINKING_LEVELS as readonly string[]).includes(level);
}

/**
 * Strip one trailing VALID `:<thinking>` suffix — the canonical glob-branch
 * rule (model-resolver.js:214-222). Invalid suffixes are left in place here;
 * the fuzzy branch strips them progressively instead (parseModelPattern
 * recursion) — see matchesModelPattern.
 */
function stripValidThinkingSuffix(value: string): string {
	const colonIdx = value.lastIndexOf(":");
	if (colonIdx === -1) return value;
	return isValidThinkingLevel(value.substring(colonIdx + 1)) ? value.substring(0, colonIdx) : value;
}

/** Does the pattern contain glob characters? Canonical test: `*`, `?` or `[`. */
function hasGlobChars(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

/** Escape a literal character for use in a RegExp body. */
function escapeRegExpChar(ch: string): string {
	return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Convert a glob pattern into an anchored, case-insensitive RegExp with
 * minimatch semantics (canonical uses `minimatch(p, { nocase: true })`):
 *   - `*`  → `[^/]*` (any run of non-separator chars; does NOT cross `/`)
 *   - `?`  → `[^/]` (exactly one non-separator char)
 *   - `[...]` / `[!...]` / `[^...]` → character class (both `!` and `^` negate)
 *   - `[` without a closing `]` → literal `[`
 *   - a whole-segment run of `**` → `.*` (crosses separators, but still
 *     requires the preceding `/` — `anthropic/**` does not match `anthropic`)
 *   - everything else → regex-escaped literal
 */
export function patternToRegExp(pattern: string): RegExp {
	let out = "^";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			let end = i;
			while (end < pattern.length && pattern[end] === "*") end++;
			const wholeSegment = (i === 0 || pattern[i - 1] === "/") && (end === pattern.length || pattern[end] === "/");
			out += end - i >= 2 && wholeSegment ? ".*" : "[^/]*";
			i = end - 1;
		} else if (ch === "?") {
			out += "[^/]";
		} else if (ch === "[") {
			const closing = pattern.indexOf("]", i + 1);
			let inner = closing === -1 ? "" : pattern.substring(i + 1, closing);
			let negated = false;
			if (inner.startsWith("!") || inner.startsWith("^")) {
				negated = true;
				inner = inner.substring(1);
			}
			if (closing === -1 || inner.length === 0) {
				// Unmatched `[` (or empty class `[]`/`[!]`) → literal, like minimatch.
				out += "\\[";
			} else {
				let cls = "";
				for (const c of inner) {
					if (c === "\\") cls += "\\\\";
					else if (c === "]") cls += "\\]";
					else cls += c;
				}
				out += `[${negated ? "^" : ""}${cls}]`;
				i = closing;
			}
		} else {
			out += escapeRegExpChar(ch);
		}
	}
	return new RegExp(`${out}$`, "i");
}

/**
 * Does a model id match a single allowlist pattern?
 * Mirrors the canonical `resolveModelScopeFromModels()` per-pattern flow:
 *   - Glob branch (pattern contains `*`, `?` or `[`): strip one VALID
 *     `:<thinking>` suffix, try the exact reference first, then match the
 *     glob against BOTH the configured string and its bare-id form
 *     (`minimatch(fullId, p) || minimatch(id, p)`, model-resolver.js:228-232).
 *   - Fuzzy branch (parseModelPattern): substring match, progressively
 *     stripping trailing colon suffixes until a hit or no colon remains.
 * Returns true on first hit; false otherwise.
 */
export function matchesModelPattern(modelId: string, pattern: string): boolean {
	if (!modelId || !pattern) return false;
	const rawId = modelId.trim();
	const rawPat = pattern.trim();
	if (!rawId || !rawPat) return false;
	// Canonical compares thinking-less base ids: pi-crew's resolved candidates
	// keep their `:high` suffix (splitThinkingSuffix), and user patterns may
	// carry one — strip valid suffixes from BOTH sides before matching.
	const id = stripValidThinkingSuffix(rawId);
	// Bare-id form = everything after the FIRST `/` (the provider segment);
	// openrouter-style ids can themselves contain slashes.
	const bareId = id.includes("/") ? id.substring(id.indexOf("/") + 1) : id;
	if (hasGlobChars(rawPat)) {
		const glob = stripValidThinkingSuffix(rawPat);
		if (id.toLowerCase() === glob.toLowerCase() || bareId.toLowerCase() === glob.toLowerCase()) {
			return true;
		}
		try {
			const re = patternToRegExp(glob);
			return re.test(id) || re.test(bareId);
		} catch {
			return false;
		}
	}
	let pat = rawPat;
	for (;;) {
		// Substring over the configured form is a superset of canonical's
		// exact-then-substring over the same string, so verdicts agree.
		if (id.toLowerCase().includes(pat.toLowerCase())) return true;
		const colonIdx = pat.lastIndexOf(":");
		if (colonIdx === -1) return false;
		pat = pat.substring(0, colonIdx);
	}
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
 * caller should still gate on `reliability.scopeModels` — an empty
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

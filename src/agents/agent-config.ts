import type { RoleToolConfig } from "../config/role-tools.ts";
import { getToolConfig } from "../config/role-tools.ts";

/**
 * F1 (v0.7.9): canonical built-in tool name list. Used by `parseToolsField`
 * to expand wildcard `*` / `all` patterns in agent frontmatter. Matches
 * pi-subagents' `BUILTIN_TOOL_NAMES` (derived from pi's `createCodingTools` /
 * `createReadOnlyTools`). If pi adds a new built-in, update this list and
 * the wildcard expansion will pick it up. The 7 names below are stable
 * across pi v0.77+ and cover read, edit, write, bash, grep, find, ls.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = ["read", "edit", "write", "bash", "grep", "find", "ls"];

/**
 * F1 (v0.7.9): normalize the raw `tools:` frontmatter CSV into a `string[]`.
 * Semantics (matching pi-subagents' `parseToolsField`):
 *   - omitted / undefined → returns `undefined` (back-compat: use the
 *     runtime default — today this is the role-tools default; tomorrow this
 *     could become the wildcard expansion if the user opts in).
 *   - `*` or `all` (case-insensitive) → returns the full BUILTIN_TOOL_NAMES
 *     list (no duplicates).
 *   - `none` or empty string → returns `[]` (zero built-ins; extension
 *     tools via `ext:` can still be added, though pi-crew doesn't parse
 *     `ext:` selectors yet — see F1 sub-gap).
 *   - CSV → returns the parsed entries (trimmed, empty entries dropped).
 * Plain tool names (no `*`) pass through unchanged so existing agent
 * files keep working with no edits.
 */
export function parseToolsField(raw: unknown): string[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	const s = typeof raw === "string" ? raw.trim() : String(raw).trim();
	if (!s) return [];
	const lowered = s.toLowerCase();
	if (lowered === "none" || lowered === "[]") return [];
	if (lowered === "*" || lowered === "all") return [...BUILTIN_TOOL_NAMES];
	const items = s
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	return items;
}

export type ResourceSource = "builtin" | "user" | "project" | "git" | "dynamic" | "project-pi";

export interface RoutingMetadata {
	triggers?: string[];
	useWhen?: string[];
	avoidWhen?: string[];
	cost?: "free" | "cheap" | "expensive";
	category?: string;
}

export interface AgentConfig {
	name: string;
	description: string;
	source: ResourceSource;
	filePath: string;
	systemPrompt: string;
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	tools?: string[];
	extensions?: string[];
	/**
	 * F1 (v0.7.9): extension denylist (case-insensitive plain names). Applied
	 * AFTER `extensions:` (which lists the allowed set) — an excluded
	 * extension is removed from the allowlist and never loads. Plain names
	 * only (no paths, no `*`); an unknown name logs a warning but is
	 * tolerated. Back-compat: omitted = no exclusion.
	 */
	excludeExtensions?: string[];
	skills?: string[];
	systemPromptMode?: "replace" | "append";
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	routing?: RoutingMetadata;
	memory?: "user" | "project" | "local";
	/** Tool loading strategy: "essential" = always load all tools, "lean" = only load tools in defaultTools list */
	loadMode?: "essential" | "lean";
	/** Explicit tool list when loadMode is "lean". null means all available tools. */
	defaultTools?: string[] | null;
	/** Context mode: "fresh" = clean start, "fork" = inherit parent session context */
	contextMode?: "fresh" | "fork";
	/** Maximum turns for this agent. Overrides runtime config if set. */
	maxTurns?: number;
	/** Cap on output tokens per API call. Set via PI_CREW_MAX_OUTPUT env in child. */
	maxTokens?: number;
	/** Effort level for this agent. Controls how much work the agent puts in. */
	effort?: "low" | "medium" | "high";
	/** Tools to explicitly forbid for this agent. Takes precedence over allowedTools. */
	disallowedTools?: string[];
	/** Disable ALL tools (Pi `--no-tools`). Used by capability-locked agents like the goal-judge (P1)
	 *  that must have NO agency — only emit a verdict. §0c C6: an empty `tools:[]` is INSUFFICIENT
	 *  because pi-args.ts skips empty arrays, leaving default tools enabled. */
	disableTools?: boolean;
	disabled?: boolean;
	override?: { source: "config"; path: string };
}

/**
 * Get session options (tools/excludeTools) for a specific role.
 * Used by child-pi to apply role-based tool restrictions.
 */
export function getAgentSessionOptions(role: string): {
	tools?: string[];
	excludeTools?: string[];
} {
	const config: RoleToolConfig = getToolConfig(role);

	if (config.tools || config.excludeTools) {
		return {
			tools: config.tools,
			excludeTools: config.excludeTools,
		};
	}

	return {};
}

/**
 * F1 unify (v0.8.0): the single source of truth for a worker's tool policy,
 * used by BOTH spawn paths (child-pi `pi-args.ts` and live-session
 * `live-session-runtime.ts`). Before this, the two paths disagreed:
 *   - child-pi: `roleConfig.tools ?? agent.tools` (role authoritative)
 *   - live-session: `agent.tools` only (frontmatter authoritative, role ignored)
 * so the same agent behaved differently depending on the runtime. A user
 * defining `tools:` or `disallowed_tools:` in a custom agent's frontmatter
 * saw it honored on one path and ignored on the other.
 *
 * Unified semantics (stable across both paths):
 *   - **allowlist precedence is source-aware**:
 *     - `source === "builtin"` → role-config authoritative (security: a
 *       builtin explorer MUST stay read-only even if its frontmatter is
 *       loose). Frontmatter is the fallback when the role has no allowlist.
 *     - `source !== "builtin"` (user / project) → frontmatter `tools:`
 *       authoritative (user intent). Role-config is the fallback.
 *   - **denylist is additive**: `roleConfig.excludeTools` and
 *     `agent.disallowedTools` are MERGED (dedup, order-insensitive). It is
 *     always safe to forbid more, and merging means a security exclude
 *     from the role can never be weakened by a frontmatter omission.
 *
 * Returns `{ tools, excludeTools }` where each is `undefined` when no
 * restriction of that kind applies (so callers no-op cleanly).
 */
export interface ResolvedToolPolicy {
	/** Allowlist; undefined = no allowlist restriction (all built-ins allowed). */
	tools?: string[];
	/** Denylist (additive); undefined = no denylist. */
	excludeTools?: string[];
}

function uniqueToolMerge(...lists: Array<string[] | undefined>): string[] | undefined {
	const merged = [...new Set(lists.flatMap((list) => list ?? []))];
	return merged.length > 0 ? merged : undefined;
}

export function resolveToolPolicy(agent: AgentConfig, role?: string): ResolvedToolPolicy {
	const roleConfig = role ? getToolConfig(role) : {};
	// allowlist: source-aware precedence (see doc above).
	const explicitTools = agent.source === "builtin" ? (roleConfig.tools ?? agent.tools) : (agent.tools ?? roleConfig.tools);
	// L5: when the agent opts into `loadMode: "lean"` AND provides a
	// non-empty `defaultTools` list, merge that list into the resolved
	// allowlist. The merge is additive (union, dedup, order-preserving) so
	// the existing source-aware precedence is preserved and a lean agent
	// gets a focused-but-non-empty tool set. Signal flow:
	//   agent YAML frontmatter (loadMode, defaultTools)
	//     → parsed into AgentConfig
	//     → resolveToolPolicy(agent, role) here
	//     → policy.tools returned to buildPiWorkerArgs
	//     → `args.push("--tools", policy.tools.join(","))` in pi-args.ts
	//     → child pi process sees the merged allowlist
	const tools =
		agent.loadMode === "lean" && agent.defaultTools?.length ? uniqueToolMerge(explicitTools, agent.defaultTools) : explicitTools;
	// denylist: additive merge of role excludeTools + agent disallowedTools.
	const excludeTools = uniqueToolMerge(roleConfig.excludeTools, agent.disallowedTools);
	return { tools, excludeTools };
}

/**
 * Build agent session options including role-based tool restrictions.
 * @param agent - The agent configuration
 * @param role - The role name to use for tool restrictions (defaults to agent.name)
 */
/** @internal */
function buildAgentSessionOptions(
	agent: AgentConfig,
	role?: string,
): {
	tools?: string[];
	excludeTools?: string[];
} {
	const effectiveRole = role ?? agent.name;
	return getAgentSessionOptions(effectiveRole);
}

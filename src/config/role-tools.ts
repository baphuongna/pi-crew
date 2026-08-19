/**
 * Role-based tool configurations for pi-crew agents.
 * Uses the excludeTools option from pi v0.77.0.
 */

import { permissionForRole } from "../runtime/role-permission.ts";

export interface RoleToolConfig {
	/** Explicit list of tools to use (if undefined, use all default tools) */
	tools?: string[];
	/** Tools to exclude from the default set */
	excludeTools?: string[];
	/** Phase 1 scratchpad: opt-in the persistent Bun-free JS evaluator (execute tool)
	 * for this role. Only effective on WRITE roles — read-only roles are gated
	 * out by `isScratchpadEnabledForRole` (S-6, privilege-elevation guard). */
	scratchpad?: boolean;
}

export const ROLE_TOOL_CONFIGS: Record<string, RoleToolConfig> = {
	// Explorer - Read-only exploration; bash is included for git log/show
	// (decisions stream needs commit-history mining) but edit/write stay
	// excluded. State-mutation safety is enforced separately by
	// READ_ONLY_ROLES in role-permission.ts.
	explorer: {
		tools: ["read", "grep", "find", "ls", "glob", "bash", "ask"],
		excludeTools: ["edit", "write", "web"],
	},

	// Analyst - Read and analyze, limited execution
	analyst: {
		excludeTools: ["edit", "write", "ask_question"],
	},

	// Planner - Read-only planning; emits plans as TEXT (runner persists result).
	// F2/F3: strengthened to a read-only tool-set matching its READ_ONLY_ROLES
	// classification. Deliverables are emitted as RESULT TEXT (consumed by
	// adaptive-plan.ts / runner shared-output), NOT file writes — so the
	// plan-approval gate boundary (planner = read-only) is preserved. Moving
	// planner to WRITE_ROLES would fire the gate before planning, breaking the
	// default/implementation workflows.
	planner: {
		tools: ["read", "grep", "find", "ls", "glob", "ask"],
		excludeTools: ["edit", "write", "bash", "web", "ask_question"],
	},

	// Critic - Read-only plan/design critique (F2: was missing from the map,
	// so a custom critic agent had no tool-level read-only enforcement).
	critic: {
		tools: ["read", "grep", "find", "ls", "glob", "ask"],
		excludeTools: ["edit", "write", "bash", "web"],
	},

	// Executor - Full access (default). Phase 1 scratchpad-enabled (stateful
	// evaluator compounds intermediate results across execute calls).
	executor: {
		// No restrictions - full tool access
		scratchpad: true,
	},

	// Reviewer - Read and review, no write
	reviewer: {
		tools: ["read", "grep", "find", "ls", "glob", "bash", "ask"],
		excludeTools: ["edit", "write"],
	},

	// Writer - Documentation focused
	writer: {
		tools: ["read", "edit", "write", "ls", "ask"],
		excludeTools: ["bash", "web", "ask_question"],
	},

	// Security Reviewer - Strict restrictions
	// F1: key is hyphenated to match the runtime role string (agents/
	// security-reviewer.md → "security-reviewer"). The underscore form never
	// resolved at runtime (returned {}), silently dropping enforcement.
	"security-reviewer": {
		tools: ["read", "grep", "find", "ask"],
		excludeTools: ["edit", "write", "bash", "web", "ask_question"],
	},

	// Verifier - Runs tests (needs bash) but must NOT edit source (F4: moved
	// from READ_ONLY_ROLES to WRITE_ROLES — the read-only prompt gate forbids
	// the test-running redirects / cache writes its task requires, contradicting
	// agents/verifier.md). Tool-set keeps bash but excludes edit/write so source
	// integrity is preserved during verification. Mirrors cold-verifier behavior.
	verifier: {
		tools: ["read", "grep", "find", "ls", "bash", "scratchpad", "ask"],
		excludeTools: ["edit", "write", "web"],
		// Phase 1 scratchpad: multi-cell test/verify flows reuse parsed state.
		scratchpad: true,
	},

	// Test Engineer - Can write tests (F1: hyphenated key)
	"test-engineer": {
		tools: ["read", "edit", "write", "bash", "ls", "scratchpad", "ask"],
		excludeTools: ["web"],
		// Phase 1 scratchpad: build/run test suites with state across cells.
		scratchpad: true,
	},
};

/**
 * Get tool configuration for a specific role.
 */
export function getToolConfig(role: string): RoleToolConfig {
	// F1: normalize hyphen/underscore. Runtime role strings are hyphenated
	// (agents/security-reviewer.md → "security-reviewer") but map keys were
	// historically underscored, silently returning {} at runtime — the same
	// defect class as the v0.9.10 writer incident (opposite direction:
	// under-enforce instead of over-enforce). Accept both forms.
	const key = role.includes("_") ? role.replaceAll("_", "-") : role;
	return ROLE_TOOL_CONFIGS[key] ?? ROLE_TOOL_CONFIGS[role] ?? {};
}

/**
 * Check if a role has any tool restrictions.
 */
export function hasToolRestrictions(role: string): boolean {
	const config = getToolConfig(role);
	return config.tools !== undefined || config.excludeTools !== undefined;
}

/**
 * Get all restricted roles.
 */
export function getRestrictedRoles(): string[] {
	return Object.entries(ROLE_TOOL_CONFIGS)
		.filter(([, config]) => config.tools !== undefined || config.excludeTools !== undefined)
		.map(([role]) => role);
}

/** Agent frontmatter shape consumed by the scratchpad opt-in check. */
export interface ScratchpadAgentOption {
	scratchpad?: boolean;
}

/**
 * Phase 1: is the scratchpad (execute tool) enabled for this role/agent?
 *
 * Decision order (load-bearing — do not reorder):
 *  1. S-6 (SECURITY, privilege-elevation guard): read-only roles NEVER enable,
 *     regardless of any agent frontmatter opt-in. A `scratchpad: true` on a
 *     read-only role (e.g. security-reviewer, whose tool-set is read/grep/find
 *     with NO bash) would grant full-trust JS execution (fs/network/env/
 *     child_process) inside a role designed to have no execution — a real
 *     elevation. `permissionForRole` is default-deny (unknown → read_only), so
 *     typos/underscore/case-drift cannot bypass this.
 *  2. F6 (kill-switch): `agent.scratchpad === false` WINS over the role default,
 *     giving an emergency off-switch for an experimental full-trust feature.
 *  3. agent explicit opt-in (`scratchpad: true`) OR role default (`scratchpad:
 *     true` in ROLE_TOOL_CONFIGS).
 *
 * F10: `permissionForRole` and `getToolConfig` both expect HYPHENATED role
 * strings (runtime convention); a raw underscore role would default-deny
 * wrongly, so normalize FIRST.
 */
export function isScratchpadEnabledForRole(role: string, agent?: ScratchpadAgentOption): boolean {
	// F10: normalize underscore→hyphen before every downstream lookup.
	const normalized = role.includes("_") ? role.replaceAll("_", "-") : role;
	// S-6 (điều kiện tiên quyết): read-only gate trước mọi agent flag.
	if (permissionForRole(normalized) === "read_only") return false;
	// F6: explicit-false agent override (kill-switch) wins over role default.
	if (agent?.scratchpad === false) return false;
	// agent explicit opt-in OR role default.
	return agent?.scratchpad === true || getToolConfig(normalized).scratchpad === true;
}

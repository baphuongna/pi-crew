/**
 * Role-based tool configurations for pi-crew agents.
 * Uses the excludeTools option from pi v0.77.0.
 */

export interface RoleToolConfig {
	/** Explicit list of tools to use (if undefined, use all default tools) */
	tools?: string[];
	/** Tools to exclude from the default set */
	excludeTools?: string[];
}

export const ROLE_TOOL_CONFIGS: Record<string, RoleToolConfig> = {
	// Explorer - Read-only exploration; bash is included for git log/show
	// (decisions stream needs commit-history mining) but edit/write stay
	// excluded. State-mutation safety is enforced separately by
	// READ_ONLY_ROLES in role-permission.ts.
	explorer: {
		tools: ["read", "grep", "find", "ls", "glob", "bash"],
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
		tools: ["read", "grep", "find", "ls", "glob"],
		excludeTools: ["edit", "write", "bash", "web", "ask_question"],
	},

	// Critic - Read-only plan/design critique (F2: was missing from the map,
	// so a custom critic agent had no tool-level read-only enforcement).
	critic: {
		tools: ["read", "grep", "find", "ls", "glob"],
		excludeTools: ["edit", "write", "bash", "web"],
	},

	// Executor - Full access (default)
	executor: {
		// No restrictions - full tool access
	},

	// Reviewer - Read and review, no write
	reviewer: {
		tools: ["read", "grep", "find", "ls", "glob", "bash"],
		excludeTools: ["edit", "write"],
	},

	// Writer - Documentation focused
	writer: {
		tools: ["read", "edit", "write", "ls"],
		excludeTools: ["bash", "web", "ask_question"],
	},

	// Security Reviewer - Strict restrictions
	// F1: key is hyphenated to match the runtime role string (agents/
	// security-reviewer.md → "security-reviewer"). The underscore form never
	// resolved at runtime (returned {}), silently dropping enforcement.
	"security-reviewer": {
		tools: ["read", "grep", "find"],
		excludeTools: ["edit", "write", "bash", "web", "ask_question"],
	},

	// Verifier - Runs tests (needs bash) but must NOT edit source (F4: moved
	// from READ_ONLY_ROLES to WRITE_ROLES — the read-only prompt gate forbids
	// the test-running redirects / cache writes its task requires, contradicting
	// agents/verifier.md). Tool-set keeps bash but excludes edit/write so source
	// integrity is preserved during verification. Mirrors cold-verifier behavior.
	verifier: {
		tools: ["read", "grep", "find", "ls", "bash"],
		excludeTools: ["edit", "write", "web"],
	},

	// Test Engineer - Can write tests (F1: hyphenated key)
	"test-engineer": {
		tools: ["read", "edit", "write", "bash", "ls"],
		excludeTools: ["web"],
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

export type RolePermissionMode = "read_only" | "workspace_write" | "danger_full_access" | "explicit_confirm";

// (FIND-12 R1 review: the AgentPermissionOptions opt-in was dropped — no caller
// passed `options` and AgentConfig has no `permissions` field, so it was dead
// code. Custom write-capable roles must instead be added to WRITE_ROLES below.)

// Read-only roles: cannot mutate files/source. `verifier` is NOT here — it runs
// tests (bash + cache writes) so it is a WRITE role (F4). `planner` stays
// read-only to preserve the plan-approval gate boundary (F3).
const READ_ONLY_ROLES = new Set(["explorer", "reviewer", "security-reviewer", "analyst", "critic", "planner"]);
// Write-capable roles: can mutate files/source within the workspace.
// FIND-12 (R1 review): this is an EXPLICIT allowlist — every shipped write-capable
// role must be listed here, otherwise default-deny demotes it to read-only.
// `agent` is the default direct-agent role (run.ts); `cold-verifier` runs bash/
// cache writes; `chain-executor` is the chain-workflow executor variant;
// `worker` is the autonomous goal-loop + dynamic-workflow executor role
// (goal-loop-runner.ts, run.ts dynamic workflow synthesis).
const WRITE_ROLES = new Set([
	"executor",
	"test-engineer",
	"writer",
	"verifier",
	"agent",
	"cold-verifier",
	"chain-executor",
	"worker",
]);
export interface PermissionCheckResult {
	allowed: boolean;
	mode: RolePermissionMode;
	reason?: string;
}

/**
 * Resolve the permission mode for a given role.
 *
 * FIND-12 (2026-07-20): **default-deny** — unknown/unrecognized roles now
 * receive `"read_only"` instead of the previous permissive `"workspace_write"`.
 * This prevents privilege escalation via typo'd or custom agent names that
 * accidentally inherit write capabilities. Write-capable roles are an EXPLICIT
 * allowlist (`WRITE_ROLES`); to add a custom write-capable role, add it there.
 * (R1 review: a per-agent-config `permissions.workspaceWrite` opt-in was
 * considered but dropped — it was unreachable from all 8 call sites.)
 *
 * @param role the role name (case-sensitive, must match exactly)
 */
export function permissionForRole(role: string): RolePermissionMode {
	if (READ_ONLY_ROLES.has(role)) return "read_only";
	if (WRITE_ROLES.has(role)) return "workspace_write";
	// FIND-12: default-deny for unknown/unrecognized roles.
	return "read_only";
}

export function currentCrewRole(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.PI_CREW_ROLE?.trim() || env.PI_TEAMS_ROLE?.trim() || undefined;
}

export function checkSubagentSpawnPermission(role: string | undefined): PermissionCheckResult {
	if (!role) return { allowed: true, mode: "workspace_write" };
	const mode = permissionForRole(role);
	if (mode === "read_only")
		return {
			allowed: false,
			mode,
			reason: `Role '${role}' is read-only and cannot spawn additional subagents.`,
		};
	return { allowed: true, mode };
}

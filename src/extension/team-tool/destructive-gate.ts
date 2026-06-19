/**
 * Permission gate logic for destructive team actions (delete/forget/prune/cleanup).
 *
 * Extracted from register.ts `pi.on("tool_call")` handler into a pure function
 * so the gate logic is unit-testable in isolation (the handler itself is hard
 * to test because it's an async event listener on the Pi extension API).
 *
 * Returns `undefined` when the action is ALLOWED, or a block `reason` string
 * when it should be blocked. The handler wraps this and emits the `{block, reason}`
 * shape Pi expects.
 *
 * Rules (in order):
 *  1. Non-team / non-destructive actions → allowed (caller pre-filters, but safe).
 *  2. `cleanup` with `dryRun=true` → ALWAYS allowed (a preview writes nothing,
 *     so gating it would block users from previewing what cleanup would do —
 *     this was a UX bug: team action=cleanup dryRun=true returned "requires
 *     confirm=true" even though it changed no files).
 *  3. `confirm=true` on the input → allowed (explicit user intent).
 *  4. `delete` with `force=true` → allowed (force bypasses reference checks).
 *  5. Otherwise → blocked with a reason telling the user what to pass.
 */

export const DESTRUCTIVE_TEAM_ACTIONS = new Set(["delete", "forget", "prune", "cleanup", "workflow-create", "workflow-delete"]);

export interface TeamToolInputLike {
	action?: unknown;
	confirm?: unknown;
	force?: unknown;
	dryRun?: unknown;
}

/**
 * Decide whether a destructive team action should be blocked.
 * @returns block reason string, or `undefined` to allow.
 */
export function shouldBlockDestructiveTeamAction(
	action: string | undefined,
	input: TeamToolInputLike,
): string | undefined {
	if (!action || !DESTRUCTIVE_TEAM_ACTIONS.has(action)) return undefined;
	// dryRun cleanup is a PREVIEW (no writes) — never needs confirm.
	if (action === "cleanup" && input.dryRun === true) return undefined;
	if (input.confirm === true) return undefined;
	const forceBypassesReferenceChecks = action === "delete" && input.force === true;
	if (forceBypassesReferenceChecks) return undefined;
	return `Destructive action '${action}' requires confirm=true${action === "delete" ? " (or force=true to bypass reference checks)" : ""}.`;
}

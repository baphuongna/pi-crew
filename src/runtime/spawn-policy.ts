/**
 * Spawn policy for delegate-driven grandchild admission (ADR-5, WP-5 step 3).
 *
 * Pure evaluation — no I/O, no state mutation. The root-side delegate handler
 * (broker `delegate` method, WP-5 step 5) gathers the inputs and calls
 * `evaluateDelegateAdmission`; on denial it returns the fail-fast message to
 * the worker and logs `delegate.rejected` to events.jsonl (never silent).
 *
 * Gate dimensions (each with a distinct machine-readable reason + fail-fast
 * message; evaluated in this order — cheapest/most-global first):
 *   1. trust-denied       — untrusted escalation context (manual-only trust
 *                           gate; the handler resolves trust, policy enforces)
 *   2. role-denied        — the REQUESTED grandchild role is not one of the
 *                           delegate-tool's allowed roles (the parent role is
 *                           NO LONGER gated — D8: every role may delegate;
 *                           the spawn-side checkCrewDepth cap is the boundary)
 *   3. depth-exceeded     — child depth (parent.depth + 1) exceeds the
 *                           resolved maxDepth (default 4). Depth comes from
 *                           the parent task RECORD, never worker env
 *                           (design §7 rev-2 P0-2)
 *   4. slots-exhausted    — nested-slot budget exhausted ("N/M in flight");
 *                           fail-fast, never queue
 *   5. budget-insufficient— requested budgetTokens exceed the parent task's
 *                           remaining allocation (tokensGranted - tokensSpent)
 *   6. model-invalid      — requested model is not in the resolved model
 *                           catalog (the unvalidated provider/model
 *                           pass-through — model-fallback.ts:282, the
 *                           429-cascade root — must not be reachable here)
 *   7. timeout-invalid    — timeoutSec outside 1..MAX (default 900)
 *   8. workspace-conflict — write-capable grandchild narrowing cwd overlap
 */

import { modelRefToString } from "./model/model-fallback.ts";
import type { NestedSlotSnapshot } from "./scheduling/nested-slots.ts";

/** Delegate tool's allowed grandchild roles (design §7 surface). */
export const DELEGATE_ALLOWED_ROLES = ["explorer", "analyst", "executor"] as const;
export type DelegateRole = (typeof DELEGATE_ALLOWED_ROLES)[number];

/**
 * Roles permitted to CALL delegate (executor-class). Read-only/review roles
 * (explorer, analyst, planner, critic, reviewer, verifier, writer,
 * security-reviewer) are denied — delegation is a spawn privilege.
 */
export const EXECUTOR_CLASS_ROLES = ["executor", "test-engineer"] as const;

export const DEFAULT_DELEGATE_TIMEOUT_SEC = 900;
export const MAX_DELEGATE_TIMEOUT_SEC = 86_400;

export type SpawnPolicyDenyReason =
	| "role-denied"
	| "trust-denied"
	| "depth-exceeded"
	| "slots-exhausted"
	| "budget-insufficient"
	| "model-invalid"
	| "timeout-invalid"
	| "workspace-conflict";

export interface DelegateAdmissionInput {
	/** Resolved max depth (nesting.maxDepth default 4; env clamp mirrors PI_CREW_MAX_DEPTH 1..10). */
	maxDepth: number;
	/** Parent task record fields the policy is allowed to trust. */
	parentTask: {
		taskId: string;
		/** Role for workspace-capability evaluation (policy no longer gates the
		 *  parent role — D8 opens delegation to every role). */
		role?: string;
		/** Absent on pre-v2 records — treated as depth 1 (a worker). */
		depth?: number;
		allocation?: { tokensGranted?: number; tokensSpent?: number };
	};
	/** Untrusted escalation context — the delegate handler resolves trust. */
	untrusted?: boolean;
	/** Nested-slot budget snapshot (used/max). */
	slots: NestedSlotSnapshot;
	/** Requested grandchild parameters (all optional in the tool surface). */
	requested?: {
		role?: string;
		model?: string;
		budgetTokens?: number;
		timeoutSec?: number;
	};
	/**
	 * Resolved model catalog as canonical `provider/id` strings. When omitted
	 * (catalog unavailable at the call-site) model validation is SKIPPED —
	 * flag this in review; the broker handler must always supply it.
	 */
	modelCatalog?: readonly string[];
	/** ADR-5 §9 workspace interaction: when the requested grandchild role is
	 * write-capable (executor-class), an overlapping in-flight executor can
	 * only be tolerated when serialization is established. `serializeEnabled`
	 * mirrors config `limits.serializeOnPathOverlap`; `overlappingInFlightExecutors`
	 * counts OTHER running executor-class tasks sharing the parent task's cwd. */
	workspace?: {
		serializeEnabled?: boolean;
		overlappingInFlightExecutors?: number;
	};
}

export interface SpawnPolicyDecision {
	allowed: boolean;
	/** Machine-readable deny reason (undefined when allowed). */
	reason?: SpawnPolicyDenyReason;
	/** Fail-fast human message (undefined when allowed). */
	message?: string;
	/** The grandchild's depth (parent depth + 1) on success. */
	childDepth?: number;
	/** Effective timeout in seconds (requested or default 900) on success. */
	timeoutSec?: number;
	/** Effective model (normalized) on success. */
	model?: string;
}

export function isExecutorClassRole(role: string): boolean {
	return (EXECUTOR_CLASS_ROLES as readonly string[]).includes(role);
}

function deny(reason: SpawnPolicyDenyReason, message: string): SpawnPolicyDecision {
	return { allowed: false, reason, message };
}

export function evaluateDelegateAdmission(input: DelegateAdmissionInput): SpawnPolicyDecision {
	const { maxDepth, parentTask, requested } = input;
	const parentDepth = parentTask.depth ?? 1; // pre-v2 records: workers are depth 1
	const childDepth = parentDepth + 1;

	// 1. Role gate — the REQUESTED grandchild role must be in the tool's allowed
	// set (the PARENT role is no longer gated — D8: every role may delegate;
	// the spawn-side checkCrewDepth cap + slot budget below are the boundary).
	const requestedRole = requested?.role;
	if (requestedRole !== undefined && !(DELEGATE_ALLOWED_ROLES as readonly string[]).includes(requestedRole)) {
		return deny(
			"role-denied",
			`delegate rejected: requested grandchild role '${requestedRole}' is not one of ${DELEGATE_ALLOWED_ROLES.join("/")}`,
		);
	}

	// 2. Trust gate — untrusted escalation context never spawns.
	if (input.untrusted) {
		return deny("trust-denied", "delegate rejected: untrusted escalation context (trust gate is manual-only)");
	}

	// 3. Depth gate — computed from the parent RECORD (never worker env).
	if (childDepth > maxDepth) {
		return deny(
			"depth-exceeded",
			`delegate rejected: spawn depth ${childDepth} exceeds maxDepth ${maxDepth} (parent task '${parentTask.taskId}' is at depth ${parentDepth})`,
		);
	}

	// 4. Nested-slot budget — fail-fast, never queue.
	if (input.slots.used >= input.slots.max) {
		return deny(
			"slots-exhausted",
			`delegate rejected: nested spawn budget exhausted; ${input.slots.used}/${input.slots.max} in flight`,
		);
	}

	// 5. Parent allocation sufficiency — reserve up-front or reject.
	if (requested?.budgetTokens !== undefined) {
		const granted = parentTask.allocation?.tokensGranted ?? 0;
		const spent = parentTask.allocation?.tokensSpent ?? 0;
		const remaining = granted - spent;
		if (requested.budgetTokens > remaining) {
			return deny(
				"budget-insufficient",
				`delegate rejected: requested budget ${requested.budgetTokens} tokens exceeds parent task '${parentTask.taskId}' remaining allocation ${remaining} (${granted} granted - ${spent} spent)`,
			);
		}
	}

	// 6. Model validation against the resolved catalog.
	const normalizedModel = requested?.model !== undefined ? modelRefToString(requested.model) : undefined;
	if (normalizedModel !== undefined && input.modelCatalog !== undefined) {
		if (!input.modelCatalog.includes(normalizedModel)) {
			return deny("model-invalid", `delegate rejected: model '${requested?.model}' is not in the resolved model catalog`);
		}
	}

	// 7. Timeout validation (mandatory default 900).
	const timeoutSec = requested?.timeoutSec ?? DEFAULT_DELEGATE_TIMEOUT_SEC;
	if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_DELEGATE_TIMEOUT_SEC) {
		return deny(
			"timeout-invalid",
			`delegate rejected: timeoutSec ${String(requested?.timeoutSec)} is outside 1..${MAX_DELEGATE_TIMEOUT_SEC} (default ${DEFAULT_DELEGATE_TIMEOUT_SEC})`,
		);
	}

	// 8. Workspace interaction (ADR-5 §9): a write-capable grandchild sharing
	// the parent's cwd with ANOTHER in-flight executor is only admitted when
	// serialization is established (limits.serializeOnPathOverlap) — otherwise
	// reject; read-only grandchild roles (explorer/analyst) never conflict.
	const requestedIsWriteCapable = requestedRole !== undefined && (EXECUTOR_CLASS_ROLES as readonly string[]).includes(requestedRole);
	if (requestedIsWriteCapable && !input.workspace?.serializeEnabled && (input.workspace?.overlappingInFlightExecutors ?? 0) > 0) {
		return deny(
			"workspace-conflict",
			`delegate rejected: parent task '${parentTask.taskId}' cwd overlaps ${input.workspace?.overlappingInFlightExecutors} in-flight executor(s) and limits.serializeOnPathOverlap is off — use a read-only grandchild role (explorer/analyst) or enable serialization`,
		);
	}

	return { allowed: true, childDepth, timeoutSec, ...(normalizedModel !== undefined ? { model: normalizedModel } : {}) };
}

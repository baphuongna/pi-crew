export const TEAM_RUN_STATUSES = ["queued", "planning", "running", "blocked", "completed", "failed", "cancelled"] as const;
export type TeamRunStatus = (typeof TEAM_RUN_STATUSES)[number];

export const TEAM_TASK_STATUSES = [
	"queued",
	"running",
	"waiting",
	"completed",
	"failed",
	"cancelled",
	"skipped",
	"needs_attention",
] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

export const TEAM_TERMINAL_RUN_STATUSES: ReadonlySet<TeamRunStatus> = new Set(["blocked", "completed", "failed", "cancelled"]);
export const TEAM_TERMINAL_TASK_STATUSES: ReadonlySet<TeamTaskStatus> = new Set([
	"completed",
	"failed",
	"cancelled",
	"skipped",
	"needs_attention",
]);

export const TEAM_RUN_STATUS_TRANSITIONS: Readonly<Record<TeamRunStatus, readonly TeamRunStatus[]>> = {
	queued: ["planning", "running", "cancelled", "failed"],
	planning: ["running", "blocked", "cancelled", "failed"],
	running: ["blocked", "completed", "failed", "cancelled"],
	blocked: ["running", "cancelled", "failed"],
	completed: ["running", "cancelled"],
	failed: ["running", "cancelled"],
	cancelled: ["running"],
};

export const TEAM_TASK_STATUS_TRANSITIONS: Readonly<Record<TeamTaskStatus, readonly TeamTaskStatus[]>> = {
	queued: ["running", "cancelled", "skipped", "failed"],
	running: ["completed", "failed", "cancelled", "queued", "waiting"],
	waiting: ["running", "queued", "completed", "failed", "cancelled"],
	completed: ["queued"],
	failed: ["queued", "cancelled"],
	cancelled: ["queued"],
	skipped: ["queued", "cancelled"],
	needs_attention: ["queued", "running"],
};

/** @internal */
export const TEAM_EVENT_TYPES = [
	"run.created",
	"run.queued",
	"run.planning",
	"run.running",
	"run.blocked",
	"run.completed",
	"run.failed",
	"run.cancelled",
	"run.terminal_preserved",
	"task.created",
	"task.started",
	"task.progress",
	// T4/R6 (ADR-6 + erratum): spec-system events
	"spec.frozen",
	"spec.freeze_failed",
	"spec.strict_platform_warning",
	"spec.check_failed",
	"task.spec_gate",
	"hook.pre_step_started",
	"hook.pre_step_completed",
	"hook.pre_step_failed",
	"hook.pre_step_skipped",
	"hook.pre_step_optional_failed",
	"task.blocked",
	"task.green",
	"task.red",
	"task.completed",
	"task.failed",
	"task.cancelled",
	"task.skipped",
	"task.needs_attention",
	"review.approved",
	"review.rejected",
	"policy.action",
	"policy.escalated",
	"recovery.attempted",
	"recovery.escalated",
	"branch.stale",
	"mailbox.timeout",
	"worktree.cleanup",
	"worktree.dirty",
	"async.spawned",
	"async.started",
	"async.signal",
	"async.completed",
	"async.failed",
	"async.stale",
	"task.waiting",
	"task.resumed",
	"task.retried",
	// WP-2/R2 waiting-producer (ADR-0 2026-08-17-waiting-producer-ask item 10):
	// `ask` tool lifecycle — requested on park acceptance, answered on delivery
	// (mailbox or requeue+inject), timedout on deadline expiry (both the
	// alive-in-tool and dead-requeue outcomes).
	"ask.requested",
	"ask.answered",
	"ask.timedout",
	"supervisor.contact",
	// T2/R4 first-class Plan object (ADR-4 docs/decisions/2026-08-17-plan-object.md §9):
	// plan-store revision/approval mutations. `plan.approved` and `plan.cancelled`
	// formalize emitters that api/plan-approval.ts:66-67,144-145 already wrote
	// unregistered (pre-existing gap closed by the ADR). The scheduler's
	// items[].taskIds linkage writes append NO event (task dispatch logs its own).
	"plan.created",
	"plan.revised",
	"plan.approved",
	"plan.rejected",
	"plan.cancelled",
	"plan.item.dropped",
	// plan-approval.ts ensurePlanApprovalRequested emits this when the gate
	// lights up — pre-existing unregistered emitter formalized with the rest.
	"plan.approval_required",
	// T3/R5 (ADR-5): governed-nesting delegate lifecycle. Emitted by the
	// broker's delegate.request handler (crew-broker.ts) — every rejection
	// leaves a delegate.rejected trace (never silent), usage roll-up lands as
	// delegate.rolled_up on the parent task record.
	"delegate.requested",
	"delegate.admitted",
	"delegate.rejected",
	"delegate.completed",
	"delegate.timed_out",
	"delegate.rolled_up",
	// Budget tracking events
	"budget.initialized",
	"budget.warning",
	"budget.exhausted",
	// Phase tracking events
	"phase.started",
	"phase.completed",
	"phase.skipped",
	"phase.failed",
	// Goal loop events (P0/P1) — autonomous goal-loop coordinator.
	"goal.loop_start",
	"goal.turn_start",
	"goal.turn_evaluated",
	"goal.budget_warning",
	"goal.loop_end",
	"goal.loop_error",
	"goal.feedback_steered",
	"goal.state_changed",
	// Dynamic workflow events (P2) — script-driven orchestration.
	"dwf.started",
	"dwf.phase_started",
	"dwf.phase_completed",
	"dwf.completed",
	"dwf.failed",
	"dwf.trust_denied", // F-01: project .dwf.ts denied without PI_CREW_TRUST_PROJECT_DWF
	"dwf.log",
	// RLM/scratchpad adoption metrics (plan I5)
	"scratchpad.cell",
	"scratchpad.restored",
	// ─── 2026-09-17 drift closure ─────────────────────────────────────────────
	// The remaining types below were ALREADY EMITTED in production but never
	// registered — they were silent to consumers of TEAM_EVENT_TYPES. The
	// check:event-types gate also had a detection bug (conditional `type:`
	// expressions like `type: error ? "task.failed" : ...` were invisible),
	// which is why this drift accumulated unnoticed. Registered here grouped
	// by prefix; verified against literal emit sites (see
	// scripts/check-event-types-registry.mjs and the 2026-09-17 review
	// verification, §6.3). The gate now runs with --enforce in CI.
	// Adaptive planning (goal-workflow/adaptive-plan.ts)
	"adaptive.plan_injected",
	"adaptive.plan_missing",
	"adaptive.plan_repaired",
	"adaptive.plan_repair_failed",
	// Agent control / group-join / nudge
	"agent.control.queued",
	"agent.group_join.acknowledged",
	"agent.group_join.ack_timeout",
	"agent.group_join.delivery_reused",
	"agent.group_join.partial",
	"agent.group_join.completed",
	"agent.nudged",
	// Background-runner lifecycle forensics (async sidecar/runner death, signals)
	"async.died",
	"async.exit",
	"async.interrupt_detected",
	"async.kill_requested",
	"async.sigterm_received_graceful_shutdown",
	"async.watchdog_fired",
	"background.unregister_worker_failed",
	// Chain runner
	"chain.step_completed",
	// Config
	"config.warning",
	// Stale-run reconciliation (stale-reconciler.ts)
	"crew.run.reconciled_stale",
	"crew.run.orphan_cancelled",
	"crew.run.orphan_skip",
	"crew.run.recovery_blocked",
	"crew.run.recovery_declined",
	"crew.run.recovery_skipped",
	"crew.run.resumed",
	"crew.task.heartbeat_dead",
	"crew.task.retry_attempt",
	// Dynamic workflow resume
	"dwf.resumed",
	// Foreground interrupt
	"foreground.interrupt_requested",
	// Goal loop (P0/P1) additional outcomes
	"goal.resumed",
	"goal.resume_spawn_failed",
	"goal.stuck",
	"goal.turn_terminal_status",
	"goal.verification_compromised",
	"goal.workspace_lock_failed",
	// Hook execution trace
	"hook.executed",
	// Limits
	"limits.unbounded",
	// Mailbox delivery (ack/replay/timeout observable surface)
	"mailbox.acknowledged",
	"mailbox.message",
	"mailbox.replayed",
	// Recovery
	"recovery.rerun_task",
	// Run-level budget/effectiveness/export/lifecycle bookkeeping
	"run.started",
	"run.budget_warning",
	"run.budget_abort",
	"run.deliverable_warning",
	"run.effectiveness",
	"run.exported",
	"run.forget_requested",
	"run.goal_achievement",
	"run.resume_requested",
	// Runtime/surface resolution
	"runtime.resolved",
	"surface.degraded",
	"surface.requeued",
	// Task scheduling/steer/budget/fairness bookkeeping
	"task.attention",
	"task.claimed",
	"task.claim_released",
	"task.coalesced",
	"task.coalesced_dispatch_start",
	"task.coalesced_dispatch_end",
	"task.parallel_start",
	"task.status_transitioned",
	"task.reconciled_from_disk",
	"task.checkpoint_recovered",
	"task.retry_attempt",
	"task.budget_fair_share",
	"task.model_dropped",
	"task.output_validation",
	"task.steer_queued",
	"task.steer_dropped",
	"task.surface_lost",
	// Worker lifecycle (surface runtime / broker-side)
	"worker.heartbeat",
	"worker.cancelled",
	"worker.kill_stale",
	"worker.message",
	// Workflow phase advance (note: supersedes the legacy `phase.*` names
	// above, which are kept registered for backward compatibility)
	"workflow.phase_completed",
	"workflow.phase_failed",
	"workflow.phase_guard_blocked",
	"workflow.preconditions",
] as const;
export type TeamEventType = (typeof TEAM_EVENT_TYPES)[number];

export const TEAM_WAKEABLE_EVENT_TYPES: ReadonlySet<TeamEventType> = new Set([
	"run.blocked",
	"run.completed",
	"run.failed",
	"run.cancelled",
	"task.completed",
	"task.failed",
	"task.cancelled",
	"task.skipped",
	"task.needs_attention",
	"async.completed",
	"async.failed",
	"async.stale",
]);

export function isTeamRunStatus(value: unknown): value is TeamRunStatus {
	return typeof value === "string" && TEAM_RUN_STATUSES.includes(value as TeamRunStatus);
}

export function isTeamTaskStatus(value: unknown): value is TeamTaskStatus {
	return typeof value === "string" && TEAM_TASK_STATUSES.includes(value as TeamTaskStatus);
}

export function isTerminalRunStatus(status: TeamRunStatus): boolean {
	return TEAM_TERMINAL_RUN_STATUSES.has(status);
}

export function isTerminalTaskStatus(status: TeamTaskStatus): boolean {
	return TEAM_TERMINAL_TASK_STATUSES.has(status);
}

export function canTransitionRunStatus(from: TeamRunStatus, to: TeamRunStatus): boolean {
	return from === to || (TEAM_RUN_STATUS_TRANSITIONS[from]?.includes(to) ?? false);
}

export function canTransitionTaskStatus(from: TeamTaskStatus, to: TeamTaskStatus): boolean {
	return from === to || (TEAM_TASK_STATUS_TRANSITIONS[from]?.includes(to) ?? false);
}

export function isWakeableTeamEventType(type: TeamEventType): boolean {
	return TEAM_WAKEABLE_EVENT_TYPES.has(type);
}

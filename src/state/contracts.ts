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

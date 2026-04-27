export const TEAM_RUN_STATUSES = ["queued", "planning", "running", "blocked", "completed", "failed", "cancelled"] as const;
export type TeamRunStatus = typeof TEAM_RUN_STATUSES[number];

export const TEAM_TASK_STATUSES = ["queued", "running", "completed", "failed", "cancelled", "skipped"] as const;
export type TeamTaskStatus = typeof TEAM_TASK_STATUSES[number];

export const TEAM_TERMINAL_RUN_STATUSES: ReadonlySet<TeamRunStatus> = new Set(["blocked", "completed", "failed", "cancelled"]);
export const TEAM_TERMINAL_TASK_STATUSES: ReadonlySet<TeamTaskStatus> = new Set(["completed", "failed", "cancelled", "skipped"]);

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
	running: ["completed", "failed", "cancelled", "queued"],
	completed: ["queued"],
	failed: ["queued", "cancelled"],
	cancelled: ["queued"],
	skipped: ["queued", "cancelled"],
};

export const TEAM_EVENT_TYPES = [
	"run.created",
	"run.queued",
	"run.planning",
	"run.running",
	"run.blocked",
	"run.completed",
	"run.failed",
	"run.cancelled",
	"task.started",
	"task.progress",
	"task.blocked",
	"task.green",
	"task.red",
	"task.completed",
	"task.failed",
	"review.approved",
	"review.rejected",
	"policy.action",
	"policy.escalated",
	"mailbox.timeout",
	"worktree.cleanup",
	"worktree.dirty",
	"async.spawned",
	"async.started",
	"async.completed",
	"async.failed",
	"async.stale",
] as const;
export type TeamEventType = typeof TEAM_EVENT_TYPES[number];

export const TEAM_WAKEABLE_EVENT_TYPES: ReadonlySet<TeamEventType> = new Set([
	"run.blocked",
	"run.completed",
	"run.failed",
	"run.cancelled",
	"task.completed",
	"task.failed",
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

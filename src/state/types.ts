import type { TeamRunStatus, TeamTaskStatus } from "./contracts.ts";
import type { TaskClaimState } from "./task-claims.ts";
import type { WorkerHeartbeatState } from "../runtime/worker-heartbeat.ts";
import type { CrewAgentProgress } from "../runtime/crew-agent-runtime.ts";
import type { RolloutEntry, CoherenceMark } from "./decision-ledger.ts";
export type { RolloutEntry, CoherenceMark };
export type { CrewAgentProgress };

export type { TeamRunStatus, TeamTaskStatus } from "./contracts.ts";

export interface ArtifactDescriptor {
	kind: "plan" | "prompt" | "result" | "summary" | "log" | "diff" | "patch" | "progress" | "notepad" | "metadata";
	path: string;
	createdAt: string;
	producer: string;
	sizeBytes?: number;
	contentHash?: string;
	retention: "run" | "project" | "temporary";
	expiresAt?: string;
}

export type TaskScope = "workspace" | "module" | "single_file" | "custom";
export type GreenLevel = "none" | "targeted" | "package" | "workspace" | "merge_ready";

export interface VerificationCommandResult {
	cmd: string;
	status: "passed" | "failed" | "not_run";
	exitCode?: number | null;
	durationMs?: number;
	outputArtifact?: ArtifactDescriptor;
}

export interface VerificationContract {
	requiredGreenLevel: GreenLevel;
	commands: string[];
	allowManualEvidence: boolean;
}

export interface VerificationEvidence {
	requiredGreenLevel: GreenLevel;
	observedGreenLevel: GreenLevel;
	satisfied: boolean;
	commands: VerificationCommandResult[];
	notes?: string;
}

export interface TaskOutputSchema {
	/** Output format expected from the worker */
	format: "json" | "markdown" | "text";
	/** JTD or JSON Schema for validating JSON output (only when format="json") */
	schema?: Record<string, unknown>;
	/** Human-readable description of expected output */
	description?: string;
	/** Example of valid output (for prompt guidance) */
	example?: string;
}

export interface TaskPacket {
	objective: string;
	scope: TaskScope;
	scopePath?: string;
	repo: string;
	worktree?: string;
	branchPolicy: string;
	acceptanceTests: string[];
	commitPolicy: string;
	reportingContract: string;
	escalationPolicy: string;
	constraints: string[];
	expectedArtifacts: string[];
	verification: VerificationContract;
	outputSchema?: TaskOutputSchema;
}

export type PolicyDecisionAction = "retry" | "reassign" | "escalate" | "block" | "notify" | "cleanup" | "closeout" | "fail";
export type PolicyDecisionReason = "task_failed" | "worker_stale" | "green_unsatisfied" | "limit_exceeded" | "run_complete" | "mailbox_timeout" | "review_rejected" | "branch_stale" | "scope_mismatch" | "ineffective_worker";

export interface PolicyDecision {
	action: PolicyDecisionAction;
	reason: PolicyDecisionReason;
	message: string;
	taskId?: string;
	createdAt: string;
}

export interface TaskGraphNode {
	taskId: string;
	parentId?: string;
	children: string[];
	dependencies: string[];
	queue: "ready" | "blocked" | "running" | "done";
	sessionForkFrom?: string;
}

export interface AsyncRunState {
	pid?: number;
	logPath: string;
	spawnedAt: string;
}

export interface RuntimeResolutionState {
	kind: "scaffold" | "child-process" | "live-session";
	requestedMode: "auto" | "scaffold" | "child-process" | "live-session";
	safety: "trusted" | "explicit_dry_run" | "blocked";
	available: boolean;
	fallback?: "scaffold" | "child-process" | "live-session";
	reason?: string;
	resolvedAt: string;
}

export interface WorkerExitStatus {
	exitCode: number | null;
	cancelled: boolean;
	timedOut: boolean;
	killed: boolean;
	signal?: string;
	cleanupErrors: string[];
	finalDrainMs: number;
}

export interface OperationTerminalEvidence {
	operation: "worker" | "tool" | "model";
	status: "cancelled" | "failed" | "completed";
	startedAt?: string;
	finishedAt: string;
	attemptId?: string;
	reason?: {
		code: string;
		message: string;
	};
	exitStatus?: WorkerExitStatus;
}

export interface PlanApprovalState {
	required: boolean;
	status: "pending" | "approved" | "cancelled";
	requestedAt: string;
	updatedAt: string;
	approvedAt?: string;
	cancelledAt?: string;
	planTaskId?: string;
	planArtifactPath?: string;
}

export type CrewActivityState = "active" | "active_long_running" | "needs_attention" | "stale";
export type CrewAttentionReason = "idle" | "tool_failures" | "completion_guard" | "heartbeat_stale" | "plan_approval_pending";

export interface CrewAttentionEventData {
	activityState: CrewActivityState;
	reason: CrewAttentionReason;
	elapsedMs?: number;
	taskId?: string;
	agentName?: string;
	suggestedAction?: string;
	observedTools?: string[];
}

export interface TeamRunManifest {
	schemaVersion: 1;
	runId: string;
	/** pi session ID aligned with run ID for cross-referencing (e.g., "crew-team20260528") */
	sessionId?: string;
	team: string;
	workflow?: string;
	goal: string;
	status: TeamRunStatus;
	workspaceMode: "single" | "worktree";
	createdAt: string;
	updatedAt: string;
	cwd: string;
	stateRoot: string;
	artifactsRoot: string;
	tasksPath: string;
	eventsPath: string;
	artifacts: ArtifactDescriptor[];
	async?: AsyncRunState;
	planApproval?: PlanApprovalState;
	/** Pi session that created the run, when available. Used to prevent cross-session destructive actions. */
	ownerSessionId?: string;
	/** pi-crew skill override selected when the run was created. false disables injected skill instructions. */
	skillOverride?: string[] | false;
	/** Resolved runtime/safety mode used for execution. Optional for backward compatibility with older manifests. */
	runtimeResolution?: RuntimeResolutionState;
	/** Effective run config snapshot used by async background workers. Optional for backward compatibility. */
	runConfig?: unknown;
	/** Background dispatch discriminator. Default "team-run" runs executeTeamRun; "goal-loop" / "dynamic-workflow" dispatch to their respective runners. Absent = "team-run" for backward compatibility. */
	runKind?: "team-run" | "goal-loop" | "dynamic-workflow";
	summary?: string;
	policyDecisions?: PolicyDecision[];
}

export interface UsageState {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	turns?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Goal loop types (P0/P1 — autonomous goal loop, Claude-Code-style /goal).
// Spec: research-findings/goal-workflow/00-SPEC.md §2.3; plan 07-PLAN.md v3 §0b G2 + §0c.
// ───────────────────────────────────────────────────────────────────────────

/** Outer-state lifecycle of a goal loop. Inner per-turn state lives on each turn's TeamRunManifest. */
export type GoalLoopStatus =
	| "running"
	| "paused"
	| "achieved"
	| "max_turns"
	| "budget_exceeded"
	| "blocked"
	| "cancelled";

/** One evaluation by the goal-judge model after a turn. */
export interface GoalVerdict {
	turn: number;
	achieved: boolean;
	/** "achieved: all tests pass" | "not-achieved: 2/8 tests failing" | "BLOCKED: <reason>" (BLOCKED: prefix → status='blocked'). */
	reason: string;
	evidenceRefs?: string[];
	evaluatorModel: string;
	evaluatedAt: string;
}

/** Persisted at <crewRoot>/state/goals/<goalId>.json by GoalStore. Survives session restart. */
export interface GoalLoopState {
	goalId: string;
	ownerSessionId: string;
	objective: string;
	scope?: string;
	/** Acceptance conditions as shell commands (exit 0 = pass). Reuses VerificationContract semantics. */
	verification?: { commands: string[]; allowManualEvidence?: boolean };
	state: GoalLoopStatus;
	maxTurns: number;
	turnsUsed: number;
	budgetTotal?: number;
	budgetWarning?: number;
	budgetAbort?: number;
	budgetUsed: number;
	evaluatorModel: string;
	workerModel?: string;
	/** subagent_type / agent name for worker turns (default "executor"). */
	workerAgent?: string;
	team?: string;
	cwd: string;
	/** Feedback from turn N's verdict, prepended into turn N+1's manifest.goal (G1). */
	nextTurnFeedback?: string;
	/** The team-run of the current in-flight turn (for cancel/steer). */
	currentRunId?: string;
	verdicts: GoalVerdict[];
	history: { runId: string; outcome: string; learnedAt: string; turn: number }[];
	createdAt: string;
	updatedAt: string;
	/** Mirror of manifest.async for PID-liveness checks (cf. AsyncRunState). */
	async?: { pid: number; logPath: string; spawnedAt: string };
}

export interface ModelAttemptState {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
}

export interface ModelRoutingState {
	requested?: string;
	resolved: string;
	fallbackChain: string[];
	reason?: string;
	usedAttempt: number;
}

export interface TaskWorktreeState {
	path: string;
	branch: string;
	reused: boolean;
}

export interface TaskCheckpointState {
	phase: "started" | "child-spawned" | "child-stdout-final" | "artifact-written";
	updatedAt: string;
	childPid?: number;
}

export interface TaskAttemptState {
	attemptId?: string;
	startedAt: string;
	endedAt?: string;
	error?: string;
}

export interface TeamTaskState {
	id: string;
	runId: string;
	stepId?: string;
	role: string;
	agent: string;
	title: string;
	displayName?: string;
	status: TeamTaskStatus;
	dependsOn: string[];
	cwd: string;
	worktree?: TaskWorktreeState;
	promptArtifact?: ArtifactDescriptor;
	resultArtifact?: ArtifactDescriptor;
	logArtifact?: ArtifactDescriptor;
	transcriptArtifact?: ArtifactDescriptor;
	startedAt?: string;
	finishedAt?: string;
	exitCode?: number | null;
	model?: string;
	modelAttempts?: ModelAttemptState[];
	modelRouting?: ModelRoutingState;
	usage?: UsageState;
	jsonEvents?: number;
	agentProgress?: CrewAgentProgress;
	error?: string;
	claim?: TaskClaimState;
	heartbeat?: WorkerHeartbeatState;
	checkpoint?: TaskCheckpointState;
	attempts?: TaskAttemptState[];
	workerExitStatus?: WorkerExitStatus;
	terminalEvidence?: OperationTerminalEvidence[];
	taskPacket?: TaskPacket;
	verification?: VerificationEvidence;
	graph?: TaskGraphNode;
	adaptive?: {
		phase: string;
		task: string;
	};
	policy?: {
		retryCount?: number;
		lastDecision?: PolicyDecision;
	};
	controlReservation?: ControlReservation;

	/** Structured diagnostics per task (ASI pattern from pi-autoresearch). */
	diagnostics?: Record<string, unknown>;

	/** Segment counter for task retry isolation. Default 0 (first attempt). Incremented on retry. */
	segment?: number;

	/** Parsed metric key-values from worker output (CREW_METRIC lines). */
	metrics?: Record<string, number>;

	/** Lifetime token usage accumulated via message_end events. Survives compaction
	 *  (session.stats reset on compaction, but this is an independent accumulator). */
	lifetimeUsage?: { input: number; output: number; cacheWrite: number };

	/** Steering messages queued before the task's session was ready.
	 *  Delivered when the session initializes (mirrors pi-subagents3 pendingSteers pattern). */
	pendingSteers?: string[];
}

export interface ControlReservation {
	reservedAt: string;
	controllerId: string;
	acceptsControlEvents: boolean;
}

/**
 * A task scheduled to fire on a cron expression, interval, or one-shot.
 * Persisted at `<cwd>/.crew/state/schedules/<sessionId>.json`.
 * Session-scoped: survives /resume, resets on /new.
 */
export interface ScheduledTask {
	id: string;
	name: string;
	description: string;
	/** Raw schedule: cron expr | "+10m" | "5m" | ISO timestamp */
	schedule: string;
	scheduleType: "cron" | "interval" | "once";
	intervalMs?: number;
	/** Workflow/step to execute when the schedule fires */
	workflowName: string;
	stepId?: string;
	/** Resolved at create time from workflow/step config */
	agentName: string;
	model?: string;
	enabled: boolean;
	createdAt: string;
	lastRun?: string;
	lastStatus?: "success" | "error" | "running";
	nextRun?: string;
	runCount: number;
}

export interface ScheduleStoreData {
	version: 1;
	jobs: ScheduledTask[];
}

import type { CrewAgentProgress } from "../runtime/crew-agent-runtime.ts";
import type { WorkerHeartbeatState } from "../runtime/heartbeat/worker-heartbeat.ts";
import type { CrashClass } from "../runtime/recovery/crash-classification.ts";
import type { FatalFsCause } from "../utils/fs-errno.ts";
import type { TeamRunStatus, TeamTaskStatus } from "./contracts.ts";
import type { TaskClaimState } from "./coordination/task-claims.ts";
import type { CoherenceMark, RolloutEntry } from "./decision-ledger.ts";

export type { TeamRunStatus, TeamTaskStatus } from "./contracts.ts";
export type { CoherenceMark, CrewAgentProgress, RolloutEntry };

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

export type SpecPriority = "must" | "should" | "could";

/** T4/R6 (ADR-6 §1): workspace-level spec record — state/specs/<id>.json.
 *  Revision machinery mirrors ADR-4 §1 PlanRecord (append-only revision list,
 *  copy-forward linkage, stable requirement/acceptance ids). */
export interface SpecRecord {
	id: string;
	version: number;
	revisionOf?: number;
	title: string;
	requirements: Array<{ id: string; text: string; priority: SpecPriority }>;
	acceptance: Array<{
		id: string;
		requirementId: string;
		/** Free-text description of what counts as evidence (non-strict). */
		check: string;
		/** Strict mode (ADR-6 §4): machine-checkable form. */
		command?: string;
		expectedDigest?: string;
		expectedExitCode?: number;
		idempotent?: boolean;
	}>;
	source: { kind: "manual" | "generated"; by?: string; from?: string };
	/** INFORMATIONAL copy of the store-mint provenance sidecar — the strict
	 *  gate NEVER trusts this field alone (ADR-6 §4 provenance enforcement). */
	trusted?: boolean;
}

/** Immutable per-task freeze (ADR-6 §1): embedded into the TaskPacket at
 *  dispatch; the strict gate executes ONLY snapshot-frozen commands. */
export interface SpecSnapshotItem {
	requirement: SpecRecord["requirements"][number];
	acceptance: SpecRecord["acceptance"][number];
}

export interface SpecSnapshot {
	specId: string;
	version: number;
	frozenAt: string;
	items: SpecSnapshotItem[];
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
	/** T4/R6 (ADR-6): workspace spec ids this task is held to (frozen below). */
	specRefs?: string[];
	/** Frozen snapshots embedded at dispatch — later spec edits never rewrite
	 *  what a running task was held to. */
	specSnapshots?: SpecSnapshot[];
}

export type PolicyDecisionAction = "retry" | "reassign" | "escalate" | "block" | "notify" | "cleanup" | "closeout" | "fail";
export type PolicyDecisionReason =
	| "task_failed"
	| "worker_stale"
	| "green_unsatisfied"
	| "limit_exceeded"
	| "run_complete"
	| "mailbox_timeout"
	| "review_rejected"
	| "branch_stale"
	| "scope_mismatch"
	| "ineffective_worker";

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
	/** Categorical classification of the exit (P0 crash taxonomy). Optional
	 *  because it is populated by child-pi.ts at settle time; older/synthetic
	 *  exit statuses may omit it. */
	crashClass?: CrashClass;
	/** Phase-0 diagnostic (HB-003a): final-drain race state for the exit-null
	 *  disableTools bug. Optional + read-only — absent when no drain timer was
	 *  ever armed. Phase 1 will use `finalDrainArmed` to decide whether a
	 *  signal-death (exitCode=null) should be treated as a forced final drain. */
	finalDrainArmed?: boolean;
	forcedFinalDrain?: boolean;
	finalDrainFiredMonotonicMs?: number;
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

/** T2/R4 (ADR-4 docs/decisions/2026-08-17-plan-object.md §1): status vocabulary
 *  shared by plan phases and items. `dropped` marks items removed by a re-plan
 *  revision (kept for traceability + diff, never re-dispatched). */
export type PlanItemStatus = "pending" | "active" | "done" | "dropped";

export interface PlanPhaseRecord {
	id: string;
	title: string;
	itemIds: string[];
	status: PlanItemStatus;
}

export interface PlanItemRecord {
	/** Stable across revisions (ADR-4 §3 producer contract) — the scheduler
	 *  copies carried-over linkage forward at revision switch. */
	id: string;
	/** External reference (e.g. tagged section id in the source plan doc). */
	ref?: string;
	title: string;
	/** Scheduler-owned (single writer, inside the run lock — ADR-4 §3).
	 *  Producers NEVER set taskIds. */
	taskIds: string[];
	/** R6/T4 forward hook; T2 writes it empty (ADR-4 §1). */
	specIds: string[];
	acceptance: string[];
	status: PlanItemStatus;
}

/** Plan-record side of the approval gate. Vocabulary note (ADR-4 §8): the
 *  manifest side keeps `PlanApprovalState` ("cancelled" for deny); the record
 *  side uses "rejected" — `plans reject` dual-writes both. */
export interface PlanApprovalRecord {
	status: "pending" | "approved" | "rejected";
	by?: string;
	at: string;
	planVersion: number;
}

/** One revision in the append-only list persisted at
 *  `<stateRoot>/plans/plans.json` (plan-store.ts). History is never mutated in
 *  place — EXCEPT the current revision's `items[].taskIds`, the scheduler's
 *  single-writer linkage field (ADR-4 §3). */
export interface PlanRecord {
	id: string;
	runId: string;
	version: number;
	revisionOf?: { id: string; version: number };
	title: string;
	phases: PlanPhaseRecord[];
	items: PlanItemRecord[];
	approval?: PlanApprovalRecord;
	createdAt: string;
	authorTaskId?: string;
}
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

/**
 * S-01: schemaVersion sentinel for the run manifest. Increment on breaking
 * state changes; add migration logic in state-store load paths. Loaded
 * manifests whose schemaVersion differs emit a console.warn (no throw).
 */
export const CURRENT_SCHEMA_VERSION = 1 as const;

/**
 * ST-9: schemaVersion sentinel for tasks.json (and future goal-state/mailbox
 * files). Mirrors {@link CURRENT_SCHEMA_VERSION} for the manifest.
 *
 * tasks.json has two on-disk shapes:
 * - v0 (legacy): bare JSON array `TeamTaskState[]` — no schemaVersion.
 * - v1+ (current): envelope `{ schemaVersion, tasks }` — see {@link TasksFileData}.
 *
 * The reader detects the shape, warns on version mismatch, and applies
 * migration logic in state-store.ts (the structured migration hook).
 */
export const CURRENT_TASKS_SCHEMA_VERSION = 1 as const;

/**
 * ST-9: Versioned envelope for tasks.json on disk.
 * Writers produce this shape; readers accept it OR the legacy v0 bare array.
 * `TeamTaskState` is defined later in this module but interface declarations
 * are type-hoisted so the forward reference is valid.
 */
export interface TasksFileData {
	schemaVersion: typeof CURRENT_TASKS_SCHEMA_VERSION;
	tasks: TeamTaskState[];
}

export interface TeamRunManifest {
	schemaVersion: typeof CURRENT_SCHEMA_VERSION;
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
	/** @deprecated-plan-pointer T2/R4 (ADR-4 §2): dual-write era — PlanRecord at
	 *  `<stateRoot>/plans/plans.json` is authoritative; this field is kept (never
	 *  dropped) as the pre-v2 fallback and legacy UI surface. Deprecate-only. */
	planApproval?: PlanApprovalState;
	/** T2/R4 (ADR-4 §2): pointer to the CURRENT plan revision in
	 *  `<stateRoot>/plans/plans.json`. Plan-record-first readers fall back to
	 *  `planApproval` above when absent or no record exists (dual-read migration;
	 *  the manifest field is deprecated, never dropped). */
	plan?: { id: string; version: number };
	/** WP-2/R2 (ADR-0 item 3): run-level park pointer while a worker is blocked
	 *  in the `ask` tool. Purely additive coordination state — `status` above is
	 *  NEVER flipped to express waiting (the run stays "running": registry entry,
	 *  sidebar visibility and live-executor.isCurrent() all preserved). */
	waitState?: {
		taskId: string;
		questionId: string;
		askedAt: string;
	};
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
	/** round-14 P1-5: typed workflow arguments accessible in .dwf.ts scripts via ctx.args<T>(). Any JSON value; default {} when unset. */
	args?: unknown;
	/** Per-run token budget snapshot. budgetTotal is the cap; budgetWarning/budgetAbort are fractions in [0,1] at which the team-runner emits run.budget_warning / run.budget_abort. budgetUnlimited=true opts out of enforcement. Optional for backward compat. */
	budgetTotal?: number;
	budgetWarning?: number;
	budgetAbort?: number;
	budgetUnlimited?: boolean;
	summary?: string;
	policyDecisions?: PolicyDecision[];
	/** #2 (assessment): goal-achievement verdict — kills the silent false-green. */
	goalAchieved?: boolean | "unknown";
	goalAchievementNote?: string;
	/**
	 * Model routing snapshot captured at dispatch time. Background/async runs
	 * execute in a detached process with no `ExtensionContext`, so without this
	 * they lose the caller's `model=` override, the inherited session model and
	 * the auth-filtered model catalogue — and silently route to whatever
	 * models.json happens to list first.
	 */
	modelContext?: RunModelContext;
}

export interface RunModelContext {
	/** `model=` passed to the team tool for this run. */
	override?: string;
	/** The main session's live model at dispatch time (`"provider/id"`). */
	parentModel?: string;
	/** The main session's thinking level at dispatch time. */
	parentThinking?: string;
	/** `"provider/id"` entries from the caller's pi ModelRegistry (auth-filtered). */
	availableModels?: string[];
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

/**
 * Outer-state lifecycle of a goal loop. Inner per-turn state lives on each turn's TeamRunManifest.
 *
 * P1b (RFC v0.5 §P1b): `"stuck"` is NON-TERMINAL and RE-HINTABLE. Legal transitions:
 *   running → stuck     (only by the background loop, after the oscillation detector fires)
 *   stuck   → running   (only by `goal resume`, atomically via GoalStore.compareAndSetStatus)
 *   stuck   → cancelled (by the idle-timeout sweeper OR `goal stop`)
 */
export type GoalLoopStatus = "running" | "paused" | "stuck" | "achieved" | "max_turns" | "budget_exceeded" | "blocked" | "cancelled";

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
	/** P1d (RFC v0.5 §P1d): when true, budget enforcement is skipped (explicit opt-out; audit-logged at start). */
	budgetUnlimited?: boolean;
	budgetWarning?: number;
	budgetAbort?: number;
	budgetUsed: number;
	/**
	 * P1a (RFC v0.5 §P1a): bookend integrity snapshot of project-manifest files
	 * taken at goal start (only when verification.commands is declared). The
	 * goal-loop-runner re-hashes before (T_snap) and after (T_verify_done) each
	 * verification command to detect persistent manifest tampering. The literal
	 * `"none-text-only"` marks goals started in text-only verification mode
	 * (no objective oracle → no snapshot taken).
	 */
	verificationIntegrity?: { snapshot: Record<string, string>; takenAt: string } | "none-text-only";
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
	history: {
		runId: string;
		outcome: string;
		learnedAt: string;
		turn: number;
	}[];
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
	/**
	 * Set when the caller asked for a model that is not resolvable against the
	 * available catalogue, so the chain silently ran something else. Surfaced
	 * as a warning in the tool result and doctor output.
	 */
	droppedRequested?: string;
	/** How many candidates came from the auto tail (diagnostics). */
	autoFallbackCount?: number;
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
	/** Fatal fs failure cause (bug-026 sub-issue B): set when the failure was
	 *  classified as enospc/edquot/emfile/enfile so operators see "failed
	 *  (disk full)" instead of a generic timeout diagnostic. */
	failureCause?: FatalFsCause;
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
	/** T2/R4 (ADR-4 §3): the plan item this task implements. Set by producers
	 *  when they create tasks from PlanRecord items; the scheduler reads it at
	 *  dispatch to link `items[].taskIds` (single writer, run-locked). */
	planItem?: string;
	/** T2/R4 (ADR-4 §4): set when the wrap-up advisory was delivered because the
	 *  item was dropped by a re-plan (soft cancel; exactly-once across ticks).
	 *  Doubles as the terminal marker "cancelled-by-replan". */
	replanDroppedAt?: string;
	/** T3/R5 (ADR-5 §3): delegation depth of THIS task. Workers are depth 1;
	 *  delegate-spawned grandchildren are depth 2+. The spawn policy computes
	 *  a grandchild's depth from this record field — NEVER from the requesting
	 *  worker's env or self-report (design §7 rev-2 P0-2). Additive: absent on
	 *  pre-v2 records (readers treat absent as depth 1). */
	depth?: number;
	/** T3/R5 (ADR-5 §5): per-task budget allocation for delegate accounting.
	 *  `tokensGranted` is reserved at delegate admission; `tokensSpent` rolls up
	 *  grandchild usage as events arrive (single writer, run lock). Additive. */
	allocation?: {
		tokensGranted: number;
		tokensSpent: number;
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

	/** WP-2/R2 (ADR-0 docs/decisions/2026-08-17-waiting-producer-ask.md item 3):
	 *  park marker set while the worker is blocked in the `ask` tool awaiting a
	 *  leader answer. Purely additive — `status` carries "waiting" for the whole
	 *  park and the parked tool's terminal report flips it back via the normal
	 *  task lifecycle. */
	waiting?: {
		/** Correlation id (randomUUID) — matches manifest.waitState.questionId and
		 *  the mailbox `kind:"response"` entry carrying the answer. */
		questionId: string;
		/** ISO timestamp when the park was accepted (broker wait.request). */
		askedAt: string;
		/** Ms-epoch answer deadline. Server-clamped root-side by the broker to
		 *  now + min(timeoutSec, 3600) — worker-controlled values never exceed 1h. */
		deadline: number;
		/** Optional answer choices the worker presented with the question. */
		options?: string[];
	};
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

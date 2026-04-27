import type { TeamRunStatus, TeamTaskStatus } from "./contracts.ts";
import type { TaskClaimState } from "./task-claims.ts";
import type { WorkerHeartbeatState } from "../runtime/worker-heartbeat.ts";
import type { CrewAgentProgress } from "../runtime/crew-agent-runtime.ts";
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
}

export type PolicyDecisionAction = "retry" | "reassign" | "escalate" | "block" | "notify" | "cleanup" | "closeout";
export type PolicyDecisionReason = "task_failed" | "worker_stale" | "green_unsatisfied" | "limit_exceeded" | "run_complete" | "mailbox_timeout" | "review_rejected" | "branch_stale" | "scope_mismatch";

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

export interface TeamRunManifest {
	schemaVersion: 1;
	runId: string;
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

export interface ModelAttemptState {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
}

export interface TaskWorktreeState {
	path: string;
	branch: string;
	reused: boolean;
}

export interface TeamTaskState {
	id: string;
	runId: string;
	stepId?: string;
	role: string;
	agent: string;
	title: string;
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
	modelAttempts?: ModelAttemptState[];
	usage?: UsageState;
	jsonEvents?: number;
	agentProgress?: CrewAgentProgress;
	error?: string;
	claim?: TaskClaimState;
	heartbeat?: WorkerHeartbeatState;
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
}

import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewLimitsConfig } from "../config/config.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { appendEvent } from "../state/event-log.ts";
import type { TeamConfig } from "../teams/team-config.ts";
import type { PolicyDecision, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { saveRunManifest, saveRunTasks, updateRunStatus } from "../state/state-store.ts";
import { aggregateUsage, formatUsage } from "../state/usage.ts";
import type { WorkflowConfig, WorkflowStep } from "../workflows/workflow-config.ts";
import { evaluateCrewPolicy, summarizePolicyDecisions } from "./policy-engine.ts";
import { buildRecoveryLedger } from "./recovery-recipes.ts";
import { getReadyTasks, refreshTaskGraphQueues, taskGraphSnapshot } from "./task-graph-scheduler.ts";
import { checkBranchFreshness } from "../worktree/branch-freshness.ts";
import { runTeamTask } from "./task-runner.ts";

export interface ExecuteTeamRunInput {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	team: TeamConfig;
	workflow: WorkflowConfig;
	agents: AgentConfig[];
	executeWorkers: boolean;
	limits?: CrewLimitsConfig;
	signal?: AbortSignal;
}

function findReadyTask(tasks: TeamTaskState[]): TeamTaskState | undefined {
	return getReadyTasks(tasks, 1)[0];
}

function findStep(workflow: WorkflowConfig, task: TeamTaskState): WorkflowStep {
	const step = workflow.steps.find((candidate) => candidate.id === task.stepId);
	if (!step) throw new Error(`Workflow step '${task.stepId}' not found for task '${task.id}'.`);
	return step;
}

function findAgent(agents: AgentConfig[], task: TeamTaskState): AgentConfig {
	const agent = agents.find((candidate) => candidate.name === task.agent);
	if (!agent) throw new Error(`Agent '${task.agent}' not found for task '${task.id}'.`);
	return agent;
}

function markBlocked(tasks: TeamTaskState[], reason: string): TeamTaskState[] {
	return tasks.map((task) => task.status === "queued" ? { ...task, status: "skipped", error: reason, finishedAt: new Date().toISOString(), graph: task.graph ? { ...task.graph, queue: "blocked" } : undefined } : task);
}

function formatTaskProgress(task: TeamTaskState): string {
	return `- ${task.id}: ${task.status} (${task.role} -> ${task.agent})${task.taskPacket ? ` scope=${task.taskPacket.scope}` : ""}${task.verification ? ` green=${task.verification.observedGreenLevel}/${task.verification.requiredGreenLevel}` : ""}${task.error ? ` - ${task.error}` : ""}`;
}

function writeProgress(manifest: TeamRunManifest, tasks: TeamTaskState[], producer: string): TeamRunManifest {
	const counts = new Map<string, number>();
	for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
	const queue = taskGraphSnapshot(tasks);
	const progress = writeArtifact(manifest.artifactsRoot, {
		kind: "progress",
		relativePath: "progress.md",
		producer,
		content: [
			`# pi-crew progress ${manifest.runId}`,
			"",
			`Status: ${manifest.status}`,
			`Team: ${manifest.team}`,
			`Workflow: ${manifest.workflow ?? "(none)"}`,
			`Updated: ${new Date().toISOString()}`,
			`Task counts: ${[...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`,
			`Queue: ready=${queue.ready.length}, blocked=${queue.blocked.length}, running=${queue.running.length}, done=${queue.done.length}, failed=${queue.failed.length}, cancelled=${queue.cancelled.length}`,
			"",
			"## Tasks",
			...tasks.map(formatTaskProgress),
			"",
		].join("\n"),
	});
	return { ...manifest, updatedAt: new Date().toISOString(), artifacts: [...manifest.artifacts.filter((artifact) => !(artifact.kind === "progress" && artifact.path === progress.path)), progress] };
}

function applyPolicy(manifest: TeamRunManifest, tasks: TeamTaskState[], limits?: CrewLimitsConfig): TeamRunManifest {
	const branchFreshness = checkBranchFreshness(manifest.cwd);
	const branchArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: "metadata/branch-freshness.json",
		producer: "branch-freshness",
		content: `${JSON.stringify(branchFreshness, null, 2)}\n`,
	});
	let decisions: PolicyDecision[] = evaluateCrewPolicy({ manifest, tasks, limits });
	if (branchFreshness.status === "stale" || branchFreshness.status === "diverged") {
		const branchDecision: PolicyDecision = {
			action: "notify",
			reason: "branch_stale",
			message: branchFreshness.message,
			createdAt: new Date().toISOString(),
		};
		decisions = [...decisions, branchDecision];
		appendEvent(manifest.eventsPath, { type: "branch.stale", runId: manifest.runId, message: branchFreshness.message, data: { branchFreshness } });
	}
	const policyArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: "policy-decisions.json",
		producer: "policy-engine",
		content: `${JSON.stringify(decisions, null, 2)}\n`,
	});
	const recoveryLedger = buildRecoveryLedger(decisions);
	const recoveryArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: "recovery-ledger.json",
		producer: "recovery-engine",
		content: `${JSON.stringify(recoveryLedger, null, 2)}\n`,
	});
	for (const item of decisions) appendEvent(manifest.eventsPath, { type: item.action === "escalate" ? "policy.escalated" : "policy.action", runId: manifest.runId, taskId: item.taskId, message: item.message, data: { action: item.action, reason: item.reason } });
	for (const item of recoveryLedger.entries) appendEvent(manifest.eventsPath, { type: item.state === "escalation_required" ? "recovery.escalated" : "recovery.attempted", runId: manifest.runId, taskId: item.taskId, message: item.message, data: { scenario: item.scenario, steps: item.steps, attempt: item.attempt, state: item.state } });
	return { ...manifest, updatedAt: new Date().toISOString(), policyDecisions: decisions, artifacts: [...manifest.artifacts.filter((artifact) => !(artifact.kind === "metadata" && (artifact.path.endsWith("policy-decisions.json") || artifact.path.endsWith("recovery-ledger.json") || artifact.path.endsWith("branch-freshness.json")))), branchArtifact, policyArtifact, recoveryArtifact] };
}

export async function executeTeamRun(input: ExecuteTeamRunInput): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> {
	let manifest = updateRunStatus(input.manifest, "running", input.executeWorkers ? "Executing team workflow." : "Creating workflow prompts and placeholder results.");
	let tasks = refreshTaskGraphQueues(input.tasks);
	manifest = writeProgress(manifest, tasks, "team-runner");
	saveRunManifest(manifest);

	while (tasks.some((task) => task.status === "queued")) {
		if (input.signal?.aborted) {
			tasks = tasks.map((task) => task.status === "queued" || task.status === "running" ? { ...task, status: "cancelled", finishedAt: new Date().toISOString(), error: "Run cancelled." } : task);
			saveRunTasks(manifest, tasks);
			manifest = updateRunStatus(manifest, "cancelled", "Run cancelled.");
			return { manifest, tasks };
		}

		const failed = tasks.find((task) => task.status === "failed");
		if (failed) {
			tasks = markBlocked(tasks, `Blocked by failed task '${failed.id}'.`);
			saveRunTasks(manifest, tasks);
			manifest = updateRunStatus(manifest, "failed", `Failed at task '${failed.id}'.`);
			return { manifest, tasks };
		}

		const task = findReadyTask(tasks);
		if (!task) {
			tasks = markBlocked(tasks, "No ready queued task; dependency graph may be invalid.");
			saveRunTasks(manifest, tasks);
			manifest = updateRunStatus(manifest, "blocked", "No ready queued task.");
			return { manifest, tasks };
		}

		const step = findStep(input.workflow, task);
		const agent = findAgent(input.agents, task);
		const result = await runTeamTask({ manifest, tasks, task, step, agent, signal: input.signal, executeWorkers: input.executeWorkers });
		manifest = result.manifest;
		tasks = result.tasks;
		manifest = writeProgress(manifest, tasks, "team-runner");
		saveRunManifest(manifest);
	}

	const failed = tasks.find((task) => task.status === "failed");
	manifest = applyPolicy(manifest, tasks, input.limits);
	const blockingDecision = manifest.policyDecisions?.find((item) => item.action === "block" || item.action === "escalate");
	if (failed) {
		manifest = updateRunStatus(manifest, "failed", `Failed at task '${failed.id}'.`);
	} else if (blockingDecision) {
		manifest = updateRunStatus(manifest, "blocked", blockingDecision.message);
	} else {
		manifest = updateRunStatus(manifest, "completed", input.executeWorkers ? "Team workflow completed." : "Team workflow scaffold completed without launching child workers.");
	}
	manifest = writeProgress(manifest, tasks, "team-runner");
	saveRunManifest(manifest);
	const usage = aggregateUsage(tasks);
	const summaryArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "summary",
		relativePath: "summary.md",
		producer: "team-runner",
		content: [
			`# pi-crew run ${manifest.runId}`,
			"",
			`Status: ${manifest.status}`,
			`Team: ${manifest.team}`,
			`Workflow: ${manifest.workflow ?? "(none)"}`,
			`Goal: ${manifest.goal}`,
			`Usage: ${formatUsage(usage)}`,
			"",
			"## Tasks",
			...tasks.map(formatTaskProgress),
			"",
			"## Policy decisions",
			...(manifest.policyDecisions?.length ? summarizePolicyDecisions(manifest.policyDecisions) : ["- (none)"]),
			"",
		].join("\n"),
	});
	manifest = { ...manifest, updatedAt: new Date().toISOString(), artifacts: [...manifest.artifacts, summaryArtifact] };
	saveRunManifest(manifest);
	saveRunTasks(manifest, tasks);
	return { manifest, tasks };
}

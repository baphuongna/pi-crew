import * as fs from "node:fs";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewLimitsConfig, CrewRuntimeConfig } from "../config/config.ts";
import type { CrewRuntimeCapabilities } from "./runtime-resolver.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { appendEvent } from "../state/event-log.ts";
import type { TeamConfig } from "../teams/team-config.ts";
import type { ArtifactDescriptor, PolicyDecision, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { saveRunManifestAsync, saveRunTasksAsync, updateRunStatus } from "../state/state-store.ts";
import { aggregateUsage, formatUsage } from "../state/usage.ts";
import type { WorkflowConfig, WorkflowStep } from "../workflows/workflow-config.ts";
import { evaluateCrewPolicy, summarizePolicyDecisions } from "./policy-engine.ts";
import { buildRecoveryLedger } from "./recovery-recipes.ts";
import { buildTaskGraphIndex, getReadyTasks, refreshTaskGraphQueues, taskGraphSnapshot } from "./task-graph-scheduler.ts";
import { checkBranchFreshness } from "../worktree/branch-freshness.ts";
import { aggregateTaskOutputs } from "./task-output-context.ts";
import { saveCrewAgents } from "./crew-agent-records.ts";
import { recordsForMaterializedTasks } from "./task-display.ts";
import { deliverGroupJoin, resolveGroupJoinMode } from "./group-join.ts";
import { runTeamTask } from "./task-runner.ts";
import { resolveBatchConcurrency } from "./concurrency.ts";
import { mapConcurrent } from "./parallel-utils.ts";

export interface ExecuteTeamRunInput {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	team: TeamConfig;
	workflow: WorkflowConfig;
	agents: AgentConfig[];
	executeWorkers: boolean;
	limits?: CrewLimitsConfig;
	runtime?: CrewRuntimeCapabilities;
	runtimeConfig?: CrewRuntimeConfig;
	parentContext?: string;
	parentModel?: unknown;
	modelRegistry?: unknown;
	modelOverride?: string;
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

function mergeArtifacts(items: ArtifactDescriptor[]): ArtifactDescriptor[] {
	const byPath = new Map<string, ArtifactDescriptor>();
	for (const item of items) byPath.set(item.path, item);
	return [...byPath.values()];
}

function isNonTerminalTaskStatus(status: TeamTaskState["status"]): boolean {
	return status === "queued" || status === "running";
}

function shouldMergeTaskUpdate(current: TeamTaskState, updated: TeamTaskState): boolean {
	// Parallel workers receive the same input snapshot. A later result may still
	// contain stale queued/running copies of tasks that another worker already
	// completed. Never let those stale snapshots regress durable task state.
	if (!isNonTerminalTaskStatus(current.status) && isNonTerminalTaskStatus(updated.status)) return false;
	return updated.status !== current.status || updated.finishedAt !== current.finishedAt || updated.startedAt !== current.startedAt || Boolean(updated.resultArtifact) || Boolean(updated.error) || Boolean(updated.modelAttempts?.length) || Boolean(updated.usage);
}

export function __test__mergeTaskUpdates(base: TeamTaskState[], results: Array<{ tasks: TeamTaskState[] }>): TeamTaskState[] {
	let merged = base;
	for (const result of results) {
		for (const updated of result.tasks) {
			const current = merged.find((task) => task.id === updated.id);
			if (!current || !shouldMergeTaskUpdate(current, updated)) continue;
			merged = merged.map((task) => task.id === updated.id ? updated : task);
		}
	}
	return refreshTaskGraphQueues(merged);
}

interface AdaptivePlanTask {
	role: string;
	title?: string;
	task: string;
}

interface AdaptivePlanPhase {
	name: string;
	tasks: AdaptivePlanTask[];
}

interface AdaptivePlan {
	phases: AdaptivePlanPhase[];
}

const MAX_ADAPTIVE_TASKS = 12;

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
}

export function __test__parseAdaptivePlan(text: string, allowedRoles: string[]): AdaptivePlan | undefined {
	const markerMatch = text.match(/ADAPTIVE_PLAN_JSON_START\s*([\s\S]*?)\s*ADAPTIVE_PLAN_JSON_END/);
	const fencedMatch = markerMatch ? undefined : text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const raw = markerMatch?.[1] ?? fencedMatch?.[1];
	if (!raw) return undefined;
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { return undefined; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const phasesRaw = Array.isArray((parsed as { phases?: unknown }).phases) ? (parsed as { phases: unknown[] }).phases : Array.isArray((parsed as { tasks?: unknown }).tasks) ? [{ name: "adaptive", tasks: (parsed as { tasks: unknown[] }).tasks }] : undefined;
	if (!phasesRaw) return undefined;
	const allowed = new Set(allowedRoles);
	const phases: AdaptivePlanPhase[] = [];
	let total = 0;
	for (const [phaseIndex, phaseRaw] of phasesRaw.entries()) {
		if (!phaseRaw || typeof phaseRaw !== "object" || Array.isArray(phaseRaw)) return undefined;
		const phaseObj = phaseRaw as { name?: unknown; tasks?: unknown };
		if (!Array.isArray(phaseObj.tasks) || phaseObj.tasks.length === 0) return undefined;
		const tasks: AdaptivePlanTask[] = [];
		for (const taskRaw of phaseObj.tasks) {
			if (!taskRaw || typeof taskRaw !== "object" || Array.isArray(taskRaw)) return undefined;
			const taskObj = taskRaw as { role?: unknown; title?: unknown; task?: unknown };
			if (typeof taskObj.role !== "string" || !allowed.has(taskObj.role)) return undefined;
			if (typeof taskObj.task !== "string" || !taskObj.task.trim()) return undefined;
			if (total >= MAX_ADAPTIVE_TASKS) return undefined;
			tasks.push({ role: taskObj.role, title: typeof taskObj.title === "string" ? taskObj.title : undefined, task: taskObj.task.trim() });
			total++;
		}
		phases.push({ name: typeof phaseObj.name === "string" && phaseObj.name.trim() ? phaseObj.name.trim() : `phase-${phaseIndex + 1}`, tasks });
	}
	return phases.length ? { phases } : undefined;
}

function reconstructAdaptiveWorkflow(workflow: WorkflowConfig, tasks: TeamTaskState[]): WorkflowConfig {
	const existing = new Set(workflow.steps.map((step) => step.id));
	const steps: WorkflowStep[] = [];
	for (const task of tasks) {
		if (!task.stepId?.startsWith("adaptive-") || !task.adaptive?.task || existing.has(task.stepId)) continue;
		steps.push({ id: task.stepId, role: task.role, dependsOn: task.graph?.dependencies ?? task.dependsOn, parallelGroup: `adaptive-${slug(task.adaptive.phase)}`, task: task.adaptive.task });
	}
	return steps.length ? { ...workflow, steps: [...workflow.steps, ...steps] } : workflow;
}

function injectAdaptivePlanIfReady(input: { manifest: TeamRunManifest; tasks: TeamTaskState[]; workflow: WorkflowConfig; team: TeamConfig }): { tasks: TeamTaskState[]; workflow: WorkflowConfig; injected: boolean; missingPlan: boolean } {
	if (input.workflow.name !== "implementation") return { tasks: input.tasks, workflow: input.workflow, injected: false, missingPlan: false };
	if (input.tasks.some((task) => task.stepId?.startsWith("adaptive-"))) return { tasks: input.tasks, workflow: reconstructAdaptiveWorkflow(input.workflow, input.tasks), injected: false, missingPlan: false };
	const completedAssess = input.tasks.find((task) => task.stepId === "assess" && task.status === "completed");
	if (!completedAssess) return { tasks: input.tasks, workflow: input.workflow, injected: false, missingPlan: false };
	if (!completedAssess.resultArtifact?.path) {
		appendEvent(input.manifest.eventsPath, { type: "adaptive.plan_missing", runId: input.manifest.runId, taskId: completedAssess.id, message: "Adaptive planner result artifact is missing." });
		return { tasks: input.tasks, workflow: input.workflow, injected: false, missingPlan: true };
	}
	const assessTask = completedAssess;
	const resultPath = completedAssess.resultArtifact.path;
	let text = "";
	try { text = fs.readFileSync(resultPath, "utf-8"); } catch {
		appendEvent(input.manifest.eventsPath, { type: "adaptive.plan_missing", runId: input.manifest.runId, taskId: assessTask.id, message: "Adaptive planner result artifact could not be read." });
		return { tasks: input.tasks, workflow: input.workflow, injected: false, missingPlan: true };
	}
	const plan = __test__parseAdaptivePlan(text, input.team.roles.map((role) => role.name));
	if (!plan) {
		appendEvent(input.manifest.eventsPath, { type: "adaptive.plan_missing", runId: input.manifest.runId, taskId: assessTask.id, message: "Adaptive planner did not produce a valid plan; no dynamic subagents were spawned." });
		return { tasks: input.tasks, workflow: input.workflow, injected: false, missingPlan: true };
	}
	const steps: WorkflowStep[] = [];
	const tasks: TeamTaskState[] = [];
	let previousStepIds = ["assess"];
	let counter = 0;
	for (const [phaseIndex, phase] of plan.phases.entries()) {
		const currentStepIds: string[] = [];
		for (const [taskIndex, planned] of phase.tasks.entries()) {
			counter++;
			const stepId = `adaptive-${phaseIndex + 1}-${taskIndex + 1}-${slug(planned.role)}`;
			const taskId = `adaptive-${String(counter).padStart(2, "0")}-${slug(planned.role)}`;
			steps.push({ id: stepId, role: planned.role, dependsOn: previousStepIds, parallelGroup: `adaptive-${slug(phase.name)}`, task: planned.task });
			tasks.push({
				id: taskId,
				runId: input.manifest.runId,
				stepId,
				role: planned.role,
				agent: input.team.roles.find((role) => role.name === planned.role)?.agent ?? planned.role,
				title: planned.title ?? stepId,
				status: "queued",
				dependsOn: previousStepIds,
				cwd: input.manifest.cwd,
				adaptive: { phase: phase.name, task: planned.task },
				graph: { taskId, dependencies: previousStepIds, children: [], queue: "blocked" },
			});
			currentStepIds.push(stepId);
		}
		previousStepIds = currentStepIds;
	}
	const dependencyTaskIdByStep = new Map<string, string>([["assess", assessTask.id], ...tasks.map((task) => [task.stepId ?? task.id, task.id] as const)]);
	const withGraph = tasks.map((task) => ({
		...task,
		dependsOn: task.dependsOn.map((dep) => dependencyTaskIdByStep.get(dep) ?? dep),
		graph: task.graph ? { ...task.graph, dependencies: task.dependsOn.map((dep) => dependencyTaskIdByStep.get(dep) ?? dep), queue: "blocked" as const } : task.graph,
	}));
	const allTasks = refreshTaskGraphQueues([...input.tasks, ...withGraph]);
	appendEvent(input.manifest.eventsPath, { type: "adaptive.plan_injected", runId: input.manifest.runId, taskId: assessTask.id, message: `Injected ${withGraph.length} adaptive subagent task(s) across ${plan.phases.length} phase(s).`, data: { phases: plan.phases.map((phase) => ({ name: phase.name, count: phase.tasks.length, roles: phase.tasks.map((task) => task.role) })) } });
	return { tasks: allTasks, workflow: { ...input.workflow, steps: [...input.workflow.steps, ...steps] }, injected: true, missingPlan: false };
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
	let workflow = input.workflow;
	let manifest = updateRunStatus(input.manifest, "running", input.executeWorkers ? "Executing team workflow." : "Creating workflow prompts and placeholder results.");
	let tasks = refreshTaskGraphQueues(input.tasks);
	let queueIndex = buildTaskGraphIndex(tasks);
	const canInjectAdaptivePlan = workflow.name === "implementation";
	let adaptivePlanInjected = false;
	let adaptivePlanMissing = false;
	const attemptAdaptivePlan = () => {
		if (!canInjectAdaptivePlan || adaptivePlanInjected || adaptivePlanMissing) return { injected: false, missing: false };
		const adaptivePlan = injectAdaptivePlanIfReady({ manifest, tasks, workflow, team: input.team });
		adaptivePlanInjected = adaptivePlanInjected || adaptivePlan.injected;
		adaptivePlanMissing = adaptivePlan.missingPlan;
		workflow = adaptivePlan.workflow;
		if (adaptivePlan.injected) tasks = adaptivePlan.tasks;
		return { injected: adaptivePlan.injected, missing: adaptivePlan.missingPlan };
	};
	const initialAdaptive = attemptAdaptivePlan();
	if (initialAdaptive.missing) {
		tasks = markBlocked(tasks, "Adaptive planner did not produce a valid subagent plan.");
		await saveRunTasksAsync(manifest, tasks);
		manifest = updateRunStatus(manifest, "blocked", "Adaptive planner did not produce a valid subagent plan.");
		return { manifest, tasks };
	}
	if (initialAdaptive.injected) queueIndex = buildTaskGraphIndex(tasks);
	manifest = writeProgress(manifest, tasks, "team-runner");
	await saveRunManifestAsync(manifest);
	const runtimeKind = input.runtime?.kind ?? (input.executeWorkers ? "child-process" : "scaffold");
	saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));

	while (tasks.some((task) => task.status === "queued")) {
		if (input.signal?.aborted) {
			tasks = tasks.map((task) => task.status === "queued" || task.status === "running" ? { ...task, status: "cancelled", finishedAt: new Date().toISOString(), error: "Run cancelled." } : task);
			await saveRunTasksAsync(manifest, tasks);
			manifest = updateRunStatus(manifest, "cancelled", "Run cancelled.");
			return { manifest, tasks };
		}

		const failed = tasks.find((task) => task.status === "failed");
		if (failed) {
			tasks = markBlocked(tasks, `Blocked by failed task '${failed.id}'.`);
			await saveRunTasksAsync(manifest, tasks);
			saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
			manifest = updateRunStatus(manifest, "failed", `Failed at task '${failed.id}'.`);
			return { manifest, tasks };
		}

		const snapshot = taskGraphSnapshot(tasks, queueIndex);
		const readyRoles = snapshot.ready.map((taskId) => tasks.find((task) => task.id === taskId)?.role).filter((role): role is string => Boolean(role));
		const concurrency = resolveBatchConcurrency({ workflowName: workflow.name, workflowMaxConcurrency: workflow.maxConcurrency, teamMaxConcurrency: input.team.maxConcurrency, limitMaxConcurrentWorkers: input.limits?.maxConcurrentWorkers, allowUnboundedConcurrency: input.limits?.allowUnboundedConcurrency, readyCount: snapshot.ready.length, workspaceMode: manifest.workspaceMode, readyRoles });
		if (concurrency.reason.includes(";unbounded:")) {
			appendEvent(manifest.eventsPath, { type: "limits.unbounded", runId: manifest.runId, message: "Unbounded worker concurrency was explicitly enabled for this run.", data: { concurrencyReason: concurrency.reason, maxConcurrent: concurrency.maxConcurrent } });
		}
		const readyBatch = getReadyTasks(tasks, concurrency.selectedCount, queueIndex);
		if (readyBatch.length === 0) {
			tasks = markBlocked(tasks, "No ready queued task; dependency graph may be invalid.");
			await saveRunTasksAsync(manifest, tasks);
			saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
			manifest = updateRunStatus(manifest, "blocked", "No ready queued task.");
			return { manifest, tasks };
		}

		appendEvent(manifest.eventsPath, { type: "task.progress", runId: manifest.runId, message: `Starting ready batch with ${readyBatch.length} task(s).`, data: { taskIds: readyBatch.map((task) => task.id), readyCount: snapshot.ready.length, blockedCount: snapshot.blocked.length, runningCount: snapshot.running.length, doneCount: snapshot.done.length, selectedCount: readyBatch.length, maxConcurrent: concurrency.maxConcurrent, defaultConcurrency: concurrency.defaultConcurrency, concurrencyReason: concurrency.reason } });
		const results = await mapConcurrent(
			readyBatch,
			concurrency.selectedCount,
			(task) => {
				const step = findStep(workflow, task);
				const agent = findAgent(input.agents, task);
				return runTeamTask({ manifest, tasks, task, step, agent, signal: input.signal, executeWorkers: input.executeWorkers, runtimeKind: input.runtime?.kind, runtimeConfig: input.runtimeConfig, parentContext: input.parentContext, parentModel: input.parentModel, modelRegistry: input.modelRegistry, modelOverride: input.modelOverride, limits: input.limits });
			},
		);
		manifest = { ...results.at(-1)!.manifest, artifacts: mergeArtifacts([manifest.artifacts, ...results.map((item) => item.manifest.artifacts)].flat()) };
		tasks = __test__mergeTaskUpdates(tasks, results);
		queueIndex = buildTaskGraphIndex(tasks);
		const injectedAfterBatch = attemptAdaptivePlan();
		if (injectedAfterBatch.missing) {
			tasks = markBlocked(tasks, "Adaptive planner did not produce a valid subagent plan.");
			await saveRunTasksAsync(manifest, tasks);
			saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
			manifest = updateRunStatus(manifest, "blocked", "Adaptive planner did not produce a valid subagent plan.");
			return { manifest, tasks };
		}
		if (injectedAfterBatch.injected) {
			queueIndex = buildTaskGraphIndex(tasks);
		}
		await saveRunTasksAsync(manifest, tasks);
		saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
		const completedBatch = readyBatch.map((task) => tasks.find((item) => item.id === task.id) ?? task);
		const batchArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "summary",
			relativePath: `batches/${readyBatch.map((task) => task.id).join("+")}.md`,
			producer: "team-runner",
			content: aggregateTaskOutputs(completedBatch),
		});
		const groupDelivery = deliverGroupJoin({ manifest, mode: resolveGroupJoinMode(input.runtimeConfig), batch: readyBatch, allTasks: tasks });
		manifest = { ...manifest, artifacts: mergeArtifacts([...manifest.artifacts, batchArtifact, ...(groupDelivery?.artifact ? [groupDelivery.artifact] : [])]) };
		manifest = writeProgress(manifest, tasks, "team-runner");
		await saveRunManifestAsync(manifest);
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
	await saveRunManifestAsync(manifest);
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
	await saveRunManifestAsync(manifest);
	await saveRunTasksAsync(manifest, tasks);
	return { manifest, tasks };
}

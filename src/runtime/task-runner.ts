import * as fs from "node:fs";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewLimitsConfig, CrewRuntimeConfig } from "../config/config.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState, UsageState } from "../state/types.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { appendEvent } from "../state/event-log.ts";
import { saveRunManifest } from "../state/state-store.ts";
import { createTaskClaim } from "../state/task-claims.ts";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "./worker-heartbeat.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";
import { captureWorktreeDiff, captureWorktreeDiffStat, prepareTaskWorkspace } from "../worktree/worktree-manager.ts";
import { buildConfiguredModelRouting, formatModelAttemptNote, isRetryableModelFailure, type ModelAttemptSummary } from "./model-fallback.ts";
import { parsePiJsonOutput, type ParsedPiJsonOutput } from "./pi-json-output.ts";
import { runChildPi } from "./child-pi.ts";
import { buildTaskPacket } from "./task-packet.ts";
import { createVerificationEvidence } from "./green-contract.ts";
import { createStartupEvidence } from "./worker-startup.ts";
import { permissionForRole } from "./role-permission.ts";
import { collectDependencyOutputContext, renderDependencyOutputContext, writeTaskInputsArtifact, writeTaskSharedOutput } from "./task-output-context.ts";
import { appendCrewAgentEvent, appendCrewAgentOutput, emptyCrewAgentProgress, recordFromTask, upsertCrewAgent } from "./crew-agent-records.ts";
import { parseSessionUsage } from "./session-usage.ts";
import type { CrewAgentProgress, CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { shouldAppendProgressEventUpdate, type ProgressEventSummary } from "./progress-event-coalescer.ts";
import { coordinationBridgeInstructions, renderTaskPrompt } from "./task-runner/prompt-builder.ts";
import { applyAgentProgressEvent, applyUsageToProgress, progressEventSummary, shouldFlushProgressEvent } from "./task-runner/progress.ts";
import { checkpointTask, persistSingleTaskUpdate, updateTask } from "./task-runner/state-helpers.ts";
import { cleanResultText, isFinalChildEvent } from "./task-runner/result-utils.ts";

export interface TaskRunnerInput {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	task: TeamTaskState;
	step: WorkflowStep;
	agent: AgentConfig;
	signal?: AbortSignal;
	executeWorkers: boolean;
	runtimeKind?: CrewRuntimeKind;
	runtimeConfig?: CrewRuntimeConfig;
	parentContext?: string;
	parentModel?: unknown;
	modelRegistry?: unknown;
	modelOverride?: string;
	limits?: CrewLimitsConfig;
	dependencyContextText?: string;
}

export async function runTeamTask(input: TaskRunnerInput): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> {
	let manifest = input.manifest;
	const workspace = prepareTaskWorkspace(manifest, input.task);
	const worktree = workspace.worktreePath && workspace.branch ? { path: workspace.worktreePath, branch: workspace.branch, reused: workspace.reused ?? false } : input.task.worktree;
	const taskPacket = buildTaskPacket({ manifest, step: input.step, taskId: input.task.id, cwd: workspace.cwd, worktreePath: worktree?.path });
	const dependencyContext = collectDependencyOutputContext(manifest, input.tasks, input.task, input.step);
	const dependencyContextText = input.dependencyContextText ?? renderDependencyOutputContext(dependencyContext);
	let task: TeamTaskState = {
		...input.task,
		cwd: workspace.cwd,
		worktree,
		taskPacket,
		status: "running",
		startedAt: new Date().toISOString(),
		claim: createTaskClaim(`task-runner:${input.task.id}`),
		heartbeat: createWorkerHeartbeat(input.task.id),
		agentProgress: input.task.agentProgress ?? emptyCrewAgentProgress(),
		...(dependencyContextText ? { dependencyContextText } : {}),
	} as TeamTaskState;
	let tasks = updateTask(input.tasks, task);
	const runtimeKind = input.runtimeKind ?? (input.executeWorkers ? "child-process" : "scaffold");
	tasks = persistSingleTaskUpdate(manifest, tasks, task);
	if (runtimeKind === "child-process") ({ task, tasks } = checkpointTask(manifest, tasks, task, "started"));
	upsertCrewAgent(manifest, recordFromTask(manifest, task, runtimeKind));
	appendEvent(manifest.eventsPath, { type: "task.started", runId: manifest.runId, taskId: task.id, data: { role: task.role, agent: task.agent, runtime: runtimeKind, cwd: task.cwd, worktreePath: workspace.worktreePath, worktreeBranch: workspace.branch, worktreeReused: workspace.reused } });
	const permissionMode = permissionForRole(task.role);

	const prompt = renderTaskPrompt(manifest, input.step, task, input.agent);
	const promptArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "prompt",
		relativePath: `prompts/${task.id}.md`,
		content: `${prompt}\n`,
		producer: task.id,
	});

	let resultArtifact: ArtifactDescriptor;
	let logArtifact: ArtifactDescriptor | undefined;
	let transcriptArtifact: ArtifactDescriptor | undefined;
	let exitCode: number | null = 0;
	let error: string | undefined;
	let modelAttempts: ModelAttemptSummary[] | undefined;
	let parsedOutput: ParsedPiJsonOutput | undefined;

	let startupEvidence = createStartupEvidence({ command: runtimeKind === "child-process" ? "pi" : runtimeKind === "live-session" ? "live-session" : "safe-scaffold", startedAt: new Date(task.startedAt ?? new Date().toISOString()), finishedAt: new Date(), promptSentAt: new Date(task.startedAt ?? new Date().toISOString()), promptAccepted: true, exitCode: 0 });
	const inputsArtifact = writeTaskInputsArtifact(manifest, task, dependencyContext);
	const coordinationArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.coordination-bridge.md`,
		content: `${coordinationBridgeInstructions(task)}\n`,
		producer: task.id,
	});
	if (runtimeKind === "child-process") {
		const modelRoutingPlan = buildConfiguredModelRouting({ overrideModel: input.modelOverride, stepModel: input.step.model, agentModel: input.agent.model, fallbackModels: input.agent.fallbackModels, parentModel: input.parentModel, modelRegistry: input.modelRegistry, cwd: manifest.cwd });
		const candidates = modelRoutingPlan.candidates;
		const attemptModels = candidates.length > 0 ? candidates : [undefined];
		const logs: string[] = [];
		let finalStdout = "";
		let finalStderr = "";
		modelAttempts = [];
		const transcriptPath = `${manifest.artifactsRoot}/transcripts/${task.id}.jsonl`;
		let finalCheckpointWritten = false;
		let lastAgentRecordPersistedAt = 0;
		let lastHeartbeatPersistedAt = 0;
		let lastRunProgressPersistedAt = 0;
		let lastRunProgressSummary: ProgressEventSummary | undefined;
		const persistHeartbeat = (force = false): void => {
			const now = Date.now();
			if (!force && now - lastHeartbeatPersistedAt < 1000) return;
			lastHeartbeatPersistedAt = now;
			task = { ...task, heartbeat: touchWorkerHeartbeat(task.heartbeat ?? createWorkerHeartbeat(task.id)) };
			tasks = persistSingleTaskUpdate(manifest, tasks, task);
		};
		const persistChildProgress = (event: unknown, force = false): void => {
			const now = Date.now();
			if (force || shouldFlushProgressEvent(event) || now - lastAgentRecordPersistedAt >= 500) {
				upsertCrewAgent(manifest, recordFromTask(manifest, task, "child-process"));
				lastAgentRecordPersistedAt = now;
			}
			const summary = progressEventSummary(task, event);
			const decision = shouldAppendProgressEventUpdate({ previous: lastRunProgressSummary, next: summary, nowMs: now, lastAppendMs: lastRunProgressPersistedAt || undefined, minIntervalMs: 1000, force });
			if (decision.shouldAppend) {
				appendEvent(manifest.eventsPath, { type: "task.progress", runId: manifest.runId, taskId: task.id, data: { ...summary, coalesceReason: decision.reason } });
				lastRunProgressSummary = summary;
				lastRunProgressPersistedAt = now;
			}
		};
		for (let i = 0; i < attemptModels.length; i++) {
			const model = attemptModels[i];
			const attemptStartedAt = new Date();
			const pendingAttempt: ModelAttemptSummary = { model: model ?? "default", success: false };
			task = { ...task, modelAttempts: [...modelAttempts, pendingAttempt] };
			tasks = updateTask(tasks, task);
			upsertCrewAgent(manifest, recordFromTask(manifest, task, "child-process"));
			const childResult = await runChildPi({
				cwd: task.cwd,
				task: prompt,
				agent: input.agent,
				model,
				signal: input.signal,
				transcriptPath,
				maxDepth: input.limits?.maxTaskDepth,
				onSpawn: (pid) => {
					({ task, tasks } = checkpointTask(manifest, tasks, task, "child-spawned", pid));
				},
				onStdoutLine: (line) => {
					appendCrewAgentOutput(manifest, task.id, line);
					persistHeartbeat();
				},
				onJsonEvent: (event) => {
					appendCrewAgentEvent(manifest, task.id, event);
					persistHeartbeat();
					task = { ...task, agentProgress: applyAgentProgressEvent(task.agentProgress ?? emptyCrewAgentProgress(), event, task.startedAt) };
					tasks = updateTask(tasks, task);
					if (!finalCheckpointWritten && isFinalChildEvent(event)) {
						finalCheckpointWritten = true;
						({ task, tasks } = checkpointTask(manifest, tasks, task, "child-stdout-final"));
					}
					persistChildProgress(event);
				},
			});
			startupEvidence = createStartupEvidence({ command: "pi", startedAt: attemptStartedAt, finishedAt: new Date(), promptSentAt: attemptStartedAt, promptAccepted: childResult.exitCode === 0 && !childResult.error, stderr: childResult.stderr, error: childResult.error, exitCode: childResult.exitCode });
			exitCode = childResult.exitCode;
			finalStdout = childResult.stdout;
			finalStderr = childResult.stderr;
			parsedOutput = parsePiJsonOutput(fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, "utf-8") : childResult.stdout);
			error = childResult.error || (childResult.exitCode && childResult.exitCode !== 0 ? childResult.stderr || `Child Pi exited with ${childResult.exitCode}` : undefined);
			persistHeartbeat(true);
			persistChildProgress({ type: "attempt_finished" }, true);
			const attempt: ModelAttemptSummary = { model: model ?? "default", success: !error, exitCode, error };
			modelAttempts.push(attempt);
			task = { ...task, modelAttempts: [...modelAttempts] };
			tasks = updateTask(tasks, task);
			logs.push(`MODEL ATTEMPT ${i + 1}: ${attempt.model}`, `success=${attempt.success}`, `exitCode=${attempt.exitCode ?? "null"}`, attempt.error ? `error=${attempt.error}` : "", "");
			if (!error) break;
			const nextModel = attemptModels[i + 1];
			if (!nextModel || !isRetryableModelFailure(error)) break;
			logs.push(formatModelAttemptNote(attempt, nextModel), "");
		}
		resultArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "result",
			relativePath: `results/${task.id}.txt`,
			content: cleanResultText(parsedOutput?.finalText) ?? cleanResultText(finalStdout) ?? cleanResultText(finalStderr) ?? "(no output)",
			producer: task.id,
		});
		logArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "log",
			relativePath: `logs/${task.id}.log`,
			content: [...logs, `finalExitCode=${exitCode ?? "null"}`, `jsonEvents=${parsedOutput?.jsonEvents ?? 0}`, parsedOutput?.usage ? `usage=${JSON.stringify(parsedOutput.usage)}` : "", "", "STDOUT:", finalStdout, "", "STDERR:", finalStderr].join("\n"),
			producer: task.id,
		});
		const successfulAttemptIndex = modelAttempts.findIndex((attempt) => attempt.success);
		const usedAttempt = successfulAttemptIndex === -1 ? Math.max(0, modelAttempts.length - 1) : successfulAttemptIndex;
		const resolvedModel = modelAttempts[usedAttempt]?.model ?? candidates[0] ?? "default";
		const fallbackReason = usedAttempt > 0 ? modelAttempts[usedAttempt - 1]?.error : undefined;
		task = { ...task, modelRouting: { requested: modelRoutingPlan.requested, resolved: resolvedModel, fallbackChain: candidates, reason: fallbackReason ?? modelRoutingPlan.reason, usedAttempt } };
		tasks = updateTask(tasks, task);
		const sessionUsage = parseSessionUsage(transcriptPath);
		const effectiveUsage = parsedOutput?.usage ?? sessionUsage;
		if (effectiveUsage) {
			parsedOutput = { ...(parsedOutput ?? { jsonEvents: 0, textEvents: [] }), usage: effectiveUsage };
			task = { ...task, usage: effectiveUsage, agentProgress: applyUsageToProgress(task.agentProgress, effectiveUsage) };
			tasks = updateTask(tasks, task);
			upsertCrewAgent(manifest, recordFromTask(manifest, task, "child-process"));
		}
		if (fs.existsSync(transcriptPath)) {
			transcriptArtifact = writeArtifact(manifest.artifactsRoot, {
				kind: "log",
				relativePath: `transcripts/${task.id}.jsonl`,
				content: fs.readFileSync(transcriptPath, "utf-8"),
				producer: task.id,
			});
		}
		task = { ...task, resultArtifact, ...(logArtifact ? { logArtifact } : {}), ...(transcriptArtifact ? { transcriptArtifact } : {}) };
		tasks = updateTask(tasks, task);
		({ task, tasks } = checkpointTask(manifest, tasks, task, "artifact-written"));
	} else if (runtimeKind === "live-session") {
		const { runLiveTask } = await import("./task-runner/live-executor.ts");
		const live = await runLiveTask({ manifest, tasks, task, step: input.step, agent: input.agent, prompt, signal: input.signal, runtimeConfig: input.runtimeConfig, parentContext: input.parentContext, parentModel: input.parentModel, modelRegistry: input.modelRegistry });
		task = live.task;
		tasks = live.tasks;
		startupEvidence = live.startupEvidence;
		exitCode = live.exitCode;
		error = live.error;
		parsedOutput = live.parsedOutput;
		resultArtifact = live.resultArtifact;
		logArtifact = live.logArtifact;
		transcriptArtifact = live.transcriptArtifact;
	} else {
		resultArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "result",
			relativePath: `results/${task.id}.md`,
			content: [
				`# ${task.id}`,
				"",
				"Worker execution is disabled in this scaffold-safe run.",
				"The prompt artifact contains the exact task that will be sent to a child Pi worker when execution is enabled.",
			].join("\n"),
			producer: task.id,
		});
	}

	const diffArtifact = workspace.worktreePath ? writeArtifact(manifest.artifactsRoot, {
		kind: "diff",
		relativePath: `diffs/${task.id}.diff`,
		content: captureWorktreeDiff(workspace.worktreePath),
		producer: task.id,
	}) : undefined;
	const diffStatArtifact = workspace.worktreePath ? writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.diff-stat.json`,
		content: `${JSON.stringify({ ...captureWorktreeDiffStat(workspace.worktreePath), syntheticPaths: workspace.syntheticPaths ?? [], nodeModulesLinked: workspace.nodeModulesLinked ?? false }, null, 2)}\n`,
		producer: task.id,
	}) : undefined;

	task = {
		...task,
		status: error ? "failed" : "completed",
		finishedAt: new Date().toISOString(),
		exitCode,
		modelAttempts,
		usage: parsedOutput?.usage,
		jsonEvents: parsedOutput?.jsonEvents,
		agentProgress: error && task.agentProgress?.currentTool ? { ...task.agentProgress, failedTool: task.agentProgress.currentTool } : task.agentProgress,
		error,
		verification: createVerificationEvidence(taskPacket.verification, !error, error ? `Task failed: ${error}` : runtimeKind === "scaffold" ? "Safe scaffold mode; verification commands were not executed." : `${runtimeKind} worker finished without reporting a verification failure.`),
		promptArtifact,
		resultArtifact,
		claim: undefined,
		heartbeat: touchWorkerHeartbeat(task.heartbeat ?? createWorkerHeartbeat(task.id), { alive: false }),
		...(logArtifact ? { logArtifact } : {}),
		...(transcriptArtifact ? { transcriptArtifact } : {}),
	};
	tasks = updateTask(tasks, task);
	const packetArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.task-packet.json`,
		content: `${JSON.stringify(task.taskPacket, null, 2)}\n`,
		producer: task.id,
	});
	const verificationArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.verification.json`,
		content: `${JSON.stringify(task.verification, null, 2)}\n`,
		producer: task.id,
	});
	const sharedOutputArtifact = writeTaskSharedOutput(manifest, input.step, task);
	const startupArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.startup-evidence.json`,
		content: `${JSON.stringify(startupEvidence, null, 2)}\n`,
		producer: task.id,
	});
	const permissionArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.permission.json`,
		content: `${JSON.stringify({ role: task.role, permissionMode }, null, 2)}\n`,
		producer: task.id,
	});
	manifest = { ...manifest, updatedAt: new Date().toISOString(), artifacts: [...manifest.artifacts, promptArtifact, resultArtifact, inputsArtifact, coordinationArtifact, packetArtifact, verificationArtifact, startupArtifact, permissionArtifact, ...(sharedOutputArtifact ? [sharedOutputArtifact] : []), ...(logArtifact ? [logArtifact] : []), ...(transcriptArtifact ? [transcriptArtifact] : []), ...(diffArtifact ? [diffArtifact] : []), ...(diffStatArtifact ? [diffStatArtifact] : [])] };
	saveRunManifest(manifest);
	tasks = persistSingleTaskUpdate(manifest, tasks, task);
	upsertCrewAgent(manifest, recordFromTask(manifest, task, runtimeKind));
	appendEvent(manifest.eventsPath, { type: error ? "task.failed" : "task.completed", runId: manifest.runId, taskId: task.id, message: error });
	return { manifest, tasks };
}

import * as fs from "node:fs";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewLimitsConfig, CrewRuntimeConfig } from "../config/config.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState, UsageState } from "../state/types.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { appendEvent } from "../state/event-log.ts";
import { saveRunManifest, saveRunTasks } from "../state/state-store.ts";
import { createTaskClaim } from "../state/task-claims.ts";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "./worker-heartbeat.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";
import { captureWorktreeDiff, captureWorktreeDiffStat, prepareTaskWorkspace } from "../worktree/worktree-manager.ts";
import { buildConfiguredModelCandidates, formatModelAttemptNote, isRetryableModelFailure, type ModelAttemptSummary } from "./model-fallback.ts";
import { parsePiJsonOutput, type ParsedPiJsonOutput } from "./pi-json-output.ts";
import { runChildPi } from "./child-pi.ts";
import { buildTaskPacket, renderTaskPacket } from "./task-packet.ts";
import { createVerificationEvidence } from "./green-contract.ts";
import { createStartupEvidence } from "./worker-startup.ts";
import { permissionForRole } from "./role-permission.ts";
import { collectDependencyOutputContext, renderDependencyOutputContext, writeTaskInputsArtifact, writeTaskSharedOutput } from "./task-output-context.ts";
import { appendCrewAgentEvent, appendCrewAgentOutput, emptyCrewAgentProgress, recordFromTask, upsertCrewAgent } from "./crew-agent-records.ts";
import { parseSessionUsage } from "./session-usage.ts";
import type { CrewAgentProgress, CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { buildMemoryBlock } from "./agent-memory.ts";
import { runLiveSessionTask } from "./live-session-runtime.ts";

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

function readOnlyRoleInstructions(role: string): string {
	if (permissionForRole(role) !== "read_only") return "";
	return [
		"# READ-ONLY ROLE CONTRACT",
		"You are running in READ-ONLY mode for this task.",
		"- Do not create, modify, delete, move, or copy files.",
		"- Do not use shell redirects, heredocs, in-place edits, package installs, git commit/merge/rebase/reset/checkout, or other state-mutating commands.",
		"- If implementation changes are needed, report exact recommendations instead of applying them.",
		"- Prefer read/grep/find/listing tools and read-only git inspection commands.",
	].join("\n");
}

function coordinationBridgeInstructions(task: TeamTaskState): string {
	return [
		"# Crew Coordination Channel",
		`Mailbox target for this task: ${task.id}`,
		"Use the run mailbox contract for coordination with the leader/orchestrator:",
		"- If blocked or uncertain, report the blocker in your final result and, when mailbox tools/API are available, send an inbox/outbox message addressed to the leader.",
		"- If nudged, answer with current status, blocker, or smallest next step.",
		"- Treat inherited/dependency context as reference-only; do not continue the parent conversation directly.",
		"- Completion handoff should include: DONE/FAILED, summary, changed/read files, verification evidence, and remaining risks.",
	].join("\n");
}

function renderTaskPrompt(manifest: TeamRunManifest, step: WorkflowStep, task: TeamTaskState, agent?: AgentConfig): string {
	const memoryBlock = agent?.memory ? buildMemoryBlock(agent.name, agent.memory, task.cwd, Boolean(agent.tools?.some((tool) => tool === "write" || tool === "edit"))) : "";
	return [
		"# pi-crew Worker Runtime Context",
		`Run ID: ${manifest.runId}`,
		`Team: ${manifest.team}`,
		`Workflow: ${manifest.workflow ?? "(none)"}`,
		`State root: ${manifest.stateRoot}`,
		`Artifacts root: ${manifest.artifactsRoot}`,
		`Events path: ${manifest.eventsPath}`,
		`Task ID: ${task.id}`,
		`Task cwd: ${task.cwd}`,
		`Workspace mode: ${manifest.workspaceMode}`,
		"",
		`Goal:\n${manifest.goal}`,
		"",
		`Step: ${step.id}`,
		`Role: ${step.role}`,
		"",
		"Protocol:",
		"- Stay within the task scope unless the prompt explicitly says otherwise.",
		"- Report blockers and verification evidence in the final result.",
		"- Do not claim completion without evidence.",
		"- Follow the Task Packet contract below; escalate if any contract field is impossible to satisfy.",
		"",
		readOnlyRoleInstructions(task.role),
		"",
		coordinationBridgeInstructions(task),
		"",
		task.taskPacket ? renderTaskPacket(task.taskPacket) : "",
		"",
		(inputDependencyContext(task) || ""),
		memoryBlock,
		"Task:",
		step.task.replaceAll("{goal}", manifest.goal),
	].join("\n");
}

function inputDependencyContext(task: TeamTaskState): string {
	return (task as TeamTaskState & { dependencyContextText?: string }).dependencyContextText ?? "";
}

function updateTask(tasks: TeamTaskState[], updated: TeamTaskState): TeamTaskState[] {
	return tasks.map((task) => task.id === updated.id ? updated : task);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textFromContent(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const text: string[] = [];
	for (const part of content) {
		const obj = asRecord(part);
		if (!obj) continue;
		if (obj.type === "text" && typeof obj.text === "string") text.push(obj.text);
		else if (typeof obj.content === "string") text.push(obj.content);
	}
	return text;
}

function eventText(event: unknown): string[] {
	const obj = asRecord(event);
	if (!obj) return [];
	const text: string[] = [];
	if (typeof obj.text === "string") text.push(obj.text);
	if (typeof obj.output === "string") text.push(obj.output);
	text.push(...textFromContent(obj.content));
	const message = asRecord(obj.message);
	if (message) text.push(...textFromContent(message.content));
	return text.filter((entry) => entry.trim());
}

function numberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function eventUsage(event: unknown): { input?: number; output?: number; turns?: number } | undefined {
	const obj = asRecord(event);
	if (!obj) return undefined;
	const direct = {
		input: numberField(obj, ["input", "inputTokens", "input_tokens"]),
		output: numberField(obj, ["output", "outputTokens", "output_tokens"]),
		turns: numberField(obj, ["turns", "turnCount", "turn_count"]),
	};
	if (Object.values(direct).some((value) => value !== undefined)) return direct;
	for (const key of ["usage", "tokenUsage", "tokens", "stats"]) {
		const nested = eventUsage(obj[key]);
		if (nested) return nested;
	}
	const message = asRecord(obj.message);
	return message ? eventUsage(message.usage) : undefined;
}

function previewArgs(args: unknown): string | undefined {
	if (!args) return undefined;
	try {
		const text = typeof args === "string" ? args : JSON.stringify(args);
		return text.length > 240 ? `${text.slice(0, 240)}…` : text;
	} catch {
		return undefined;
	}
}

function applyUsageToProgress(progress: CrewAgentProgress | undefined, usage: UsageState | undefined): CrewAgentProgress | undefined {
	if (!usage) return progress;
	const base = progress ?? emptyCrewAgentProgress();
	return {
		...base,
		tokens: (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
		turns: usage.turns ?? base.turns,
	};
}

function shouldFlushProgressEvent(event: unknown): boolean {
	const type = asRecord(event)?.type;
	return type === "tool_execution_start" || type === "tool_execution_end" || type === "message_end" || type === "tool_result_end";
}

function progressEventSummary(task: TeamTaskState, event: unknown): Record<string, unknown> {
	const type = asRecord(event)?.type;
	return {
		eventType: typeof type === "string" ? type : "event",
		currentTool: task.agentProgress?.currentTool,
		toolCount: task.agentProgress?.toolCount,
		tokens: task.agentProgress?.tokens,
		turns: task.agentProgress?.turns,
		activityState: task.agentProgress?.activityState,
		lastActivityAt: task.agentProgress?.lastActivityAt,
	};
}

function applyAgentProgressEvent(progress: CrewAgentProgress, event: unknown, startedAt: string | undefined): CrewAgentProgress {
	const obj = asRecord(event);
	const now = new Date().toISOString();
	const next: CrewAgentProgress = { ...progress, recentTools: [...progress.recentTools], recentOutput: [...progress.recentOutput], lastActivityAt: now, activityState: "active" };
	if (startedAt) next.durationMs = Date.now() - new Date(startedAt).getTime();
	if (obj?.type === "tool_execution_start") {
		next.toolCount += 1;
		next.currentTool = typeof obj.toolName === "string" ? obj.toolName : typeof obj.name === "string" ? obj.name : "tool";
		next.currentToolArgs = previewArgs(obj.args);
		next.currentToolStartedAt = now;
	}
	if (obj?.type === "tool_execution_end") {
		if (next.currentTool) next.recentTools.push({ tool: next.currentTool, args: next.currentToolArgs, endedAt: now });
		next.currentTool = undefined;
		next.currentToolArgs = undefined;
		next.currentToolStartedAt = undefined;
	}
	if ((obj?.type === "tool_execution_error" || obj?.type === "tool_execution_failed") && next.currentTool) {
		next.failedTool = next.currentTool;
	}
	const usage = eventUsage(event);
	if (usage) {
		next.tokens = (usage.input ?? 0) + (usage.output ?? 0);
		next.turns = usage.turns ?? next.turns;
	}
	const text = eventText(event);
	if (text.length > 0) next.recentOutput.push(...text.flatMap((entry) => entry.split(/\r?\n/)).filter(Boolean).slice(-10));
	if (next.recentTools.length > 25) next.recentTools.splice(0, next.recentTools.length - 25);
	if (next.recentOutput.length > 50) next.recentOutput.splice(0, next.recentOutput.length - 50);
	return next;
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
	saveRunTasks(manifest, tasks);
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
		const candidates = buildConfiguredModelCandidates({ overrideModel: input.modelOverride, stepModel: input.step.model, agentModel: input.agent.model, fallbackModels: input.agent.fallbackModels, parentModel: input.parentModel, modelRegistry: input.modelRegistry, cwd: manifest.cwd });
		const attemptModels = candidates.length > 0 ? candidates : [undefined];
		const logs: string[] = [];
		let finalStdout = "";
		let finalStderr = "";
		modelAttempts = [];
		const transcriptPath = `${manifest.artifactsRoot}/transcripts/${task.id}.jsonl`;
		let lastAgentRecordPersistedAt = 0;
		let lastRunProgressPersistedAt = 0;
		const persistChildProgress = (event: unknown, force = false): void => {
			const now = Date.now();
			if (force || shouldFlushProgressEvent(event) || now - lastAgentRecordPersistedAt >= 500) {
				upsertCrewAgent(manifest, recordFromTask(manifest, task, "child-process"));
				lastAgentRecordPersistedAt = now;
			}
			if (force || shouldFlushProgressEvent(event) || now - lastRunProgressPersistedAt >= 1000) {
				appendEvent(manifest.eventsPath, { type: "task.progress", runId: manifest.runId, taskId: task.id, data: progressEventSummary(task, event) });
				lastRunProgressPersistedAt = now;
			}
		};
		for (let i = 0; i < attemptModels.length; i++) {
			const model = attemptModels[i];
			const attemptStartedAt = new Date();
			const childResult = await runChildPi({
				cwd: task.cwd,
				task: prompt,
				agent: input.agent,
				model,
				signal: input.signal,
				transcriptPath,
				maxDepth: input.limits?.maxTaskDepth,
				onStdoutLine: (line) => appendCrewAgentOutput(manifest, task.id, line),
				onJsonEvent: (event) => {
					appendCrewAgentEvent(manifest, task.id, event);
					task = { ...task, agentProgress: applyAgentProgressEvent(task.agentProgress ?? emptyCrewAgentProgress(), event, task.startedAt) };
					tasks = updateTask(tasks, task);
					persistChildProgress(event);
				},
			});
			startupEvidence = createStartupEvidence({ command: "pi", startedAt: attemptStartedAt, finishedAt: new Date(), promptSentAt: attemptStartedAt, promptAccepted: childResult.exitCode === 0 && !childResult.error, stderr: childResult.stderr, error: childResult.error, exitCode: childResult.exitCode });
			exitCode = childResult.exitCode;
			finalStdout = childResult.stdout;
			finalStderr = childResult.stderr;
			parsedOutput = parsePiJsonOutput(childResult.stdout);
			error = childResult.error || (childResult.exitCode && childResult.exitCode !== 0 ? childResult.stderr || `Child Pi exited with ${childResult.exitCode}` : undefined);
			persistChildProgress({ type: "attempt_finished" }, true);
			const attempt: ModelAttemptSummary = { model: model ?? "default", success: !error, exitCode, error };
			modelAttempts.push(attempt);
			logs.push(`MODEL ATTEMPT ${i + 1}: ${attempt.model}`, `success=${attempt.success}`, `exitCode=${attempt.exitCode ?? "null"}`, attempt.error ? `error=${attempt.error}` : "", "");
			if (!error) break;
			const nextModel = attemptModels[i + 1];
			if (!nextModel || !isRetryableModelFailure(error)) break;
			logs.push(formatModelAttemptNote(attempt, nextModel), "");
		}
		resultArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "result",
			relativePath: `results/${task.id}.txt`,
			content: parsedOutput?.finalText || finalStdout || finalStderr || "(no output)",
			producer: task.id,
		});
		logArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "log",
			relativePath: `logs/${task.id}.log`,
			content: [...logs, `finalExitCode=${exitCode ?? "null"}`, `jsonEvents=${parsedOutput?.jsonEvents ?? 0}`, parsedOutput?.usage ? `usage=${JSON.stringify(parsedOutput.usage)}` : "", "", "STDOUT:", finalStdout, "", "STDERR:", finalStderr].join("\n"),
			producer: task.id,
		});
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
	} else if (runtimeKind === "live-session") {
		const transcriptPath = `${manifest.artifactsRoot}/transcripts/${task.id}.jsonl`;
		let lastAgentRecordPersistedAt = 0;
		let lastRunProgressPersistedAt = 0;
		const persistLiveProgress = (event: unknown, force = false): void => {
			const now = Date.now();
			if (force || shouldFlushProgressEvent(event) || now - lastAgentRecordPersistedAt >= 500) {
				upsertCrewAgent(manifest, recordFromTask(manifest, task, "live-session"));
				lastAgentRecordPersistedAt = now;
			}
			if (force || shouldFlushProgressEvent(event) || now - lastRunProgressPersistedAt >= 1000) {
				appendEvent(manifest.eventsPath, { type: "task.progress", runId: manifest.runId, taskId: task.id, data: progressEventSummary(task, event) });
				lastRunProgressPersistedAt = now;
			}
		};
		const attemptStartedAt = new Date();
		const liveResult = await runLiveSessionTask({
			manifest,
			task,
			step: input.step,
			agent: input.agent,
			prompt,
			signal: input.signal,
			transcriptPath,
			runtimeConfig: input.runtimeConfig,
			parentContext: input.parentContext,
			parentModel: input.parentModel,
			modelRegistry: input.modelRegistry,
			onOutput: (text) => appendCrewAgentOutput(manifest, task.id, text),
			onEvent: (event) => {
				appendCrewAgentEvent(manifest, task.id, event);
				task = { ...task, agentProgress: applyAgentProgressEvent(task.agentProgress ?? emptyCrewAgentProgress(), event, task.startedAt) };
				tasks = updateTask(tasks, task);
				persistLiveProgress(event);
			},
		});
		startupEvidence = createStartupEvidence({ command: "live-session", startedAt: attemptStartedAt, finishedAt: new Date(), promptSentAt: attemptStartedAt, promptAccepted: liveResult.exitCode === 0 && !liveResult.error, stderr: liveResult.stderr, error: liveResult.error, exitCode: liveResult.exitCode });
		exitCode = liveResult.exitCode;
		error = liveResult.error || (liveResult.exitCode && liveResult.exitCode !== 0 ? liveResult.stderr || `Live session exited with ${liveResult.exitCode}` : undefined);
		parsedOutput = { finalText: liveResult.stdout, textEvents: liveResult.stdout ? [liveResult.stdout] : [], jsonEvents: liveResult.jsonEvents, usage: liveResult.usage };
		if (liveResult.usage) task = { ...task, usage: liveResult.usage, agentProgress: applyUsageToProgress(task.agentProgress, liveResult.usage) };
		persistLiveProgress({ type: "attempt_finished" }, true);
		resultArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "result",
			relativePath: `results/${task.id}.txt`,
			content: liveResult.stdout || liveResult.stderr || "(no output)",
			producer: task.id,
		});
		logArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "log",
			relativePath: `logs/${task.id}.log`,
			content: [`runtime=live-session`, `finalExitCode=${exitCode ?? "null"}`, `jsonEvents=${liveResult.jsonEvents}`, liveResult.usage ? `usage=${JSON.stringify(liveResult.usage)}` : "", "", "STDOUT:", liveResult.stdout, "", "STDERR:", liveResult.stderr].join("\n"),
			producer: task.id,
		});
		if (fs.existsSync(transcriptPath)) {
			transcriptArtifact = writeArtifact(manifest.artifactsRoot, {
				kind: "log",
				relativePath: `transcripts/${task.id}.jsonl`,
				content: fs.readFileSync(transcriptPath, "utf-8"),
				producer: task.id,
			});
		}
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
	saveRunTasks(manifest, tasks);
	upsertCrewAgent(manifest, recordFromTask(manifest, task, runtimeKind));
	appendEvent(manifest.eventsPath, { type: error ? "task.failed" : "task.completed", runId: manifest.runId, taskId: task.id, message: error });
	return { manifest, tasks };
}

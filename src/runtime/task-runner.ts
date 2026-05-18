import * as fs from "node:fs";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewLimitsConfig, CrewRuntimeConfig } from "../config/config.ts";
import type { ArtifactDescriptor, OperationTerminalEvidence, TeamRunManifest, TeamTaskState, UsageState } from "../state/types.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { appendEvent, appendEventFireAndForget } from "../state/event-log.ts";
import { saveRunManifest } from "../state/state-store.ts";
import { createTaskClaim } from "../state/task-claims.ts";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "./worker-heartbeat.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";
import { captureWorktreeDiff, captureWorktreeDiffStat, prepareTaskWorkspace } from "../worktree/worktree-manager.ts";
import { buildConfiguredModelRouting, formatModelAttemptNote, isRetryableModelFailure, type ModelAttemptSummary } from "./model-fallback.ts";
import { parsePiJsonOutput, type ParsedPiJsonOutput } from "./pi-json-output.ts";
import { runChildPi, type ChildPiLifecycleEvent } from "./child-pi.ts";
import { buildTaskPacket } from "./task-packet.ts";
import { executeHook, appendHookEvent } from "../hooks/registry.ts";
import { createVerificationEvidence } from "./green-contract.ts";
import { createStartupEvidence } from "./worker-startup.ts";
import { permissionForRole } from "./role-permission.ts";
import { collectDependencyOutputContext, renderDependencyOutputContext, writeTaskInputsArtifact, writeTaskSharedOutput } from "./task-output-context.ts";
import { appendCrewAgentEvent, appendCrewAgentOutput, emptyCrewAgentProgress, recordFromTask, upsertCrewAgent } from "./crew-agent-records.ts";
import { reserveControlChannel } from "./agent-control.ts";
import { parseSessionUsage } from "./session-usage.ts";
import type { CrewAgentProgress, CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { shouldAppendProgressEventUpdate, type ProgressEventSummary } from "./progress-event-coalescer.ts";
import { coordinationBridgeInstructions, renderTaskPrompt } from "./task-runner/prompt-builder.ts";
import { buildWorkerPromptPipeline } from "./task-runner/prompt-pipeline.ts";
import { buildWorkerCapabilityInventory } from "./task-runner/capabilities.ts";
import { applyAgentProgressEvent, applyUsageToProgress, progressEventSummary, shouldFlushProgressEvent } from "./task-runner/progress.ts";
import { checkpointTask, persistSingleTaskUpdate, updateTask } from "./task-runner/state-helpers.ts";
import { cleanResultText, isFinalChildEvent } from "./task-runner/result-utils.ts";
import { evaluateCompletionMutationGuard } from "./completion-guard.ts";
import { cancellationReasonFromSignal, buildSyntheticTerminalEvidence } from "./cancellation.ts";
import { appendTaskAttentionEvent } from "./attention-events.ts";
import { parseSupervisorContactFromLine, recordSupervisorContact } from "./supervisor-contact.ts";
import { registerStreamBridge, bridgeEventFromJsonEvent } from "./event-stream-bridge.ts";
import { renderSkillInstructions } from "./skill-instructions.ts";
import { DEFAULT_YIELD_CONFIG, extractYieldResult, hasYieldInOutput, isYieldEvent, registerYieldTool, type YieldResult } from "./yield-handler.ts";
import { validateWorkerOutput, type OutputValidationResult } from "./output-validator.ts";

// Register the submit_result tool handler so subprocess events can extract yield data.
registerYieldTool();

export interface TaskRunnerInput {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	task: TeamTaskState;
	step: WorkflowStep;
	agent: AgentConfig;
	signal?: AbortSignal;
	executeWorkers: boolean;
	runtimeKind?: CrewRuntimeKind;
	/** Per-role runtime override resolved from isolation policy. Takes precedence over runtimeKind. */
	taskRuntimeOverride?: CrewRuntimeKind;
	runtimeConfig?: CrewRuntimeConfig;
	parentContext?: string;
	parentModel?: unknown;
	modelRegistry?: unknown;
	modelOverride?: string;
	teamRoleModel?: string;
	teamRoleSkills?: string[] | false;
	skillOverride?: string[] | false;
	limits?: CrewLimitsConfig;
	dependencyContextText?: string;
	skillBlock?: string;
	skillNames?: string[];
	skillPaths?: string[];
	/** Workspace where this task run was initiated — used for session-scoped live-agent visibility. */
	workspaceId: string;
	/** Optional callback for JSON events from child Pi. Used for overflow recovery tracking. */
	onJsonEvent?: (taskId: string, runId: string, event: unknown) => void;
}

export async function runTeamTask(input: TaskRunnerInput): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> {
	let manifest = input.manifest;
	// H4: registerStreamBridge inside try so dispose() in finally is safe
	let streamBridge: ReturnType<typeof registerStreamBridge> | undefined;
	try {
	streamBridge = registerStreamBridge(manifest.runId);
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
		// Reserve control channel before spawn so cancel/steer can target this task immediately
		controlReservation: reserveControlChannel(input.task.id, manifest.runId),
	} as TeamTaskState;
	let tasks = updateTask(input.tasks, task);
	const runtimeKind = input.taskRuntimeOverride ?? input.runtimeKind ?? (input.executeWorkers ? "child-process" : "scaffold");
	tasks = persistSingleTaskUpdate(manifest, tasks, task);
	if (runtimeKind === "child-process") ({ task, tasks } = checkpointTask(manifest, tasks, task, "started"));
	upsertCrewAgent(manifest, recordFromTask(manifest, task, runtimeKind));
	appendEvent(manifest.eventsPath, { type: "task.started", runId: manifest.runId, taskId: task.id, data: { role: task.role, agent: task.agent, runtime: runtimeKind, cwd: task.cwd, worktreePath: workspace.worktreePath, worktreeBranch: workspace.branch, worktreeReused: workspace.reused } });
	// Emit immediate UI notification so widget shows agent as "running" within ~100ms
	// instead of waiting for child process first JSON event (2-5s delay).
	streamBridge?.handler({ runId: manifest.runId, taskId: task.id, eventType: "task.started", timestamp: Date.now() });
	const permissionMode = permissionForRole(task.role);
	const renderedSkills = input.skillBlock === undefined ? renderSkillInstructions({ cwd: task.cwd, role: task.role, agent: input.agent, teamRole: { skills: input.teamRoleSkills }, step: input.step, override: input.skillOverride }) : undefined;
	const skillBlock = input.skillBlock ?? renderedSkills?.block;
	const skillNames = input.skillNames ?? renderedSkills?.names;
	const skillPaths = input.skillPaths ?? renderedSkills?.paths;

	const promptResult = await renderTaskPrompt(manifest, input.step, task, input.agent, skillBlock);
	const prompt = promptResult.full;
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
	let finalStdout = "";
	let transcriptPath: string | undefined;
	let terminalEvidence: OperationTerminalEvidence[] = [];
	const collectedJsonEvents: Record<string, unknown>[] = [];

	let startupEvidence = createStartupEvidence({ command: runtimeKind === "child-process" ? "pi" : runtimeKind === "live-session" ? "live-session" : "safe-scaffold", startedAt: new Date(task.startedAt ?? new Date().toISOString()), finishedAt: new Date(), promptSentAt: new Date(task.startedAt ?? new Date().toISOString()), promptAccepted: true, exitCode: 0 });
	const inputsArtifact = writeTaskInputsArtifact(manifest, task, dependencyContext);
	const skillArtifact = skillBlock ? writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.skills.md`,
		content: [`Selected skills: ${skillNames?.join(", ") ?? "(none)"}`, `Skill paths passed to child Pi: ${(skillPaths ?? []).length}`, "", skillBlock, ""].join("\n"),
		producer: task.id,
	}) : undefined;
	const coordinationArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.coordination-bridge.md`,
		content: `${coordinationBridgeInstructions(task)}\n`,
		producer: task.id,
	});
	if (runtimeKind === "child-process") {
		const modelRoutingPlan = buildConfiguredModelRouting({ overrideModel: input.modelOverride, stepModel: input.step.model, teamRoleModel: input.teamRoleModel, agentModel: input.agent.model, fallbackModels: input.agent.fallbackModels, parentModel: input.parentModel, modelRegistry: input.modelRegistry, cwd: task.cwd });
		const candidates = modelRoutingPlan.candidates;
		const attemptModels = candidates.length > 0 ? candidates : [undefined];
		const logs: string[] = [];
		let finalStderr = "";
		modelAttempts = [];
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
				// 2.2 caller migration: high-frequency task.progress goes through
				// the buffered path; loss-on-kill is acceptable because progress
				// is informational and re-derivable from per-agent records.
				appendEventFireAndForget(manifest.eventsPath, { type: "task.progress", runId: manifest.runId, taskId: task.id, data: { ...summary, coalesceReason: decision.reason } });
				lastRunProgressSummary = summary;
				lastRunProgressPersistedAt = now;
			}
		};
		for (let i = 0; i < attemptModels.length; i++) {
			// M1 fix: set transcript path per attempt to avoid mixing across fallback attempts.
			transcriptPath = `${manifest.artifactsRoot}/transcripts/${task.id}.attempt-${i}.jsonl`;
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
				skillPaths,
				onSpawn: (pid) => {
					({ task, tasks } = checkpointTask(manifest, tasks, task, "child-spawned", pid));
				},
				onLifecycleEvent: (event: ChildPiLifecycleEvent) => {
					appendEvent(manifest.eventsPath, { type: `worker.${event.type}` as const, runId: manifest.runId, taskId: task.id, message: `Worker lifecycle: ${event.type}${event.error ? ` error=${event.error}` : ""}${event.exitCode != null ? ` exit=${event.exitCode}` : ""}`, data: { ...event } });
				},
				onStdoutLine: (line) => {
					appendCrewAgentOutput(manifest, task.id, line);
					persistHeartbeat();
					// Check for supervisor contact requests from child Pi
					const contact = parseSupervisorContactFromLine(line);
					if (contact) {
						recordSupervisorContact(manifest, { runId: manifest.runId, ...contact });
					}
				},
				onJsonEvent: (event) => {
					appendCrewAgentEvent(manifest, task.id, event);
					if (event && typeof event === "object" && !Array.isArray(event)) collectedJsonEvents.push(event as Record<string, unknown>);
					persistHeartbeat();
					task = { ...task, agentProgress: applyAgentProgressEvent(task.agentProgress ?? emptyCrewAgentProgress(), event, task.startedAt) };
					tasks = updateTask(tasks, task);
					// Bridge event to UI event bus for near-instant updates
					try {
						const bridgeEvent = bridgeEventFromJsonEvent(manifest.runId, task.id, event);
						if (bridgeEvent) streamBridge?.handler(bridgeEvent);
					} catch { /* bridge errors should not affect task */ }
					// Feed overflow recovery tracker
					if (input.onJsonEvent) {
						try {
							input.onJsonEvent(task.id, manifest.runId, event);
						} catch { /* overflow tracking errors should not affect task */ }
					}
					if (!finalCheckpointWritten && isFinalChildEvent(event)) {
						finalCheckpointWritten = true;
						({ task, tasks } = checkpointTask(manifest, tasks, task, "child-stdout-final"));
					}
					persistChildProgress(event);
				},
			});
			const evidenceStatus = childResult.exitStatus?.cancelled ? "cancelled" : childResult.error || (childResult.exitCode && childResult.exitCode !== 0) ? "failed" : "completed";
			terminalEvidence = [...terminalEvidence, { operation: "worker", status: evidenceStatus, startedAt: attemptStartedAt.toISOString(), finishedAt: new Date().toISOString(), ...(input.signal?.aborted ? { reason: cancellationReasonFromSignal(input.signal) } : {}), ...(childResult.exitStatus ? { exitStatus: childResult.exitStatus } : {}) }];
			if (evidenceStatus === "cancelled") {
				const cancelReason = input.signal?.aborted ? cancellationReasonFromSignal(input.signal) : { code: "caller_cancelled" as const, message: "Worker cancelled." };
				terminalEvidence.push(buildSyntheticTerminalEvidence("tool", cancelReason, attemptStartedAt.toISOString()));
				appendEvent(manifest.eventsPath, { type: "worker.cancelled", runId: manifest.runId, taskId: task.id, message: cancelReason.message, data: { terminalEvidence: terminalEvidence.at(-1) } });
			}
			startupEvidence = createStartupEvidence({ command: "pi", startedAt: attemptStartedAt, finishedAt: new Date(), promptSentAt: attemptStartedAt, promptAccepted: childResult.exitCode === 0 && !childResult.error, stderr: childResult.stderr, error: childResult.error, exitCode: childResult.exitCode });
			exitCode = childResult.exitCode;
			finalStdout = childResult.stdout;
			finalStderr = childResult.stderr;
				// Cap transcript read to MAX_TRANSCRIPT_BYTES to avoid OOM on huge transcripts.
			const MAX_TRANSCRIPT_PARSE_BYTES = 5 * 1024 * 1024;
			let transcriptText = '';
			if (fs.existsSync(transcriptPath)) {
				const stat = fs.statSync(transcriptPath);
				if (stat.size > MAX_TRANSCRIPT_PARSE_BYTES) {
					const fd = fs.openSync(transcriptPath, 'r');
					try {
						const buf = Buffer.alloc(MAX_TRANSCRIPT_PARSE_BYTES);
						const bytesRead = fs.readSync(fd, buf, 0, MAX_TRANSCRIPT_PARSE_BYTES, stat.size - MAX_TRANSCRIPT_PARSE_BYTES);
						const raw = buf.slice(0, bytesRead).toString('utf-8');
						const firstNewline = raw.indexOf('\n');
						transcriptText = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
					} finally { fs.closeSync(fd); }
				} else {
					transcriptText = fs.readFileSync(transcriptPath, 'utf-8');
				}
			} else {
				transcriptText = childResult.stdout;
			}
			parsedOutput = parsePiJsonOutput(transcriptText);
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
		// Use the last attempt's transcript for session usage.
		const sessionUsage = parseSessionUsage(transcriptPath ?? `${manifest.artifactsRoot}/transcripts/${task.id}.attempt-${usedAttempt}.jsonl`);
		const effectiveUsage = parsedOutput?.usage ?? sessionUsage;
		if (effectiveUsage) {
			parsedOutput = { ...(parsedOutput ?? { jsonEvents: 0, textEvents: [] }), usage: effectiveUsage };
			task = { ...task, usage: effectiveUsage, agentProgress: applyUsageToProgress(task.agentProgress, effectiveUsage) };
			tasks = updateTask(tasks, task);
			upsertCrewAgent(manifest, recordFromTask(manifest, task, "child-process"));
		}
		// M2 fix: use attempt-relative path; cap content at MAX_TRANSCRIPT_ARTIFACT_BYTES.
		const MAX_TRANSCRIPT_ARTIFACT_BYTES = 5 * 1024 * 1024; // 5MB cap
		const attemptTranscriptPath = `${manifest.artifactsRoot}/transcripts/${task.id}.attempt-${usedAttempt}.jsonl`;
		let transcriptContent = '';
		if (fs.existsSync(attemptTranscriptPath)) {
			const stat = fs.statSync(attemptTranscriptPath);
			if (stat.size > MAX_TRANSCRIPT_ARTIFACT_BYTES) {
				const fd = fs.openSync(attemptTranscriptPath, 'r');
				try {
					const buf = Buffer.alloc(MAX_TRANSCRIPT_ARTIFACT_BYTES);
					const bytesRead = fs.readSync(fd, buf, 0, MAX_TRANSCRIPT_ARTIFACT_BYTES, stat.size - MAX_TRANSCRIPT_ARTIFACT_BYTES);
					// NEW-3 fix: snap to nearest newline to avoid partial JSONL line.
					const raw = buf.slice(0, bytesRead).toString('utf-8');
					const firstNewline = raw.indexOf('\n');
					transcriptContent = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
				} finally { fs.closeSync(fd); }
			} else {
				transcriptContent = fs.readFileSync(attemptTranscriptPath, 'utf-8');
			}
			transcriptArtifact = writeArtifact(manifest.artifactsRoot, {
				kind: "log",
				relativePath: `transcripts/${task.id}.attempt-${usedAttempt}.jsonl`,
				content: transcriptContent,
				producer: task.id,
			});
		}
		task = { ...task, resultArtifact, ...(logArtifact ? { logArtifact } : {}), ...(transcriptArtifact ? { transcriptArtifact } : {}) };
		tasks = updateTask(tasks, task);
		({ task, tasks } = checkpointTask(manifest, tasks, task, "artifact-written"));
	} else if (runtimeKind === "live-session") {
		// LAZY: live-executor is only needed for live-session runtime branches.
		const { runLiveTask } = await import("./task-runner/live-executor.ts");
		const live = await runLiveTask({ manifest, tasks, task, step: input.step, agent: input.agent, prompt, signal: input.signal, runtimeConfig: input.runtimeConfig, parentContext: input.parentContext, parentModel: input.parentModel, modelRegistry: input.modelRegistry, modelOverride: input.modelOverride, teamRoleModel: input.teamRoleModel, workspaceId: input.workspaceId });
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

	// --- Yield-based completion contract ---
	// _yieldResult: preserved for future use — yield completion contract not yet wired to task.result
	let _yieldResult: YieldResult | undefined;
	const yieldEnabled = input.runtimeConfig?.yield?.enabled ?? DEFAULT_YIELD_CONFIG.enabled;
	if (yieldEnabled && collectedJsonEvents.length > 0) {
		if (hasYieldInOutput(collectedJsonEvents)) {
			const yieldEvent = collectedJsonEvents.find((e) => isYieldEvent(e));
			if (yieldEvent) {
				_yieldResult = extractYieldResult(yieldEvent);
			}
		} else if (!error) {
			appendEvent(manifest.eventsPath, { type: "task.attention", runId: manifest.runId, taskId: task.id, message: "Worker completed without calling submit_result tool.", data: { activityState: "needs_attention", reason: "no_yield" } });
		}
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

	const mutationGuardMode = input.runtimeConfig?.completionMutationGuard ?? "warn";
	const mutationGuard = !error && mutationGuardMode !== "off" ? evaluateCompletionMutationGuard({ role: task.role, taskText: `${task.title}\n${input.step.task}`, transcriptPath: runtimeKind === "child-process" ? transcriptPath : transcriptArtifact?.path, stdout: finalStdout }) : undefined;
	if (mutationGuard?.reason === "no_mutation_observed") {
		appendTaskAttentionEvent({
			manifest,
			taskId: task.id,
			message: "Implementation-style task completed without an observed mutation tool call.",
			data: { activityState: "needs_attention", reason: "completion_guard", taskId: task.id, agentName: task.agent, observedTools: mutationGuard.observedTools, suggestedAction: mutationGuardMode === "fail" ? "Review the worker output and rerun with a concrete implementation task." : "Review the worker output; set runtime.completionMutationGuard='fail' to enforce this." },
		});
		task = { ...task, agentProgress: { ...(task.agentProgress ?? emptyCrewAgentProgress()), activityState: "needs_attention" } };
		if (mutationGuardMode === "fail") {
			error = "Completion mutation guard failed: implementation-style task completed without an observed mutation tool call.";
			exitCode = exitCode === 0 ? 1 : exitCode;
			if (modelAttempts?.length) {
				modelAttempts = modelAttempts.map((attempt, index) => index === modelAttempts!.length - 1 ? { ...attempt, success: false, exitCode, error } : attempt);
			}
		}
		tasks = updateTask(tasks, task);
	}

	// --- Output format validation (caveman Phase 4) ---
	// Validate worker output against the role's output contract.
	// On failure: emit attention event but don't fail the task.
	let outputValidation: OutputValidationResult | undefined;
	if (!error) {
		const outputText = parsedOutput?.finalText ?? finalStdout;
		if (outputText) {
			outputValidation = validateWorkerOutput(task.role, outputText);
			if (!outputValidation.valid) {
				appendEvent(manifest.eventsPath, { type: "task.output_validation", runId: manifest.runId, taskId: task.id, data: { valid: false, formatMatch: outputValidation.formatMatch, structurePreserved: outputValidation.structurePreserved, issues: outputValidation.issues } });
				task = { ...task, agentProgress: { ...(task.agentProgress ?? emptyCrewAgentProgress()), activityState: "needs_attention" } };
				tasks = updateTask(tasks, task);
			}
		}
	}

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
		workerExitStatus: terminalEvidence.at(-1)?.exitStatus,
		terminalEvidence: terminalEvidence.length ? [...(task.terminalEvidence ?? []), ...terminalEvidence] : task.terminalEvidence,
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
	const capabilityArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.capabilities.json`,
		content: `${JSON.stringify(buildWorkerCapabilityInventory({ taskId: task.id, role: task.role, agent: input.agent, runtime: runtimeKind, permissionMode, skillNames, skillPaths, skillsDisabled: input.skillOverride === false || input.teamRoleSkills === false, modelOverride: input.modelOverride, teamRoleModel: input.teamRoleModel, stepModel: input.step.model }), null, 2)}\n`,
		producer: task.id,
	});
	const promptPipelineArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.prompt-pipeline.json`,
		content: `${JSON.stringify(buildWorkerPromptPipeline({ artifactsRoot: manifest.artifactsRoot, taskId: task.id, promptArtifact, inputsArtifact, skillArtifact, capabilityArtifact, coordinationArtifact, skillInstructionCount: skillNames?.length ?? 0, skillsDisabled: input.skillOverride === false || input.teamRoleSkills === false }), null, 2)}\n`,
		producer: task.id,
	});
	const outputValidationArtifact = outputValidation ? writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.output-validation.json`,
		content: `${JSON.stringify(outputValidation, null, 2)}\n`,
		producer: task.id,
	}) : undefined;
	manifest = { ...manifest, updatedAt: new Date().toISOString(), artifacts: [...manifest.artifacts, promptArtifact, resultArtifact, inputsArtifact, coordinationArtifact, ...(skillArtifact ? [skillArtifact] : []), packetArtifact, verificationArtifact, startupArtifact, permissionArtifact, capabilityArtifact, promptPipelineArtifact, ...(outputValidationArtifact ? [outputValidationArtifact] : []), ...(sharedOutputArtifact ? [sharedOutputArtifact] : []), ...(logArtifact ? [logArtifact] : []), ...(transcriptArtifact ? [transcriptArtifact] : []), ...(diffArtifact ? [diffArtifact] : []), ...(diffStatArtifact ? [diffStatArtifact] : [])] };
	saveRunManifest(manifest);
	tasks = persistSingleTaskUpdate(manifest, tasks, task);
	upsertCrewAgent(manifest, recordFromTask(manifest, task, runtimeKind));
	// Execute task_result hook before emitting terminal event
	const hookReport = await executeHook("task_result", { runId: manifest.runId, taskId: task.id, cwd: manifest.cwd });
	appendHookEvent(manifest, hookReport);
	appendEvent(manifest.eventsPath, { type: error ? "task.failed" : "task.completed", runId: manifest.runId, taskId: task.id, message: error });
	return { manifest, tasks };
	} finally {
		streamBridge?.dispose();
	}
}

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewLimitsConfig, CrewRuntimeConfig } from "../config/config.ts";
import { loadConfig } from "../config/config.ts";
import { errors } from "../errors.ts";
import { appendHookEvent, executeHook } from "../hooks/registry.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { appendEventAsync, appendEventBuffered, appendEventFireAndForget } from "../state/event-log.ts";
import { withRunLock } from "../state/locks.ts";
import { saveRunManifestAsync } from "../state/state-store.ts";
import { createTaskClaim } from "../state/task-claims.ts";
import type {
	ArtifactDescriptor,
	OperationTerminalEvidence,
	TeamRunManifest,
	TeamTaskState,
	UsageState,
	VerificationEvidence,
} from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { resolveContainedPath, resolveRealContainedPath } from "../utils/safe-paths.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";
import { captureWorktreeDiffAsync, captureWorktreeDiffStatAsync, prepareTaskWorkspaceAsync } from "../worktree/worktree-manager.ts";
import { reserveControlChannel } from "./agent-control.ts";
import { appendTaskAttentionEvent } from "./attention-events.ts";
import { buildSyntheticTerminalEvidence, cancellationReasonFromSignal } from "./cancellation.ts";
import { type ChildPiLifecycleEvent, runChildPi } from "./child-pi.ts";
import { extractCommandTrace } from "./command-trace.ts";
import { evaluateCompletionMutationGuard } from "./completion-guard.ts";
import {
	appendCrewAgentEvent,
	appendCrewAgentOutput,
	emptyCrewAgentProgress,
	recordFromTask,
	upsertCrewAgent,
} from "./crew-agent-records.ts";
import type { CrewAgentProgress, CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { crewHooks } from "./crew-hooks.ts";
import { bridgeEventFromJsonEvent, registerStreamBridge } from "./event-stream-bridge.ts";
import { createVerificationEvidence } from "./green-contract.ts";
import {
	buildConfiguredModelRouting,
	formatModelAttemptNote,
	isRetryableModelFailure,
	type ModelAttemptSummary,
} from "./model-fallback.ts";
import { readEnabledModelsPatterns } from "./model-scope.ts";
import { type OutputValidationResult, validateWorkerOutput } from "./output-validator.ts";
import { type ParsedPiJsonOutput, parsePiJsonOutput } from "./pi-json-output.ts";
import { type ProgressEventSummary, shouldAppendProgressEventUpdate } from "./progress-event-coalescer.ts";
import { permissionForRole } from "./role-permission.ts";
import { awaitRuntimeWarmup } from "./runtime-warmup.ts";
import { parseSessionUsage } from "./session-usage.ts";
import { renderSkillInstructions } from "./skill-instructions.ts";
import { parseSupervisorContactFromLine, recordSupervisorContact } from "./supervisor-contact.ts";
import {
	collectDependencyOutputContext,
	renderDependencyOutputContext,
	writeTaskInputsArtifact,
	writeTaskSharedOutput,
} from "./task-output-context.ts";
import { buildTaskPacket } from "./task-packet.ts";
import { buildWorkerCapabilityInventory } from "./task-runner/capabilities.ts";
import { applyAgentProgressEvent, applyUsageToProgress, progressEventSummary, shouldFlushProgressEvent } from "./task-runner/progress.ts";
import { coordinationBridgeInstructions, renderTaskPrompt } from "./task-runner/prompt-builder.ts";
import { buildWorkerPromptPipeline } from "./task-runner/prompt-pipeline.ts";
import { cleanResultText, isFinalChildEvent } from "./task-runner/result-utils.ts";
import { checkpointTask, persistSingleTaskUpdate, updateTask } from "./task-runner/state-helpers.ts";
import { tailReadWithLineSnap } from "./task-runner/tail-read.ts";
import { computeGreenLevelFromResults, executeVerificationCommands } from "./verification-gates.ts";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "./worker-heartbeat.ts";
import { createStartupEvidence } from "./worker-startup.ts";
import {
	DEFAULT_YIELD_CONFIG,
	extractYieldResult,
	hasYieldInOutput,
	isYieldEvent,
	registerYieldTool,
	type YieldResult,
} from "./yield-handler.ts";

// Register the submit_result tool handler so subprocess events can extract yield data.
registerYieldTool();

/** Async helper for writing steering events — fire-and-forget for non-blocking writes. */
async function appendSteeringAsync(steeringDir: string, taskId: string, steers: string[]): Promise<void> {
	try {
		await fs.promises.mkdir(steeringDir, { recursive: true });
		const steeringPath = resolveContainedPath(steeringDir, `${taskId}.jsonl`);
		const lines = steers
			.map(
				(msg) =>
					JSON.stringify({
						type: "steer",
						message: msg,
						ts: new Date().toISOString(),
					}) + "\n",
			)
			.join("");
		await fs.promises.appendFile(steeringPath, lines, "utf-8");
	} catch (error) {
		logInternalError("task-runner.steering-write-failed", error as Error, `taskId=${taskId}`);
	}
}

/** Async helper for writing background logs — fire-and-forget for non-blocking writes. */
async function appendBackgroundLogAsync(bgLogPath: string, eventLine: string): Promise<void> {
	try {
		await fs.promises.appendFile(bgLogPath, `${eventLine}\n`, "utf-8");
	} catch (error) {
		logInternalError("task-runner.background-log-write-failed", error as Error, `path=${bgLogPath}`);
	}
}

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
	// Cold-start race fix: ensure the hot module graph is warm before touching
	// any module. Under tsx, concurrent first-imports race module-record
	// instantiation; awaiting the registration-time warmup eliminates the window.
	await awaitRuntimeWarmup();
	let manifest = input.manifest;
	// H4: registerStreamBridge inside try so dispose() in finally is safe
	let streamBridge: ReturnType<typeof registerStreamBridge> | undefined;
	try {
		streamBridge = registerStreamBridge(manifest.runId);
		const workspace = await prepareTaskWorkspaceAsync(manifest, input.task, input.step.seedPaths);
		const worktree =
			workspace.worktreePath && workspace.branch
				? {
						path: workspace.worktreePath,
						branch: workspace.branch,
						reused: workspace.reused ?? false,
					}
				: input.task.worktree;
		const taskPacket = buildTaskPacket({
			manifest,
			step: input.step,
			taskId: input.task.id,
			cwd: workspace.cwd,
			worktreePath: worktree?.path,
		});
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
			// Lifetime usage accumulator — survives compaction unlike session.stats
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
			...(dependencyContextText ? { dependencyContextText } : {}),
			// Reserve control channel before spawn so cancel/steer can target this task immediately
			controlReservation: reserveControlChannel(input.task.id, manifest.runId),
		} as TeamTaskState;
		let tasks = updateTask(input.tasks, task);
		const runtimeKind = input.taskRuntimeOverride ?? input.runtimeKind ?? (input.executeWorkers ? "child-process" : "scaffold");
		// A1-F7: Pre-compute whether yield-event collection is needed. For child-process
		// workers (the common case) this is always false, so we skip allocating/accumulating
		// collectedJsonEvents entirely — eliminating ~10KB memory waste per task.
		const collectYieldEvents = runtimeKind !== "child-process" && (input.runtimeConfig?.yield?.enabled ?? DEFAULT_YIELD_CONFIG.enabled);
		// FIX: Check signal before persisting state — if cancelled, skip the write.
		if (input.signal?.aborted) {
			const cancelReason = cancellationReasonFromSignal(input.signal);
			const cancelledTask: TeamTaskState = {
				...task,
				status: "cancelled",
				error: `${cancelReason.code}: ${cancelReason.message}`,
				finishedAt: new Date().toISOString(),
			};
			return {
				manifest: input.manifest,
				tasks: updateTask(tasks, cancelledTask),
			};
		}
		tasks = persistSingleTaskUpdate(manifest, tasks, task, "started");
		if (runtimeKind === "child-process") ({ task, tasks } = checkpointTask(manifest, tasks, task, "started"));
		upsertCrewAgent(manifest, recordFromTask(manifest, task, runtimeKind));
		await appendEventAsync(manifest.eventsPath, {
			type: "task.started",
			runId: manifest.runId,
			taskId: task.id,
			data: {
				role: task.role,
				agent: task.agent,
				runtime: runtimeKind,
				cwd: task.cwd,
				worktreePath: workspace.worktreePath,
				worktreeBranch: workspace.branch,
				worktreeReused: workspace.reused,
			},
		});
		// Emit immediate UI notification so widget shows agent as "running" within ~100ms
		// instead of waiting for child process first JSON event (2-5s delay).
		streamBridge?.handler({
			runId: manifest.runId,
			taskId: task.id,
			eventType: "task.started",
			timestamp: Date.now(),
		});
		const permissionMode = permissionForRole(task.role);
		const renderedSkills =
			input.skillBlock === undefined
				? renderSkillInstructions({
						cwd: task.cwd,
						role: task.role,
						agent: input.agent,
						teamRole: { skills: input.teamRoleSkills },
						step: input.step,
						override: input.skillOverride,
						runId: manifest.runId,
					})
				: undefined;
		const skillBlock = input.skillBlock ?? renderedSkills?.block;
		const skillNames = input.skillNames ?? renderedSkills?.names;
		const skillPaths = input.skillPaths ?? renderedSkills?.paths;

		// Deterministic pre-step: run script, inject stdout into worker prompt
		let preStepOutput: string | undefined;
		if (input.step.preStepScript) {
			const scriptTimeout = input.step.preStepTimeout ?? 30_000;
			const scriptArgs = input.step.preStepArgs ?? [];
			appendEventFireAndForget(manifest.eventsPath, {
				type: "hook.pre_step_started",
				runId: manifest.runId,
				taskId: task.id,
				data: { script: input.step.preStepScript, argCount: scriptArgs.length, timeoutMs: scriptTimeout },
			});
			// SECURITY (M-1 fix, code-review 2026-06-23): use the project's safe-path
			// primitive instead of a hand-rolled path.resolve + startsWith check.
			// The lexical check passed a symlinked ancestor, letting execFileSync
			// follow it and execute a script outside cwd. Throws on escape.
			// Keep validation outside the optional-execution catch: preStepOptional
			// must never bypass a path-containment failure.
			resolveRealContainedPath(manifest.cwd, input.step.preStepScript);
			try {
				// LAZY: defer dynamic import of node:child_process to its call site.
				const { execFileSync } = await import("node:child_process");
				preStepOutput = execFileSync(input.step.preStepScript, scriptArgs, {
					timeout: scriptTimeout,
					encoding: "utf-8",
					cwd: manifest.cwd,
					maxBuffer: 1024 * 1024, // 1MB cap
				});
				appendEventFireAndForget(manifest.eventsPath, {
					type: "hook.pre_step_completed",
					runId: manifest.runId,
					taskId: task.id,
					data: { script: input.step.preStepScript, outputBytes: Buffer.byteLength(preStepOutput, "utf8") },
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const exitCode = (err as NodeJS.ErrnoException & { status?: number }).status;
				appendEventFireAndForget(manifest.eventsPath, {
					type: "hook.pre_step_failed",
					runId: manifest.runId,
					taskId: task.id,
					message: `pre-step hook failed (exit ${exitCode ?? "?"})`,
					data: { script: input.step.preStepScript, exitCode: exitCode ?? null, optional: input.step.preStepOptional === true },
				});
				// E1 (Round 15): structured CrewError with code E009 + help hint,
				// instead of a raw Error. Surfaces the script path, exit code, and stderr.
				// Round 21 (E4): if preStepOptional is set, a failing hook is NON-FATAL.
				// Log a warning + emit a 'warning' event, then proceed without the
				// pre-step output rather than aborting the task (advisory hooks).
				if (input.step.preStepOptional) {
					const warnMsg = `[preStepOptional] pre-step hook '${input.step.preStepScript}' failed (exit ${exitCode ?? "?"}) but preStepOptional=true; continuing without its output.`;
					try {
						appendEventFireAndForget(manifest.eventsPath, {
							type: "hook.pre_step_optional_failed",
							runId: manifest.runId,
							taskId: task.id,
							message: warnMsg,
							data: {
								script: input.step.preStepScript,
								exitCode: exitCode ?? null,
							},
						});
					} catch {
						/* best-effort event log */
					}
					preStepOutput = undefined;
				} else {
					throw errors.preStepFailed(input.step.preStepScript, exitCode, msg);
				}
			}
		}

		const promptResult = await renderTaskPrompt(manifest, input.step, task, input.agent, skillBlock);
		let prompt = promptResult.full;

		// Inject deterministic pre-step output into prompt
		if (preStepOutput) {
			prompt +=
				"\n\n---\n## Pre-Step Script Output\n\nThe following data was produced by a pre-step script. Use it as context for your task:\n\n<output>\n" +
				preStepOutput +
				"\n</output>\n";
		}
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
		let rawFinalText: string | undefined;
		let intermediateFindings: string | undefined;
		let finalStdout = "";
		let transcriptPath: string | undefined;
		let terminalEvidence: OperationTerminalEvidence[] = [];
		const collectedJsonEvents: Record<string, unknown>[] | undefined = collectYieldEvents ? [] : undefined;

		let startupEvidence = createStartupEvidence({
			command: runtimeKind === "child-process" ? "pi" : runtimeKind === "live-session" ? "live-session" : "safe-scaffold",
			startedAt: new Date(task.startedAt ?? new Date().toISOString()),
			finishedAt: new Date(),
			promptSentAt: new Date(task.startedAt ?? new Date().toISOString()),
			promptAccepted: true,
			exitCode: 0,
		});
		const inputsArtifact = writeTaskInputsArtifact(manifest, task, dependencyContext);
		const skillArtifact = skillBlock
			? writeArtifact(manifest.artifactsRoot, {
					kind: "metadata",
					relativePath: `metadata/${task.id}.skills.md`,
					content: [
						`Selected skills: ${skillNames?.join(", ") ?? "(none)"}`,
						`Skill paths passed to child Pi: ${(skillPaths ?? []).length}`,
						"",
						skillBlock,
						"",
					].join("\n"),
					producer: task.id,
				})
			: undefined;
		const coordinationArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "metadata",
			relativePath: `metadata/${task.id}.coordination-bridge.md`,
			content: `${coordinationBridgeInstructions(task)}\n`,
			producer: task.id,
		});
		if (runtimeKind === "child-process") {
			const modelRoutingPlan = buildConfiguredModelRouting({
				overrideModel: input.modelOverride,
				stepModel: input.step.model,
				teamRoleModel: input.teamRoleModel,
				agentModel: input.agent.model,
				fallbackModels: input.agent.fallbackModels,
				parentModel: input.parentModel,
				modelRegistry: input.modelRegistry,
				cwd: task.cwd,
				scopeModelsPatterns: await resolveTaskScopeModelsPatterns(task.cwd),
			});
			const candidates = modelRoutingPlan.candidates;
			const attemptModels = candidates.length > 0 ? candidates : [undefined];
			const logs: string[] = [];
			let finalStderr = "";
			modelAttempts = [];
			let finalCheckpointWritten = false;
			let lastAgentRecordPersistedAt = 0;
			let lastHeartbeatPersistedAt = 0;
			let lastRunProgressPersistedAt = 0;
			let lastTaskProgressPersistedAt = 0;
			let lastRunProgressSummary: ProgressEventSummary | undefined;
			const persistHeartbeat = (force = false): void => {
				const now = Date.now();
				// Skip disk write if throttled (unless forced).
				if (!force && now - lastHeartbeatPersistedAt < 1000) return;
				try {
					// Write to disk first, then update in-memory.
					// Disk state is always <= in-memory state, so a crash never produces
					// a fresher in-memory heartbeat than what's on disk. This prevents the
					// stale reconciler from seeing a live heartbeat paired with stale task state
					// (which could cause false zombie detection).
					tasks = persistSingleTaskUpdate(manifest, tasks, task);
				} catch (err) {
					// Run state may have been deleted by prune/forget/cleanup.
					// This is not fatal — the run is gone, no point persisting.
					if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
					throw err;
				}
				// Now update in-memory heartbeat so it is always >= persisted state.
				task = {
					...task,
					heartbeat: touchWorkerHeartbeat(task.heartbeat ?? createWorkerHeartbeat(task.id)),
				};
				lastHeartbeatPersistedAt = now;
			};
			const persistChildProgress = (event: unknown, force = false): void => {
				const now = Date.now();
				if (force || shouldFlushProgressEvent(event) || now - lastAgentRecordPersistedAt >= 500) {
					upsertCrewAgent(manifest, recordFromTask(manifest, task, "child-process"));
					lastAgentRecordPersistedAt = now;
				}
				const summary = progressEventSummary(task, event);
				const decision = shouldAppendProgressEventUpdate({
					previous: lastRunProgressSummary,
					next: summary,
					nowMs: now,
					lastAppendMs: lastRunProgressPersistedAt || undefined,
					minIntervalMs: 1000,
					force,
				});
				if (decision.shouldAppend) {
					// 2.2 caller migration: high-frequency task.progress goes through
					// the buffered path (M7 wire); loss-on-kill is acceptable because progress
					// is informational and re-derivable from per-agent records.
					// appendEventBuffered coalesces into a single lock acquire after bufferMs,
					// reducing producer p95 from ~13µs (serial) to ~0µs (bench M7).
					void appendEventBuffered(manifest.eventsPath, {
						type: "task.progress",
						runId: manifest.runId,
						taskId: task.id,
						data: { ...summary, coalesceReason: decision.reason },
					});
					lastRunProgressSummary = summary;
					lastRunProgressPersistedAt = now;
				}
			};
			for (let i = 0; i < attemptModels.length; i++) {
				// M1 fix: set transcript path per attempt to avoid mixing across fallback attempts.
				transcriptPath = `${manifest.artifactsRoot}/transcripts/${task.id}.attempt-${i}.jsonl`;
				// Ensure transcripts/ subdirectory exists before child-pi appends
				// to it. appendTranscript uses O_APPEND (no mkdir) for security,
				// so the caller must create the directory.
				await fs.promises.mkdir(path.join(manifest.artifactsRoot, "transcripts"), {
					recursive: true,
				});
				const model = attemptModels[i];
				const attemptStartedAt = new Date();
				const pendingAttempt: ModelAttemptSummary = {
					model: model ?? "default",
					success: false,
				};
				task = {
					...task,
					modelAttempts: [...modelAttempts, pendingAttempt],
				};
				tasks = updateTask(tasks, task);
				crewHooks.emit({
					type: "task_started",
					timestamp: new Date().toISOString(),
					runId: manifest.runId,
					taskId: task.id,
					data: { role: task.role, model: model ?? "default" },
				});
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
					maxTurns: input.runtimeConfig?.maxTurns,
					graceTurns: input.runtimeConfig?.graceTurns,
					inheritContext: input.runtimeConfig?.inheritContext,
					parentContext: input.parentContext,
					excludeContextBash: input.runtimeConfig?.excludeContextBash,
					sessionId: manifest.sessionId,
					role: task.role,
					runId: manifest.runId,
					agentId: task.id,
					artifactsRoot: manifest.artifactsRoot,
					steeringFile: resolveContainedPath(`${manifest.artifactsRoot}/steering`, `${task.id}.jsonl`),
					onSpawn: (pid) => {
						try {
							({ task, tasks } = checkpointTask(manifest, tasks, task, "child-spawned", pid));
							if (task.pendingSteers?.length) {
								const steeringDir = `${manifest.artifactsRoot}/steering`;
								// Fire-and-forget async write for steering events
								void appendSteeringAsync(steeringDir, task.id, task.pendingSteers);
								task.pendingSteers = [];
								tasks = persistSingleTaskUpdate(manifest, tasks, task);
							}
						} catch (err) {
							logInternalError("task-runner.on-spawn", err as Error, `pid=${pid}, taskId=${task.id}`);
						}
					},
					onLifecycleEvent: (event: ChildPiLifecycleEvent) => {
						void appendEventAsync(manifest.eventsPath, {
							type: `worker.${event.type}` as const,
							runId: manifest.runId,
							taskId: task.id,
							message: `Worker lifecycle: ${event.type}${event.error ? ` error=${event.error}` : ""}${event.exitCode != null ? ` exit=${event.exitCode}` : ""}`,
							data: { ...event },
						}).catch((error) =>
							logInternalError("task-runner.lifecycle-event", error, `taskId=${task.id}, type=${event.type}`),
						);
					},
					onStdoutLine: (line) => {
						appendCrewAgentOutput(manifest, task.id, line);
						persistHeartbeat();
						// Check for supervisor contact requests from child Pi
						const contact = parseSupervisorContactFromLine(line);
						if (contact) {
							recordSupervisorContact(manifest, {
								runId: manifest.runId,
								...contact,
							});
						}
					},
					onJsonEvent: (event) => {
						// Top-level error boundary: prevent any single event from crashing the task.
						// Errors are logged but processing continues so subsequent events still update state.
						try {
							appendCrewAgentEvent(manifest, task.id, event);
							if (collectedJsonEvents && event && typeof event === "object" && !Array.isArray(event))
								collectedJsonEvents.push(event as Record<string, unknown>);
							if (collectedJsonEvents && collectedJsonEvents.length > 1000) {
								collectedJsonEvents.splice(0, collectedJsonEvents.length - 1000);
							}
							// Accumulate lifetime usage via message_end events (survives compaction)
							if (event && typeof event === "object" && (event as Record<string, unknown>).type === "message_end") {
								const msg = (event as Record<string, unknown>).message as Record<string, unknown> | undefined;
								if (msg?.role === "assistant") {
									const usage = msg.usage as Record<string, number> | undefined;
									if (usage) {
										task.lifetimeUsage = {
											input: (task.lifetimeUsage?.input ?? 0) + (usage.input ?? 0),
											output: (task.lifetimeUsage?.output ?? 0) + (usage.output ?? 0),
											cacheWrite: (task.lifetimeUsage?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
										};
									}
								}
							}
							persistHeartbeat();
							// Bug #3 fix: Write worker JSON events to background.log for debugging when running in background mode.
							// This supplements the event log so developers can see what the child Pi worker produced.
							if (process.env.PI_CREW_BACKGROUND_MODE === "1" && event) {
								const bgLogPath = `${manifest.stateRoot}/background.log`;
								const eventLine =
									typeof event === "object" && !Array.isArray(event) ? JSON.stringify(event) : String(event);
								// Fire-and-forget async write for background log
								void appendBackgroundLogAsync(bgLogPath, eventLine);
							}
							// Always keep in-memory agentProgress fresh (cheap) so the UI/events see
							// the latest progress, but THROTTLE the disk persist. Previously this
							// did a full locked read-parse-write of tasks.json on EVERY child JSON
							// event — a 200-event task produced 200 such cycles (Round 15 P1).
							// Final state is force-flushed on task completion (persistHeartbeat(true)).
							const nextProgress = applyAgentProgressEvent(
								task.agentProgress ?? emptyCrewAgentProgress(),
								event,
								task.startedAt,
							);
							task = { ...task, agentProgress: nextProgress };
							tasks = updateTask(tasks, task);
							const progressNow = Date.now();
							if (progressNow - lastTaskProgressPersistedAt >= 500) {
								tasks = persistSingleTaskUpdate(manifest, tasks, task);
								lastTaskProgressPersistedAt = progressNow;
							}
							// Bridge event to UI event bus for near-instant updates
							const bridgeEvent = bridgeEventFromJsonEvent(manifest.runId, task.id, event);
							if (bridgeEvent) streamBridge?.handler(bridgeEvent);
							// Feed overflow recovery tracker
							if (input.onJsonEvent) {
								input.onJsonEvent(task.id, manifest.runId, event);
							}
							if (!finalCheckpointWritten && isFinalChildEvent(event)) {
								finalCheckpointWritten = true;
								({ task, tasks } = checkpointTask(manifest, tasks, task, "child-stdout-final"));
							}
							persistChildProgress(event);
						} catch (err) {
							logInternalError("task-runner.on-json-event", err as Error, `taskId=${task.id}`);
						}
					},
				});
				const evidenceStatus = childResult.exitStatus?.cancelled
					? "cancelled"
					: childResult.error || (childResult.exitCode && childResult.exitCode !== 0)
						? "failed"
						: "completed";
				terminalEvidence = [
					...terminalEvidence,
					{
						operation: "worker",
						status: evidenceStatus,
						startedAt: attemptStartedAt.toISOString(),
						finishedAt: new Date().toISOString(),
						...(input.signal?.aborted
							? {
									reason: cancellationReasonFromSignal(input.signal),
								}
							: {}),
						...(childResult.exitStatus ? { exitStatus: childResult.exitStatus } : {}),
					},
				];
				if (evidenceStatus === "cancelled") {
					const cancelReason = input.signal?.aborted
						? cancellationReasonFromSignal(input.signal)
						: {
								code: "caller_cancelled" as const,
								message: "Worker cancelled.",
							};
					terminalEvidence.push(buildSyntheticTerminalEvidence("tool", cancelReason, attemptStartedAt.toISOString()));
					await appendEventAsync(manifest.eventsPath, {
						type: "worker.cancelled",
						runId: manifest.runId,
						taskId: task.id,
						message: cancelReason.message,
						data: { terminalEvidence: terminalEvidence.at(-1) },
					});
				}
				startupEvidence = createStartupEvidence({
					command: "pi",
					startedAt: attemptStartedAt,
					finishedAt: new Date(),
					promptSentAt: attemptStartedAt,
					promptAccepted: childResult.exitCode === 0 && !childResult.error,
					stderr: childResult.stderr,
					error: childResult.error,
					exitCode: childResult.exitCode,
				});
				exitCode = childResult.exitCode;
				finalStdout = childResult.stdout;
				finalStderr = childResult.stderr;
				// Cap transcript read to MAX_TRANSCRIPT_BYTES to avoid OOM on huge transcripts.
				const MAX_TRANSCRIPT_PARSE_BYTES = 5 * 1024 * 1024;
				const transcriptText = tailReadWithLineSnap(transcriptPath, MAX_TRANSCRIPT_PARSE_BYTES, childResult.stdout);
				parsedOutput = parsePiJsonOutput(transcriptText);
				rawFinalText = childResult.rawFinalText;
				intermediateFindings = childResult.intermediateFindings;
				error =
					childResult.error ||
					(childResult.exitCode && childResult.exitCode !== 0
						? childResult.stderr || `Child Pi exited with ${childResult.exitCode}`
						: undefined);
				// E1/E7 (Round 15): when the child timed out, surface a structured
				// CrewError (E007) so users get a code + actionable help hint instead
				// of a bare 'no new output for N ms'. We keep .message as the task error.
				if (childResult.exitStatus?.timedOut) {
					error = errors.childTimeout({
						taskId: task.id,
						stderr: childResult.stderr,
					}).message;
				}
				// 429/rate-limit fix (PI_CREW_TOOLING_429_NOTE.md): a worker can exit
				// code 0 with NO hard error, but the transcript is full of
				// `message_end` events with `errorMessage: "429 ... overloaded"` and
				// empty content. The model never produced a tool call, so the worker
				// "completed" without doing anything. Detect this: if no error was set
				// above AND the parsed output carries a retryable model-failure message
				// AND there is no real output text, surface it as an error so the
				// model-fallback chain can retry on another model.
				if (!error && parsedOutput) {
					const rateLimitErr = detectRetryableModelFailureFromOutput(parsedOutput);
					if (rateLimitErr) error = rateLimitErr;
				}
				persistHeartbeat(true);
				persistChildProgress({ type: "attempt_finished" }, true);
				const attempt: ModelAttemptSummary = {
					model: model ?? "default",
					success: !error,
					exitCode,
					error,
				};
				modelAttempts.push(attempt);
				task = { ...task, modelAttempts: [...modelAttempts] };
				tasks = updateTask(tasks, task);
				logs.push(
					`MODEL ATTEMPT ${i + 1}: ${attempt.model}`,
					`success=${attempt.success}`,
					`exitCode=${attempt.exitCode ?? "null"}`,
					attempt.error ? `error=${attempt.error}` : "",
					"",
				);
				if (!error) break;
				let nextModel = attemptModels[i + 1];
				// FIX 1 (task packet 01_01-agent): when the precomputed attempt
				// chain is exhausted but the failure is retryable, do a one-shot
				// re-resolve via buildConfiguredModelRouting with the failed
				// model as parent. This finds alternative providers/models the
				// original chain missed (e.g. a registry gained new fallbacks
				// after the precompute, or the precompute ran before the parent
				// model was known). If a different candidate is found, use it as
				// nextModel; otherwise fall through to the existing break.
				if (!nextModel && isRetryableModelFailure(error)) {
					const reResolved = buildConfiguredModelRouting({
						overrideModel: undefined,
						stepModel: undefined,
						teamRoleModel: undefined,
						agentModel: undefined,
						fallbackModels: undefined,
						parentModel: attempt.model,
						modelRegistry: input.modelRegistry,
						cwd: task.cwd,
						scopeModelsPatterns: await resolveTaskScopeModelsPatterns(task.cwd),
					});
					const alt = reResolved.candidates.find((c) => c !== attempt.model);
					if (alt) nextModel = alt;
				}
				if (!nextModel || !isRetryableModelFailure(error)) break;
				logs.push(formatModelAttemptNote(attempt, nextModel), "");
			}
			// E2 (Round 15): when the fallback chain was used and STILL failed, surface
			// that explicitly. Without this the task error only shows the last
			// attempt's raw failure, so users can't tell whether to fix an API key,
			// upgrade a plan, or change the model config. Include the chain tried +
			// the final reason.
			if (error && modelAttempts.length > 1) {
				// E2/E1 (Round 15): structured CrewError (E008). Build via the factory so
				// the error carries a code + help hint; keep its .message as the task error.
				error = errors.modelExhausted(
					modelAttempts.map((a) => a.model),
					error,
				).message;
			}
			// NEW-8 fix: register all attempt transcripts as artifacts, not just the used one.
			// Earlier failed attempts' transcripts exist on disk but were invisible to the artifact system.
			const successfulAttemptIndex = modelAttempts.findIndex((attempt) => attempt.success);
			const usedAttempt = successfulAttemptIndex === -1 ? Math.max(0, modelAttempts.length - 1) : successfulAttemptIndex;
			for (let attemptIdx = 0; attemptIdx < modelAttempts.length; attemptIdx++) {
				if (attemptIdx === usedAttempt) continue;
				const tPath = `${manifest.artifactsRoot}/transcripts/${task.id}.attempt-${attemptIdx}.jsonl`;
				if (!fs.existsSync(tPath)) continue;
				const MAX_ATTEMPT_TRANSCRIPT = 5 * 1024 * 1024;
				const tContent = tailReadWithLineSnap(tPath, MAX_ATTEMPT_TRANSCRIPT, "");
				if (tContent) {
					writeArtifact(manifest.artifactsRoot, {
						kind: "log",
						relativePath: `transcripts/${task.id}.attempt-${attemptIdx}.jsonl`,
						content: tContent,
						producer: task.id,
					});
				}
			}
			resultArtifact = writeArtifact(manifest.artifactsRoot, {
				kind: "result",
				relativePath: `results/${task.id}.txt`,
				content:
					// Prefer the RAW (uncapped) final assistant text captured before the
					// transcript's 16K compaction — this is the authoritative worker output.
					// Fall back to transcript-derived finalText, then stdout/stderr, so a
					// missing raw capture (mock/error path) never yields empty/garbage.
					cleanResultText(rawFinalText) ??
					cleanResultText(parsedOutput?.finalText) ??
					cleanResultText(finalStdout) ??
					cleanResultText(finalStderr) ??
					// #7 hardening: if all real output paths are empty (worker exhausted
					// budget on tool calls, no assistant text), use intermediate findings.
					// intermediateFindings captures the last N tool-result display lines.
					cleanResultText(intermediateFindings) ??
					"(no output)",
				producer: task.id,
			});
			logArtifact = writeArtifact(manifest.artifactsRoot, {
				kind: "log",
				relativePath: `logs/${task.id}.log`,
				content: [
					...logs,
					`finalExitCode=${exitCode ?? "null"}`,
					`jsonEvents=${parsedOutput?.jsonEvents ?? 0}`,
					parsedOutput?.usage ? `usage=${JSON.stringify(parsedOutput.usage)}` : "",
					"",
					"STDOUT:",
					finalStdout,
					"",
					"STDERR:",
					finalStderr,
				].join("\n"),
				producer: task.id,
			});
			const resolvedModel = modelAttempts[usedAttempt]?.model ?? candidates[0] ?? "default";
			const fallbackReason = usedAttempt > 0 ? modelAttempts[usedAttempt - 1]?.error : undefined;
			task = {
				...task,
				modelRouting: {
					requested: modelRoutingPlan.requested,
					resolved: resolvedModel,
					fallbackChain: candidates,
					reason: fallbackReason ?? modelRoutingPlan.reason,
					usedAttempt,
				},
			};
			tasks = updateTask(tasks, task);
			// Use the last attempt's transcript for session usage.
			// Safety net: transcriptPath may be undefined in edge cases (e.g., early exit before loop).
			// In practice it is always set inside the for loop above.
			const attemptFallback = `${manifest.artifactsRoot}/transcripts/${task.id}.attempt-${usedAttempt}.jsonl`;
			const sessionUsage = parseSessionUsage(transcriptPath ?? attemptFallback);
			const effectiveUsage = parsedOutput?.usage ?? sessionUsage;
			if (effectiveUsage) {
				parsedOutput = {
					...(parsedOutput ?? { jsonEvents: 0, textEvents: [] }),
					usage: effectiveUsage,
				};
				task = {
					...task,
					usage: effectiveUsage,
					agentProgress: applyUsageToProgress(task.agentProgress, effectiveUsage),
				};
				tasks = updateTask(tasks, task);
				upsertCrewAgent(manifest, recordFromTask(manifest, task, "child-process"));
			}
			// M2 fix: use attempt-relative path; cap content at MAX_TRANSCRIPT_ARTIFACT_BYTES.
			const MAX_TRANSCRIPT_ARTIFACT_BYTES = 5 * 1024 * 1024; // 5MB cap
			const attemptTranscriptPath = `${manifest.artifactsRoot}/transcripts/${task.id}.attempt-${usedAttempt}.jsonl`;
			const transcriptContent = tailReadWithLineSnap(attemptTranscriptPath, MAX_TRANSCRIPT_ARTIFACT_BYTES, "");
			if (transcriptContent) {
				transcriptArtifact = writeArtifact(manifest.artifactsRoot, {
					kind: "log",
					relativePath: `transcripts/${task.id}.attempt-${usedAttempt}.jsonl`,
					content: transcriptContent,
					producer: task.id,
				});
			}
			task = {
				...task,
				resultArtifact,
				...(logArtifact ? { logArtifact } : {}),
				...(transcriptArtifact ? { transcriptArtifact } : {}),
			};
			tasks = updateTask(tasks, task);
			({ task, tasks } = checkpointTask(manifest, tasks, task, "artifact-written"));
		} else if (runtimeKind === "live-session") {
			// LAZY: live-executor is only needed for live-session runtime branches.
			const { runLiveTask } = await import("./task-runner/live-executor.ts");
			const live = await runLiveTask({
				manifest,
				tasks,
				task,
				step: input.step,
				agent: input.agent,
				prompt,
				signal: input.signal,
				runtimeConfig: input.runtimeConfig,
				parentContext: input.parentContext,
				parentModel: input.parentModel,
				modelRegistry: input.modelRegistry,
				modelOverride: input.modelOverride,
				teamRoleModel: input.teamRoleModel,
				workspaceId: input.workspaceId,
			});
			task = live.task;
			tasks = live.tasks;
			startupEvidence = live.startupEvidence;
			exitCode = live.exitCode;
			error = live.error;
			parsedOutput = live.parsedOutput;
			// Bug #21 fix: live-session may not produce structured output via submit_result,
			// leaving finalText empty. Re-write resultArtifact with parsedOutput.finalText
			// so downstream tasks that depend on this task can read meaningful output.
			const liveText = cleanResultText(parsedOutput?.finalText);
			if (liveText) {
				// Re-write the artifact with the captured stdout — this is the content
				// downstream tasks will read via task.resultArtifact.path.
				resultArtifact = writeArtifact(manifest.artifactsRoot, {
					kind: "result",
					relativePath: `results/${task.id}.txt`,
					content: liveText,
					producer: task.id,
				});
			} else {
				resultArtifact = live.resultArtifact;
			}
			// Sync task.resultArtifact with the re-written artifact (if liveText was truthy)
			task = { ...task, resultArtifact };
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
		let noYield = false;
		// Child-process workers do not have a submit_result tool — the yield contract
		// only applies to live-session workers where submit_result is injected by the
		// runtime. Skipping yield detection for child-process prevents every child
		// worker from incorrectly being marked needs_attention.
		const yieldEnabled = collectYieldEvents;
		if (yieldEnabled && collectedJsonEvents && collectedJsonEvents.length > 0) {
			if (hasYieldInOutput(collectedJsonEvents)) {
				const yieldEvent = collectedJsonEvents.find((e) => isYieldEvent(e));
				if (yieldEvent) {
					_yieldResult = extractYieldResult(yieldEvent);
				}
			} else if (!error) {
				noYield = true;
				await appendEventAsync(manifest.eventsPath, {
					type: "task.needs_attention",
					runId: manifest.runId,
					taskId: task.id,
					message: "Worker completed without calling submit_result tool.",
					data: {
						activityState: "needs_attention",
						reason: "no_yield",
						// Bug #21 fix: include result path so downstream tasks can read the output
						resultPath: resultArtifact?.path,
					},
				});
			}
		}

		const diffArtifact = workspace.worktreePath
			? writeArtifact(manifest.artifactsRoot, {
					kind: "diff",
					relativePath: `diffs/${task.id}.diff`,
					content: await captureWorktreeDiffAsync(workspace.worktreePath),
					producer: task.id,
				})
			: undefined;
		const diffStatArtifact = workspace.worktreePath
			? writeArtifact(manifest.artifactsRoot, {
					kind: "metadata",
					relativePath: `metadata/${task.id}.diff-stat.json`,
					content: `${JSON.stringify({ ...(await captureWorktreeDiffStatAsync(workspace.worktreePath)), syntheticPaths: workspace.syntheticPaths ?? [], nodeModulesLinked: workspace.nodeModulesLinked ?? false }, null, 2)}\n`,
					producer: task.id,
				})
			: undefined;

		// Capture unified patches from edit tool results
		const patchArtifact = parsedOutput?.patches?.length
			? writeArtifact(manifest.artifactsRoot, {
					kind: "patch",
					relativePath: `patches/${task.id}.patch`,
					content: parsedOutput.patches.join("\n---\n"),
					producer: task.id,
				})
			: undefined;

		const mutationGuardMode = input.runtimeConfig?.completionMutationGuard ?? "warn";
		const mutationGuard =
			!error && mutationGuardMode !== "off"
				? evaluateCompletionMutationGuard({
						role: task.role,
						taskText: `${task.title}\n${input.step.task}`,
						transcriptPath: runtimeKind === "child-process" ? transcriptPath : transcriptArtifact?.path,
						stdout: finalStdout,
					})
				: undefined;
		if (mutationGuard?.reason === "no_mutation_observed") {
			appendTaskAttentionEvent({
				manifest,
				taskId: task.id,
				message: "Implementation-style task completed without an observed mutation tool call.",
				data: {
					activityState: "needs_attention",
					reason: "completion_guard",
					taskId: task.id,
					agentName: task.agent,
					observedTools: mutationGuard.observedTools,
					suggestedAction:
						mutationGuardMode === "fail"
							? "Review the worker output and rerun with a concrete implementation task."
							: "Review the worker output; set runtime.completionMutationGuard='fail' to enforce this.",
				},
			});
			task = {
				...task,
				agentProgress: {
					...(task.agentProgress ?? emptyCrewAgentProgress()),
					activityState: "needs_attention",
				},
			};
			if (mutationGuardMode === "fail") {
				error = "Completion mutation guard failed: implementation-style task completed without an observed mutation tool call.";
				exitCode = exitCode === 0 ? 1 : exitCode;
				if (modelAttempts?.length) {
					modelAttempts = modelAttempts.map((attempt, index) =>
						index === modelAttempts!.length - 1 ? { ...attempt, success: false, exitCode, error } : attempt,
					);
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
					await appendEventAsync(manifest.eventsPath, {
						type: "task.output_validation",
						runId: manifest.runId,
						taskId: task.id,
						data: {
							valid: false,
							formatMatch: outputValidation.formatMatch,
							structurePreserved: outputValidation.structurePreserved,
							issues: outputValidation.issues,
						},
					});
					task = {
						...task,
						agentProgress: {
							...(task.agentProgress ?? emptyCrewAgentProgress()),
							activityState: "needs_attention",
						},
					};
					tasks = updateTask(tasks, task);
				}
			}
		}

		// --- ECC VERIFICATION_LOOP: Compute verification evidence before building task object ---
		// Compute verification evidence (may be async if verification commands need to run)
		const baseEvidence = createVerificationEvidence(
			taskPacket.verification,
			!error,
			error
				? `Task failed: ${error}`
				: runtimeKind === "scaffold"
					? "Safe scaffold mode; verification commands were not executed."
					: `${runtimeKind} worker finished without reporting a verification failure.`,
		);

		// Only execute verification commands when:
		// 1. Task completed successfully (no error)
		// 2. Verification contract has commands
		// 3. Not in scaffold mode (scaffold mode intentionally skips execution)
		let verificationEvidence: VerificationEvidence = baseEvidence;
		if (runtimeKind !== "scaffold" && taskPacket.verification?.commands?.length) {
			try {
				const commandResults = await executeVerificationCommands(
					taskPacket.verification,
					task.cwd,
					manifest.runId,
					task.id,
					manifest.artifactsRoot,
					input.signal,
				);

				// Compute observed green level from results
				const observedGreenLevel = computeGreenLevelFromResults(commandResults, taskPacket.verification.requiredGreenLevel);

				// Determine satisfaction based on green level
				const requiredLevel = taskPacket.verification.requiredGreenLevel;
				const satisfied =
					observedGreenLevel === "none"
						? false
						: observedGreenLevel === "targeted"
							? requiredLevel === "targeted"
							: observedGreenLevel === "package"
								? ["targeted", "package"].includes(requiredLevel)
								: observedGreenLevel === "workspace"
									? ["targeted", "package", "workspace"].includes(requiredLevel)
									: observedGreenLevel === "merge_ready";

				const allPassed = commandResults.every((r) => r.status === "passed");
				const failedCount = commandResults.filter((r) => r.status === "failed").length;

				verificationEvidence = {
					requiredGreenLevel: taskPacket.verification.requiredGreenLevel,
					observedGreenLevel,
					satisfied: satisfied && allPassed,
					commands: commandResults,
					notes: allPassed
						? `${commandResults.length} verification commands passed`
						: `${failedCount}/${commandResults.length} verification commands failed`,
				};
			} catch (execError) {
				// On execution error, return base evidence with error note
				verificationEvidence = {
					...baseEvidence,
					notes: `Verification execution failed: ${execError instanceof Error ? execError.message : String(execError)}`,
				};
			}
		}

		task = {
			...task,
			status: error ? "failed" : noYield ? "needs_attention" : "completed",
			finishedAt: new Date().toISOString(),
			exitCode,
			modelAttempts,
			usage: parsedOutput?.usage,
			jsonEvents: parsedOutput?.jsonEvents,
			agentProgress:
				error && task.agentProgress?.currentTool
					? {
							...task.agentProgress,
							failedTool: task.agentProgress.currentTool,
						}
					: task.agentProgress,
			error,
			verification: verificationEvidence,
			resultArtifact,
			claim: undefined,
			heartbeat: touchWorkerHeartbeat(task.heartbeat ?? createWorkerHeartbeat(task.id), { alive: false }),
			workerExitStatus: terminalEvidence.at(-1)?.exitStatus,
			terminalEvidence: terminalEvidence.length ? [...(task.terminalEvidence ?? []), ...terminalEvidence] : task.terminalEvidence,
			...(logArtifact ? { logArtifact } : {}),
			...(transcriptArtifact ? { transcriptArtifact } : {}),
		};
		tasks = updateTask(tasks, task);

		// Emit task completion hooks (100% reliable, fire-and-forget)
		const hookType = task.status === "completed" ? "task_completed" : task.status === "failed" ? "task_failed" : "task_started";
		// T10: attach the VERBATIM command trace (mechanically derived from
		// recorded tool-call history, never from the worker's self-report) so
		// event viewers + the orchestrator see exactly which commands ran.
		const commandTrace = extractCommandTrace(task.agentProgress?.recentTools);
		crewHooks.emit({
			type: hookType,
			timestamp: task.finishedAt ?? new Date().toISOString(),
			runId: manifest.runId,
			taskId: task.id,
			data: {
				status: task.status,
				role: task.role,
				error: task.error,
				exitCode: task.exitCode,
				usage: task.usage,
				commandTrace,
			},
		});

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
		const outputValidationArtifact = outputValidation
			? writeArtifact(manifest.artifactsRoot, {
					kind: "metadata",
					relativePath: `metadata/${task.id}.output-validation.json`,
					content: `${JSON.stringify(outputValidation, null, 2)}\n`,
					producer: task.id,
				})
			: undefined;
		manifest = {
			...manifest,
			updatedAt: new Date().toISOString(),
			artifacts: [
				...manifest.artifacts,
				promptArtifact,
				resultArtifact,
				inputsArtifact,
				coordinationArtifact,
				...(skillArtifact ? [skillArtifact] : []),
				packetArtifact,
				verificationArtifact,
				startupArtifact,
				permissionArtifact,
				capabilityArtifact,
				promptPipelineArtifact,
				...(outputValidationArtifact ? [outputValidationArtifact] : []),
				...(sharedOutputArtifact ? [sharedOutputArtifact] : []),
				...(logArtifact ? [logArtifact] : []),
				...(transcriptArtifact ? [transcriptArtifact] : []),
				...(diffArtifact ? [diffArtifact] : []),
				...(diffStatArtifact ? [diffStatArtifact] : []),
				...(patchArtifact ? [patchArtifact] : []),
			],
		};
		// NEW-C3: persist manifest + tasks atomically under the run lock. Without this,
		// the unlocked saveRunManifest here races with the team-runner batch merge path
		// (which writes the manifest under withRunLock) — a parallel batch could read a
		// stale manifest and overwrite this task's freshly-written artifacts, silently
		// losing them. persistSingleTaskUpdate is re-entrance-safe (runLockHeldByUs guard),
		// so nesting it inside this lock is a no-op re-acquire, not a deadlock.
		tasks = await withRunLock(manifest, async () => {
			await saveRunManifestAsync(manifest);
			return persistSingleTaskUpdate(manifest, tasks, task);
		});
		upsertCrewAgent(manifest, recordFromTask(manifest, task, runtimeKind));
		// Execute task_result hook before emitting terminal event
		const hookReport = await executeHook("task_result", {
			runId: manifest.runId,
			taskId: task.id,
			cwd: manifest.cwd,
		});
		appendHookEvent(manifest, hookReport);
		await appendEventAsync(manifest.eventsPath, {
			type: error ? "task.failed" : noYield ? "task.needs_attention" : "task.completed",
			runId: manifest.runId,
			taskId: task.id,
			message: error,
		});

		// Execute after_task_complete lifecycle hook (non-blocking)
		const afterTaskReport = await executeHook("after_task_complete", {
			runId: manifest.runId,
			taskId: task.id,
			cwd: manifest.cwd,
			status: error ? "failed" : noYield ? "needs_attention" : "completed",
		});
		appendHookEvent(manifest, afterTaskReport);

		return { manifest, tasks };
	} finally {
		streamBridge?.dispose();
	}
}

/**
 * F7: resolve the enabledModels allowlist for the child-process spawn path,
 * but only if `runtime.reliability.scopeModels` is ON. Returns [] (no-op)
 * when the toggle is off or the allowlist is empty. Best-effort: any failure
 * to read config or the allowlist silently disables the gate so spawn is
 * never blocked by a misconfiguration.
 */
async function resolveTaskScopeModelsPatterns(cwd: string): Promise<string[]> {
	let scopeModels = false;
	try {
		scopeModels = loadConfig(cwd).config.reliability?.scopeModels === true;
	} catch {
		return [];
	}
	if (!scopeModels) return [];
	return readEnabledModelsPatterns(cwd);
}

/**
 * 429/rate-limit detection (PI_CREW_TOOLING_429_NOTE.md).
 *
 * A worker can exit code 0 with no hard error, yet the transcript is full of
 * `message_end` events carrying `errorMessage: "429 ... overloaded"` (or any
 * retryable model-failure pattern) and empty content arrays. The model never
 * produced a tool call, so the worker "completed" without doing anything.
 *
 * This helper inspects a ParsedPiJsonOutput and, if the run produced only
 * retryable model-failure messages AND no real output text (no finalText, no
 * text events, no patches), returns a surfaced error string so the
 * model-fallback chain (isRetryableModelFailure) can retry on another model.
 * Returns undefined when the run has real output (the 429s were recovered from)
 * or when there are no retryable error messages.
 */
export function detectRetryableModelFailureFromOutput(parsed: ParsedPiJsonOutput): string | undefined {
	// Primary signal: pre-extracted `errorMessages` (from pi-json-output parser).
	// The parser already filters to non-empty trimmed strings from message_end
	// events.
	const messages = parsed.errorMessages;
	if (messages && messages.length > 0) {
		// Find the first retryable model-failure message
		// (429 / rate-limit / overloaded / 5xx / ...).
		const retryable = messages.find((m) => isRetryableModelFailure(m));
		if (retryable) {
			// Did the run actually produce real output despite the transient errors?
			// If finalText / textEvents / patches exist, the model recovered and we
			// should NOT mark the run as failed — only flag it when the worker
			// yielded nothing (the 429-only case from the bug report).
			const hasRealOutput =
				(parsed.finalText?.trim().length ?? 0) > 0 ||
				parsed.textEvents.some((t) => t.trim().length > 0) ||
				(parsed.patches?.length ?? 0) > 0;
			if (hasRealOutput) return undefined;
			return `Model returned only retryable errors and no output: ${retryable}`;
		}
	}
	// Secondary signal (FIX 3, task packet 01_01-agent): inspect a raw
	// `messageEndEvents` (or `transcript`) array on the parsed output. The
	// ParsedPiJsonOutput type does not currently declare this field, so we
	// read it through a local extension cast. Callers that pass it (tests, a
	// future parser that captures the full event stream) get a second chance
	// to surface retryable failures. Primary path still wins when it matches.
	const raw = parsed as ParsedPiJsonOutput & {
		messageEndEvents?: unknown;
		transcript?: unknown;
	};
	const eventSource = Array.isArray(raw.messageEndEvents)
		? raw.messageEndEvents
		: Array.isArray(raw.transcript)
			? raw.transcript
			: undefined;
	if (!eventSource || eventSource.length === 0) return undefined;
	for (const candidate of eventSource) {
		if (!candidate || typeof candidate !== "object") continue;
		const event = candidate as {
			stopReason?: unknown;
			errorMessage?: unknown;
		};
		if (event.stopReason !== "error") continue;
		if (typeof event.errorMessage !== "string" || event.errorMessage.length === 0) continue;
		if (!isRetryableModelFailure(event.errorMessage)) continue;
		// Same real-output gate as the primary signal — don't flag runs that
		// recovered with real final text / patches.
		const hasRealOutput =
			(parsed.finalText?.trim().length ?? 0) > 0 ||
			parsed.textEvents.some((t) => t.trim().length > 0) ||
			(parsed.patches?.length ?? 0) > 0;
		if (hasRealOutput) return undefined;
		return `Model returned only retryable errors and no output: ${event.errorMessage}`;
	}
	return undefined;
}

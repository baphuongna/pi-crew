/**
 * CORE-5 extraction 4 (FINAL): child-process task executor.
 *
 * Lifts the `runtimeKind === "child-process"` branch of `runTeamTask`
 * (model routing + model-fallback attempt loop, `runWorker()` call with
 * onSpawn/onStdoutLine/onJsonEvent/onLifecycleEvent callbacks,
 * timeoutController + externalAbortListener wiring (R3 listener-leak fix),
 * heartbeat persistence, transcript parsing + result-artifact assembly,
 * model-attempt logging) into a single {@link runChildProcessTask} function.
 *
 * Takes the pre-execution context ({@link TaskExecutionContext}) + the
 * stream bridge handle, mutates `ctx.task`/`ctx.tasks` in place (callback
 * closures close over the function's local `task`/`tasks`, then sync back to
 * ctx), and returns the branch output bag ({@link TaskExecutionResult}) for
 * {@link finalizeTaskResult} to consume.
 *
 * Extracted verbatim from `runTeamTask` — no behavioral changes. The
 * characterization tests (task-runner-characterization.test.ts scenarios
 * 2/3/4/11) lock this behavior; char #11 (R3 listener-leak structural)
 * now reads THIS file for the clearTimeout/removeEventListener contract.
 *
 * Also moves three private helpers that were used ONLY in this branch
 * (appendSteeringAsync, appendBackgroundLogAsync,
 * resolveTaskScopeModelsPatterns) and the exported
 * detectRetryableModelFailureFromOutput (re-exported from task-runner.ts
 * for the rate-limit-429-detection test).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../../config/config.ts";
import { errors } from "../../errors.ts";
import { writeArtifact } from "../../state/artifact-store.ts";
import { appendEventAsync, appendEventBuffered } from "../../state/event-log.ts";
import type { ArtifactDescriptor, OperationTerminalEvidence, TeamRunManifest } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { resolveRealContainedPath } from "../../utils/safe-paths.ts";
import { buildSyntheticTerminalEvidence, cancellationReasonFromSignal } from "../cancellation.ts";
import type { ChildPiLifecycleEvent, ChildPiRunResult } from "../child-pi/child-pi.ts";
import {
	appendCrewAgentEvent,
	appendCrewAgentOutput,
	emptyCrewAgentProgress,
	recordFromTask,
	upsertCrewAgent,
} from "../crew-agent-records.ts";
import { crewHooks } from "../crew-hooks.ts";
import { bridgeEventFromJsonEvent } from "../event-stream-bridge.ts";
import {
	buildConfiguredModelRouting,
	formatModelAttemptNote,
	isRetryableModelFailure,
	type ModelAttemptSummary,
} from "../model/model-fallback.ts";
import { readEnabledModelsPatterns } from "../model/model-scope.ts";
import { type ParsedPiJsonOutput, parsePiJsonOutput } from "../output/pi-json-output.ts";
import { type ProgressEventSummary, shouldAppendProgressEventUpdate } from "../output/progress-event-coalescer.ts";
import { DEFAULT_RETRY_POLICY } from "../recovery/retry-executor.ts";
import { runWorker } from "../run-worker.ts";
import { parseSessionUsage } from "../session-usage.ts";
import { recordSupervisorContact, supervisorContactFromEvent } from "../supervisor-contact.ts";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "../worker-heartbeat.ts";
import { createStartupEvidence } from "../worker-startup.ts";
import type { TaskExecutionResult } from "./post-execution.ts";
import type { StreamBridgeHandle, TaskExecutionContext } from "./pre-execution.ts";
import { applyAgentProgressEvent, applyUsageToProgress, progressEventSummary, shouldFlushProgressEvent } from "./progress.ts";
import { cleanResultText, isFinalChildEvent } from "./result-utils.ts";
import { checkpointTask, persistSingleTaskUpdate, updateTask } from "./state-helpers.ts";
import { tailReadWithLineSnap } from "./tail-read.ts";

/** Async helper for writing steering events — fire-and-forget for non-blocking writes. */
async function appendSteeringAsync(steeringDir: string, taskId: string, steers: string[]): Promise<void> {
	try {
		await fs.promises.mkdir(steeringDir, { recursive: true });
		const steeringPath = resolveRealContainedPath(steeringDir, `${taskId}.jsonl`);
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
 * RT-6: resolve the configured retry policy's maxAttempts from the project
 * reliability config (`reliability.retryPolicy.maxAttempts`), falling back to
 * {@link DEFAULT_RETRY_POLICY}.maxAttempts when config is unavailable or the
 * field is unset. Mirrors `retryPolicyFromConfig` in team-runner.ts so the
 * spawn-budget math and the actual retry loop (executeWithRetry) agree on the
 * same ceiling. Best-effort: any config read failure silently falls back to
 * the default so a misconfiguration never blocks the spawn.
 */
export function resolveConfiguredMaxAttempts(cwd: string): number {
	try {
		return loadConfig(cwd).config.reliability?.retryPolicy?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts;
	} catch {
		return DEFAULT_RETRY_POLICY.maxAttempts;
	}
}

/**
 * RT-6: pure spawn-budget max formula. `attemptModelsCount × (maxAttempts + 1)`
 * — always ≥ 1 full attempt above the theoretical max of
 * `maxAttempts × attemptModelsCount`. Exported for direct unit testing so the
 * configured-vs-default maxAttempts distinction is locked independently of
 * the retry loop (previously hard-coded DEFAULT_RETRY_POLICY.maxAttempts = 3,
 * silently halving retries when a higher maxAttempts — up to 10 — was set).
 */
export function computeSpawnBudgetMax(attemptModelsCount: number, configuredMaxAttempts: number): number {
	return attemptModelsCount * (configuredMaxAttempts + 1);
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

/**
 * Execute the child-process branch of `runTeamTask`: resolve model routing,
 * run the model-fallback attempt loop (spawning a worker per candidate model
 * via {@link runWorker}), wire the wall-clock timeout + external-abort listener
 * (R3 listener-leak cleanup in finally), persist heartbeats/progress, parse
 * the transcript, and assemble the result/log/transcript artifacts.
 *
 * Mutates `ctx.task` and `ctx.tasks` in place (the `runWorker` callbacks
 * close over local `task`/`tasks` and sync back before returning). Returns
 * the branch output bag ({@link TaskExecutionResult}) for
 * {@link finalizeTaskResult} to consume.
 *
 * @param ctx  The pre-execution context. `ctx.streamBridge` is the
 *             UI event-bus handle (may be undefined).
 * @returns    The branch execution result.
 */
export async function runChildProcessTask(ctx: TaskExecutionContext): Promise<TaskExecutionResult> {
	const input = ctx.input;
	const manifest: TeamRunManifest = ctx.manifest;
	let task = ctx.task;
	let tasks = ctx.tasks;
	const prompt = ctx.prompt;
	const skillPaths = ctx.skillPaths;
	const collectedJsonEvents = ctx.collectedJsonEvents;
	const streamBridge: StreamBridgeHandle | undefined = ctx.streamBridge;

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
	let startupEvidence = ctx.startupEvidence;

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
	// CORE-3: auto-compute per-task spawn budget on first entry.
	// Budget = attemptModels.length × (maxAttempts + 1) — always one
	// full attempt-worth above the theoretical maximum of
	// maxAttempts × attemptModels.length. Only computes once (max=0 guard).
	// RT-6: use the configured retry policy's maxAttempts (from project
	// reliability config), NOT DEFAULT_RETRY_POLICY (3). The retry loop in
	// team-runner.ts wraps runTeamTask in executeWithRetry with the same
	// configured maxAttempts (up to 10); hard-coding the default here silently
	// halved the spawn budget relative to the real retry ceiling.
	if (input.spawnBudget && input.spawnBudget.max === 0) {
		input.spawnBudget.max = computeSpawnBudgetMax(attemptModels.length, resolveConfiguredMaxAttempts(task.cwd));
	}
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
		// CORE-3: per-task spawn budget cap. Track total runWorker spawns
		// across ALL retry attempts × model fallback iterations. When
		// the budget is exhausted, break the loop using the last error
		// as the final result.
		if (input.spawnBudget) {
			input.spawnBudget.count += 1;
			if (input.spawnBudget.count > input.spawnBudget.max) {
				logs.push(
					`[WARN] CORE-3 spawn budget exhausted (max=${input.spawnBudget.max}) — ` +
						`stopping model fallback after ${modelAttempts.length} attempt(s). ` +
						`Last error: ${error ?? "<none>"}`,
					"",
				);
				break;
			}
		}
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
		// W2 fix — wall-clock timeout per task. We create our own
		// AbortController, link the caller's signal to it, and abort
		// from a timer. The internal signal is passed to runChildPi so
		// the existing SIGTERM → SIGKILL escalation in child-pi.ts
		// handles cleanup. Prevents runaway agent loops (e.g. 11_build
		// in the oh-my-pi distill run that re-verified completed files
		// 14+ times).
		const taskTimeoutMs = input.runtimeConfig?.taskTimeoutMs ?? 0;
		const timeoutController = new AbortController();
		// W2 fix (memory leak) — store the listener reference so we can
		// removeEventListener() it in the finally block below. { once: true }
		// alone is NOT enough: when the timeout fires first, the listener
		// never fires → { once: true } never auto-removes → listener stays
		// attached to input.signal for the rest of the run (run-level
		// signal = long-lived → leak accumulates per task run).
		let externalAbortListener: (() => void) | undefined;
		if (input.signal) {
			if (input.signal.aborted) {
				timeoutController.abort(input.signal.reason);
			} else {
				externalAbortListener = () => timeoutController.abort(input.signal!.reason);
				input.signal.addEventListener("abort", externalAbortListener, { once: true });
			}
		}
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		if (taskTimeoutMs > 0 && !timeoutController.signal.aborted) {
			timeoutHandle = setTimeout(() => {
				if (!timeoutController.signal.aborted) {
					timeoutController.abort(new Error(`Task exceeded wall-clock timeout of ${taskTimeoutMs}ms`));
				}
			}, taskTimeoutMs);
			timeoutHandle.unref?.();
		}
		let childResult: ChildPiRunResult;
		try {
			childResult = await runWorker({
				cwd: task.cwd,
				task: prompt,
				agent: input.agent,
				model,
				signal: timeoutController.signal,
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
				steeringFile: resolveRealContainedPath(`${manifest.artifactsRoot}/steering`, `${task.id}.jsonl`),
				onSpawn: (pid) => {
					try {
						({ task, tasks } = checkpointTask(manifest, tasks, task, "child-spawned", pid));
						if (task.pendingSteers?.length) {
							const steeringDir = `${manifest.artifactsRoot}/steering`;
							// Fire-and-forget async write for steering events
							void appendSteeringAsync(steeringDir, task.id, task.pendingSteers);
							// RT-8: spread before clearing pendingSteers instead of mutating
							// in place — preserves the immutable-snapshot invariant (the same
							// object may already be referenced by the tasks array / snapshots).
							task = { ...task, pendingSteers: [] };
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
					}).catch((error) => logInternalError("task-runner.lifecycle-event", error, `taskId=${task.id}, type=${event.type}`));
				},
				onStdoutLine: (line) => {
					appendCrewAgentOutput(manifest, task.id, line);
					persistHeartbeat();
				},
				onJsonEvent: (event) => {
					// Top-level error boundary: prevent any single event from crashing the task.
					// Errors are logged but processing continues so subsequent events still update state.
					try {
						// P2-25: handle supervisor_contact here (compact pipeline now passes
						// the full payload through); was dead on the old displayLine path.
						const contact = supervisorContactFromEvent(event);
						if (contact) recordSupervisorContact(manifest, { runId: manifest.runId, ...contact });
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
									// RT-8: spread before accumulating lifetimeUsage instead of
									// mutating in place — preserves the immutable-snapshot invariant.
									task = {
										...task,
										lifetimeUsage: {
											input: (task.lifetimeUsage?.input ?? 0) + (usage.input ?? 0),
											output: (task.lifetimeUsage?.output ?? 0) + (usage.output ?? 0),
											cacheWrite: (task.lifetimeUsage?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
										},
									};
								}
							}
						}
						persistHeartbeat();
						// Bug #3 fix: Write worker JSON events to background.log for debugging when running in background mode.
						// This supplements the event log so developers can see what the child Pi worker produced.
						if (process.env.PI_CREW_BACKGROUND_MODE === "1" && event) {
							const bgLogPath = `${manifest.stateRoot}/background.log`;
							const eventLine = typeof event === "object" && !Array.isArray(event) ? JSON.stringify(event) : String(event);
							// Fire-and-forget async write for background log
							void appendBackgroundLogAsync(bgLogPath, eventLine);
						}
						// Always keep in-memory agentProgress fresh (cheap) so the UI/events see
						// the latest progress, but THROTTLE the disk persist. Previously this
						// did a full locked read-parse-write of tasks.json on EVERY child JSON
						// event — a 200-event task produced 200 such cycles (Round 15 P1).
						// Final state is force-flushed on task completion (persistHeartbeat(true)).
						const nextProgress = applyAgentProgressEvent(task.agentProgress ?? emptyCrewAgentProgress(), event, task.startedAt);
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
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			// W2 fix — release the listener so it doesn't leak. {once:true}
			// only auto-removes when the listener FIRES; if the timeout
			// fires first, the listener never fires and stays attached
			// to input.signal (run-level signal = long-lived → leak per
			// task). Remove explicitly here.
			if (externalAbortListener && input.signal) {
				input.signal.removeEventListener("abort", externalAbortListener);
			}
		}
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
	const resultArtifact = writeArtifact(manifest.artifactsRoot, {
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
	const logArtifact = writeArtifact(manifest.artifactsRoot, {
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

	// Sync the callback-mutated task/tasks back into the context bag so
	// finalizeTaskResult sees the final state.
	ctx.task = task;
	ctx.tasks = tasks;

	return {
		resultArtifact,
		logArtifact,
		transcriptArtifact,
		exitCode,
		error,
		modelAttempts,
		parsedOutput,
		finalStdout,
		transcriptPath,
		terminalEvidence,
		startupEvidence,
	};
}

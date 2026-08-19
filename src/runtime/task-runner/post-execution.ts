/**
 * CORE-5 extraction 3: post-execution finalization.
 *
 * Lifts the shared post-branch block of `runTeamTask` (yield detection,
 * diff/patch artifacts, mutation guard, output validation, verification
 * evidence, terminal state persist, hooks, task.completed/failed events)
 * into a single {@link finalizeTaskResult} function.
 *
 * Takes the pre-execution context ({@link TaskExecutionContext}) + the
 * branch execution result ({@link TaskExecutionResult}) and returns the
 * final persisted task state.
 *
 * Extracted verbatim from `runTeamTask` — no behavioral changes. The
 * mutation guard (warn/fail/off) and verification contract are preserved
 * exactly (char scenarios 5-7, 9, 10 cover them).
 */
import { readFileSync } from "node:fs";
import { appendHookEvent, executeHook } from "../../hooks/registry.ts";
import { withRunLock } from "../../state/coordination/locks.ts";
import { appendEventAsync } from "../../state/event-log/event-log.ts";
import { writeArtifact } from "../../state/stores/artifact-store.ts";
import { saveRunManifestAsync } from "../../state/stores/state-store.ts";
import type {
	ArtifactDescriptor,
	OperationTerminalEvidence,
	TeamRunManifest,
	TeamTaskState,
	VerificationEvidence,
} from "../../state/types.ts";
import { captureWorktreeDiffAsync, captureWorktreeDiffStatAsync } from "../../worktree/worktree-manager.ts";
import { appendTaskAttentionEvent } from "../attention-events.ts";
import { extractCommandTrace } from "../command-trace.ts";
import { emptyCrewAgentProgress, recordFromTask, upsertCrewAgent } from "../crew-agent-records.ts";
import { crewHooks } from "../crew-hooks.ts";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "../heartbeat/worker-heartbeat.ts";
import type { ModelAttemptSummary } from "../model/model-fallback.ts";
import { isStderrOnlyResult, type OutputValidationResult, validateWorkerOutput } from "../output/output-validator.ts";
import type { ParsedPiJsonOutput } from "../output/pi-json-output.ts";
import { writeTaskSharedOutput } from "../task-output-context.ts";
import { evaluateCompletionMutationGuard } from "../verification/completion-guard.ts";
import { createVerificationEvidence } from "../verification/green-contract.ts";
import { computeGreenLevelFromResults, executeVerificationCommands } from "../verification/verification-gates.ts";
import { extractYieldResult, hasYieldInOutput, isYieldEvent, type YieldResult } from "../yield-handler.ts";
import { buildWorkerCapabilityInventory } from "./capabilities.ts";
import type { TaskExecutionContext } from "./pre-execution.ts";
import { buildWorkerPromptPipeline } from "./prompt-pipeline.ts";
import { evaluateSpecCoverage, parseSpecEvidenceFooter } from "./spec-evidence.ts";
import { persistSingleTaskUpdate, updateTask } from "./state-helpers.ts";

/**
 * Branch execution output — the set of variables produced by the
 * child-process / live-session / scaffold branch dispatch. These flow
 * into {@link finalizeTaskResult} for post-processing.
 *
 * `error`, `exitCode`, and `modelAttempts` are mutated in place by the
 * mutation guard (fail mode) inside finalizeTaskResult.
 */
export interface TaskExecutionResult {
	resultArtifact: ArtifactDescriptor;
	logArtifact: ArtifactDescriptor | undefined;
	transcriptArtifact: ArtifactDescriptor | undefined;
	exitCode: number | null;
	error: string | undefined;
	modelAttempts: ModelAttemptSummary[] | undefined;
	parsedOutput: ParsedPiJsonOutput | undefined;
	finalStdout: string;
	transcriptPath: string | undefined;
	terminalEvidence: OperationTerminalEvidence[];
	startupEvidence: import("../heartbeat/worker-startup.ts").WorkerStartupEvidence;
}

/** Final persisted task state returned by finalizeTaskResult. */
export interface FinalTaskResult {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
}

/**
 * Execute the shared post-branch phase of `runTeamTask`: yield detection,
 * diff/patch artifacts, completion mutation guard, output validation,
 * verification evidence computation, terminal state persistence, hooks,
 * and task.completed/failed events.
 *
 * @param ctx         The pre-execution context (task, tasks, manifest, etc.).
 *                    `ctx.task` and `ctx.tasks` must be synced to the
 *                    post-branch state by the caller before calling this.
 * @param execResult  The branch execution output (resultArtifact, error,
 *                    modelAttempts, etc.). `error`/`exitCode`/`modelAttempts`
 *                    may be mutated by the mutation guard.
 * @returns           The final persisted manifest + tasks.
 */
export async function finalizeTaskResult(ctx: TaskExecutionContext, execResult: TaskExecutionResult): Promise<FinalTaskResult> {
	const input = ctx.input;
	let manifest = ctx.manifest;
	let task = ctx.task;
	let tasks = ctx.tasks;
	const runtimeKind = ctx.runtimeKind;
	const workspace = ctx.workspace;
	const taskPacket = ctx.taskPacket;
	const collectYieldEvents = ctx.collectYieldEvents;
	const collectedJsonEvents = ctx.collectedJsonEvents;
	const permissionMode = ctx.permissionMode;
	const skillNames = ctx.skillNames;
	const skillPaths = ctx.skillPaths;
	const promptArtifact = ctx.promptArtifact;
	const inputsArtifact = ctx.inputsArtifact;
	const skillArtifact = ctx.skillArtifact;
	const coordinationArtifact = ctx.coordinationArtifact;

	const resultArtifact = execResult.resultArtifact;
	const logArtifact = execResult.logArtifact;
	const transcriptArtifact = execResult.transcriptArtifact;
	let exitCode = execResult.exitCode;
	let error = execResult.error;
	let modelAttempts = execResult.modelAttempts;
	const parsedOutput = execResult.parsedOutput;
	const finalStdout = execResult.finalStdout;
	const transcriptPath = execResult.transcriptPath;
	const terminalEvidence = execResult.terminalEvidence;
	const startupEvidence = execResult.startupEvidence;

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

	// --- Result artifact usability check (bug-026 sub-issue A) ---
	// A corrupted/empty worker payload leaves BOTH authoritative output sources
	// (parsed finalText + finalStdout) empty while the child-executor result
	// fallback chain persists session-log stderr noise as the result artifact.
	// Existence-only validation then marks the task "completed" and downstream
	// tasks silently consume garbage (evidence: run team_20260815144514,
	// results/02_explore-core.txt). Two-gate auto-fail — a gate-1 miss alone
	// (legitimate short result "OK done.") or a gate-2 miss alone (real content
	// in the artifact) keeps the pre-existing outcome:
	//   gate 1 — finalText AND finalStdout are both trimmed-empty (a legitimate
	//            result ALWAYS surfaces in at least one authoritative source);
	//   gate 2 — the persisted artifact is empty/'(no output)'/whitespace OR
	//            isStderrOnlyResult says every line is strict log noise.
	// A read error on the artifact is NOT a failure (conservative). Mirrors the
	// mutation-guard fail-mode precedent: error marker + exitCode bump + last
	// modelAttempt success:false → status flips to "failed" (retryable).
	if (!error) {
		const finalTextEmpty = !parsedOutput?.finalText?.trim();
		const finalStdoutEmpty = !finalStdout?.trim();
		if (finalTextEmpty && finalStdoutEmpty && resultArtifact?.path) {
			let artifactContent: string | undefined;
			try {
				artifactContent = readFileSync(resultArtifact.path, "utf8");
			} catch {
				artifactContent = undefined; // unreadable artifact — do not fail on read errors
			}
			if (artifactContent !== undefined) {
				const trimmedArtifact = artifactContent.trim();
				const emptyArtifact = trimmedArtifact === "" || trimmedArtifact === "(no output)";
				const stderrOnlyArtifact = !emptyArtifact && isStderrOnlyResult(artifactContent);
				if (emptyArtifact || stderrOnlyArtifact) {
					error = "Result artifact is empty or stderr-only (failureCause: empty-or-stderr-only-result)";
					exitCode = exitCode === 0 ? 1 : exitCode;
					if (modelAttempts?.length) {
						modelAttempts = modelAttempts.map((attempt, index) =>
							index === modelAttempts!.length - 1 ? { ...attempt, success: false, exitCode, error } : attempt,
						);
					}
					outputValidation = {
						valid: false,
						formatMatch: false,
						structurePreserved: false,
						issues: [
							`empty-or-stderr-only-result: ${
								emptyArtifact ? "result artifact is empty" : "result artifact contains only stderr/session-log noise"
							}`,
						],
					};
					await appendEventAsync(manifest.eventsPath, {
						type: "task.output_validation",
						runId: manifest.runId,
						taskId: task.id,
						data: {
							valid: false,
							formatMatch: false,
							structurePreserved: false,
							issues: outputValidation.issues,
							failureCause: "empty-or-stderr-only-result",
							resultPath: resultArtifact.path,
						},
					});
				}
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

	// --- T4/R6 (ADR-6 §3): SPEC-EVIDENCE coverage gate (non-strict default) ---
	// Extends the classifier seam above — mechanical coverage only, never
	// blocks in non-strict mode. Parses the footer from the authoritative
	// result sources (finalText first, finalStdout fallback — same sources as
	// the empty-result gate above). Spec-less tasks: gate not applicable.
	const specFooterText = parsedOutput?.finalText?.trim() ? parsedOutput.finalText : finalStdout;
	const specGate = taskPacket.specSnapshots?.length
		? evaluateSpecCoverage(taskPacket.specSnapshots, parseSpecEvidenceFooter(specFooterText ?? ""))
		: undefined;
	if (specGate?.badge) {
		await appendEventAsync(manifest.eventsPath, {
			type: "task.spec_gate",
			runId: manifest.runId,
			taskId: task.id,
			data: {
				mode: specGate.mode,
				badge: specGate.badge,
				footerPresent: specGate.footerPresent,
				missingMustIds: specGate.missingMustIds,
				unknownIds: specGate.unknownIds,
			},
		});
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
		...(specGate ? { specGate } : {}),
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
	// ST-7: this is a terminal transition (task.status is completed/failed/needs_attention),
	// pass skipCoalesce=true so the terminal update is durable — a SIGKILL in the
	// 50ms coalesce window must NOT leave tasks.json showing the prior non-terminal
	// status, otherwise crash recovery would see inconsistency between tasks.json
	// (running) and events.jsonl (terminal).
	tasks = await withRunLock(manifest, async () => {
		await saveRunManifestAsync(manifest);
		return persistSingleTaskUpdate(manifest, tasks, task, undefined, true);
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
		// bug-026 sub-issue B: surface the classified fatal-fs cause (enospc/
		// edquot/emfile/enfile) on the failure event so operators see "disk
		// full" instead of a generic timeout diagnostic.
		...(task.failureCause ? { data: { failureCause: task.failureCause } } : {}),
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
}

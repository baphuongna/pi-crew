/**
 * CORE-5 extraction 2: pre-execution context preparation.
 *
 * Lifts the shared pre-branch block of `runTeamTask` (workspace prep, task
 * packet, dependency context, skill rendering, prompt build, pre-step script
 * execution with the F-02 allowlist guard, task.started event) into a single
 * function that returns a {@link TaskExecutionContext} state bag.
 *
 * The cancel-before-start early return is preserved via a discriminated
 * union: when the input signal is already aborted, the function returns
 * `{ kind: "cancelled", result }` so the caller can short-circuit without
 * emitting task.started or writing artifacts.
 *
 * Extracted verbatim from `runTeamTask` — no behavioral changes.
 */
import { errors } from "../../errors.ts";
import { writeArtifact } from "../../state/artifact-store.ts";
import { appendEventAsync, appendEventFireAndForget } from "../../state/event-log.ts";
import { createTaskClaim } from "../../state/task-claims.ts";
import type { ArtifactDescriptor, TaskPacket, TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { resolveRealContainedPath } from "../../utils/safe-paths.ts";
import type { PreparedTaskWorkspace } from "../../worktree/worktree-manager.ts";
import { prepareTaskWorkspaceAsync } from "../../worktree/worktree-manager.ts";
import { reserveControlChannel } from "../agent-control.ts";
import { cancellationReasonFromSignal } from "../process/cancellation.ts";
import { emptyCrewAgentProgress, recordFromTask, upsertCrewAgent } from "../crew-agent-records.ts";
import type { CrewRuntimeKind } from "../crew-agent-runtime.ts";
import type { registerStreamBridge } from "../event-stream-bridge.ts";
import { permissionForRole, type RolePermissionMode } from "../role-permission.ts";
import { renderSkillInstructions } from "../skill-instructions.ts";
import { collectDependencyOutputContext, renderDependencyOutputContext, writeTaskInputsArtifact } from "../task-output-context.ts";
import { buildTaskPacket } from "../task-packet.ts";
// Type-only import avoids runtime circular dependency (task-runner.ts imports
// this module at runtime; we only need the TaskRunnerInput type here).
import type { TaskRunnerInput } from "../task-runner.ts";
import { createWorkerHeartbeat } from "../heartbeat/worker-heartbeat.ts";
import { createStartupEvidence, type WorkerStartupEvidence } from "../heartbeat/worker-startup.ts";
import { DEFAULT_YIELD_CONFIG } from "../yield-handler.ts";
import { coordinationBridgeInstructions, renderTaskPrompt } from "./prompt-builder.ts";
import { checkpointTask, persistSingleTaskUpdate, updateTask } from "./state-helpers.ts";

/** The stream bridge handle created by registerStreamBridge. */
export type StreamBridgeHandle = ReturnType<typeof registerStreamBridge>;

/**
 * Mutable state bag produced by the pre-execution phase. Fields mirror the
 * closure locals of `runTeamTask`'s pre-block. The branch dispatch and
 * post-execution phases read (and for `task`/`tasks`, mutate) these fields.
 */
export interface TaskExecutionContext {
	input: TaskRunnerInput;
	manifest: TeamRunManifest;
	task: TeamTaskState;
	tasks: TeamTaskState[];
	runtimeKind: CrewRuntimeKind;
	workspace: PreparedTaskWorkspace;
	worktree: TeamTaskState["worktree"];
	/**
	 * UI event-bus handle (created by registerStreamBridge in runTeamTask).
	 * The child-process branch bridges worker JSON events to it for
	 * near-instant UI updates. May be undefined.
	 */
	streamBridge: StreamBridgeHandle | undefined;
	taskPacket: TaskPacket;
	dependencyContextText: string | undefined;
	permissionMode: RolePermissionMode;
	skillBlock: string | undefined;
	skillNames: string[] | undefined;
	skillPaths: string[] | undefined;
	prompt: string;
	promptArtifact: ArtifactDescriptor;
	inputsArtifact: ArtifactDescriptor;
	skillArtifact: ArtifactDescriptor | undefined;
	coordinationArtifact: ArtifactDescriptor;
	collectYieldEvents: boolean;
	collectedJsonEvents: Record<string, unknown>[] | undefined;
	startupEvidence: WorkerStartupEvidence;
}

/**
 * Result of {@link prepareTaskExecutionContext}. When the input signal is
 * already aborted, the function returns `{ kind: "cancelled" }` so the caller
 * can short-circuit; otherwise it returns the ready context.
 */
export type PrepareTaskContextResult =
	| { kind: "cancelled"; result: { manifest: TeamRunManifest; tasks: TeamTaskState[] } }
	| { kind: "ready"; ctx: TaskExecutionContext };

/**
 * Execute the shared pre-branch phase of `runTeamTask`: prepare the workspace,
 * build the task packet, collect dependency context, set up the running task
 * state, check for cancel-before-start, persist state, emit task.started,
 * render skills, run the pre-step script (F-02 guard), and build the prompt.
 *
 * Returns a discriminated union: `"cancelled"` when the signal is already
 * aborted (caller short-circuits), or `"ready"` with the full context.
 */
export async function prepareTaskExecutionContext(
	input: TaskRunnerInput,
	manifest: TeamRunManifest,
	streamBridge: StreamBridgeHandle | undefined,
): Promise<PrepareTaskContextResult> {
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
			kind: "cancelled",
			result: {
				manifest: input.manifest,
				tasks: updateTask(tasks, cancelledTask),
			},
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
	if (input.step.preStepScript && input.step.source !== "builtin" && input.step.source !== "user") {
		// F-02 SECURITY FIX (allowlist): only builtin/user-sourced workflows may
		// execute pre-step scripts. Project-sourced AND programmatic
		// (source=undefined) steps are denied — a hostile repo clone could embed
		// arbitrary code via preStepScript + execFileSync, and steps constructed
		// without explicit trusted provenance should not auto-trust file
		// execution. Deny by default; discover-workflows strips project scripts
		// upstream so legitimate builtin/user scripts still run.
		appendEventFireAndForget(manifest.eventsPath, {
			type: "hook.pre_step_skipped",
			runId: manifest.runId,
			taskId: task.id,
			message: `preStepScript '${input.step.preStepScript}' skipped: only builtin/user-sourced workflows may execute pre-step scripts for security (F-02).`,
			data: { script: input.step.preStepScript, source: input.step.source ?? "unknown" },
		});
		preStepOutput = undefined;
	} else if (input.step.preStepScript) {
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

	const collectedJsonEvents: Record<string, unknown>[] | undefined = collectYieldEvents ? [] : undefined;

	const startupEvidence = createStartupEvidence({
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

	return {
		kind: "ready",
		ctx: {
			input,
			manifest,
			task,
			tasks,
			runtimeKind,
			workspace,
			worktree,
			taskPacket,
			dependencyContextText,
			permissionMode,
			skillBlock,
			skillNames,
			skillPaths,
			prompt,
			promptArtifact,
			inputsArtifact,
			skillArtifact,
			coordinationArtifact,
			collectYieldEvents,
			collectedJsonEvents,
			streamBridge,
			startupEvidence,
		},
	};
}

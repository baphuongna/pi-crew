import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewLimitsConfig, CrewRuntimeConfig } from "../config/config.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import type { ArtifactDescriptor, OperationTerminalEvidence, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";
import type { CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { registerStreamBridge } from "./event-stream-bridge.ts";
import type { ModelAttemptSummary } from "./model/model-fallback.ts";
import { awaitRuntimeWarmup } from "./model/runtime-warmup.ts";
import type { ParsedPiJsonOutput } from "./pi-json-output.ts";
import { runChildProcessTask } from "./task-runner/child-executor.ts";
import { finalizeTaskResult, type TaskExecutionResult } from "./task-runner/post-execution.ts";
import { prepareTaskExecutionContext } from "./task-runner/pre-execution.ts";
import { cleanResultText } from "./task-runner/result-utils.ts";
import { runScaffoldTask } from "./task-runner/scaffold-executor.ts";
import { registerYieldTool } from "./yield-handler.ts";

// Register the submit_result tool handler so subprocess events can extract yield data.
registerYieldTool();

/**
 * CORE-3 — mutable per-task spawn budget. Shared across ALL retry attempts
 * (executeWithRetry in team-runner.ts) × model fallback iterations
 * (the for-loop in runTeamTask) via a single object reference passed through
 * baseInput spread. When `count` exceeds `max`, the model fallback loop breaks.
 *
 * `max = 0` means auto-compute on first use as
 * `attemptModels.length × (maxAttempts + 1)` — always one full attempt above
 * the theoretical maximum of `maxAttempts × attemptModels.length`.
 */
export interface SpawnBudget {
	/** Running spawn count (mutated in place). */
	count: number;
	/** Maximum spawns allowed. 0 = auto-compute from attemptModels × maxAttempts. */
	max: number;
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
	/**
	 * CORE-3 — per-task spawn budget. When provided, runTeamTask tracks total
	 * runWorker spawns across the model fallback loop and breaks when the
	 * budget is exhausted. Shared across retry attempts via a single object
	 * reference (team-runner.ts creates one per dispatch unit and spreads it
	 * into every runTeamTask call).
	 */
	spawnBudget?: SpawnBudget;
}

export async function runTeamTask(input: TaskRunnerInput): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> {
	// Cold-start race fix: ensure the hot module graph is warm before touching
	// any module. Under tsx, concurrent first-imports race module-record
	// instantiation; awaiting the registration-time warmup eliminates the window.
	await awaitRuntimeWarmup();
	const manifest = input.manifest;
	// H4: registerStreamBridge inside try so dispose() in finally is safe
	let streamBridge: ReturnType<typeof registerStreamBridge> | undefined;
	try {
		streamBridge = registerStreamBridge(manifest.runId);
		const prepared = await prepareTaskExecutionContext(input, manifest, streamBridge);
		if (prepared.kind === "cancelled") return prepared.result;
		const ctx = prepared.ctx;
		// Destructure mutable fields for branch closures + sync-back
		let task = ctx.task;
		let tasks = ctx.tasks;
		const runtimeKind = ctx.runtimeKind;
		const workspace = ctx.workspace;
		const taskPacket = ctx.taskPacket;
		const collectYieldEvents = ctx.collectYieldEvents;
		const collectedJsonEvents = ctx.collectedJsonEvents;
		const permissionMode = ctx.permissionMode;
		const skillBlock = ctx.skillBlock;
		const skillNames = ctx.skillNames;
		const skillPaths = ctx.skillPaths;
		const prompt = ctx.prompt;
		const promptArtifact = ctx.promptArtifact;
		const inputsArtifact = ctx.inputsArtifact;
		const skillArtifact = ctx.skillArtifact;
		const coordinationArtifact = ctx.coordinationArtifact;

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
		let startupEvidence = ctx.startupEvidence;
		if (runtimeKind === "child-process") {
			// CORE-5 extraction 4: the entire child-process branch (model routing +
			// model-fallback attempt loop, runWorker callbacks, R3 listener-leak
			// cleanup, heartbeat persistence, transcript parsing, artifact assembly)
			// now lives in task-runner/child-executor.ts. It mutates ctx.task /
			// ctx.tasks in place and returns the branch output bag.
			const child = await runChildProcessTask(ctx);
			task = ctx.task;
			tasks = ctx.tasks;
			resultArtifact = child.resultArtifact;
			logArtifact = child.logArtifact;
			transcriptArtifact = child.transcriptArtifact;
			exitCode = child.exitCode;
			error = child.error;
			modelAttempts = child.modelAttempts;
			parsedOutput = child.parsedOutput;
			finalStdout = child.finalStdout;
			transcriptPath = child.transcriptPath;
			terminalEvidence = child.terminalEvidence;
			startupEvidence = child.startupEvidence;
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
			resultArtifact = runScaffoldTask(manifest, task);
		}

		// --- CORE-5 extraction 3: sync branch-mutated locals back to ctx, then finalize ---
		ctx.task = task;
		ctx.tasks = tasks;
		const execResult: TaskExecutionResult = {
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
		return await finalizeTaskResult(ctx, execResult);
	} finally {
		streamBridge?.dispose();
	}
}

// CORE-5 extraction 4: the following helpers moved to task-runner/child-executor.ts
// (they were used only in the child-process branch):
//   - appendSteeringAsync (private)
//   - appendBackgroundLogAsync (private)
//   - resolveTaskScopeModelsPatterns (private)
//   - detectRetryableModelFailureFromOutput (re-exported below for the
//     rate-limit-429-detection test which imports it from this module).
export { detectRetryableModelFailureFromOutput } from "./task-runner/child-executor.ts";

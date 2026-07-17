/**
 * Concrete `ChainTaskRunner` that executes each chain step as a REAL team run.
 *
 * This is the production wiring that makes `ChainRunner` (and Fix C's
 * `__chainHistoryNotes`) reachable: previously `ChainRunner` had zero production
 * callers and only existed with unit-test mock runners. Each step delegates to
 * the existing `handleRun` (which owns config load, team/workflow discovery,
 * worktree preconditions, manifest creation, and `executeTeamRun`), so the
 * ~200 lines of run machinery are NOT duplicated.
 *
 * Context passage (the whole point of the chain feature): `enrichContextFromHandoffs`
 * places `__chainHistory` + `__chainHistoryNotes` into `packet.context`; this
 * executor serializes them into a `# Previous Steps in This Chain` block that is
 * prepended to the step's goal. `handleRun` → `executeTeamRun` → worker prompt,
 * so step N+1's worker sees step N's handoff summary and the Fix C markers.
 *
 * Circular-import avoidance: `handleRun` is received as an INJECTED function
 * reference (dependency injection) rather than a static import. `run.ts` lazy-
 * imports `chain-dispatch.ts`, which imports this file. A static import of
 * `run.ts` here would create a `run.ts ↔ chain-executor.ts` cycle that races
 * module-record instantiation under jiti. The DI pattern breaks the cycle.
 *
 * @see src/runtime/chain-runner.ts (runChain, enrichContextFromHandoffs — Fix C)
 * @see src/extension/team-tool/run.ts (handleRun — the reused machinery)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChainTaskRunner } from "../../runtime/chain-runner.ts";
import type { Decision, TaskPacket, TaskResult } from "../../runtime/handoff-manager.ts";
import { readIfSmallWithTee } from "../../runtime/task-output-context.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { atomicWriteFile } from "../../state/atomic-write.ts";
import { createRunPaths, loadRunManifestById } from "../../state/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { textFromToolResult } from "../tool-result.ts";
import type { TeamContext } from "./context.ts";

/**
 * Signature of `handleRun`, declared locally (type-only) to break the
 * import cycle with run.ts. Structurally identical to
 * `(params, ctx) => Promise<PiTeamsToolResult>`.
 */
export type HandleRunFn = (params: TeamToolParamsValue, ctx: TeamContext) => Promise<PiTeamsToolResult>;

/** Per-step team/workflow/model overrides forwarded from the chain invocation. */
export interface ChainExecutorOverrides {
	team?: string;
	workflow?: string;
	model?: string;
}

/** Shape of one entry in `context.__chainHistory` produced by enrichContextFromHandoffs. */
interface ChainHistoryEntry {
	step?: string;
	outcome?: string;
	filesCreated?: string[];
	filesModified?: string[];
	decisions?: Decision[];
	nextSteps?: string[];
	outputText?: string;
}

/**
 * Serialize `packet.context.__chainHistory` (+ `__chainHistoryNotes`) into a
 * human-readable block prefixed with `# Previous Steps in This Chain`.
 *
 * This is the CRITICAL coupling that makes Fix C's `__chainHistoryNotes`
 * markers visible to step N+1's worker: those markers travel as a sibling
 * array on the context object, and only become worker-visible once formatted
 * into the goal text here. Returns `""` when there is no history.
 *
 * Extracted as a pure function for unit testability (acceptance criterion 6c).
 */
export function formatChainHistory(context: Record<string, unknown>): string {
	const history = context.__chainHistory;
	if (!Array.isArray(history) || history.length === 0) {
		return "";
	}

	const lines: string[] = ["# Previous Steps in This Chain", ""];

	for (const raw of history) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as ChainHistoryEntry;
		const stepName = entry.step ?? "unknown";
		const outcome = entry.outcome ?? "unknown";
		lines.push(`## Step ${stepName}: ${outcome}`);
		lines.push(`Files created: ${entry.filesCreated?.length ? entry.filesCreated.join(", ") : "none"}`);
		lines.push(`Files modified: ${entry.filesModified?.length ? entry.filesModified.join(", ") : "none"}`);
		if (entry.decisions?.length) {
			lines.push("Decisions:");
			for (const d of entry.decisions) {
				const rationale = d && typeof d === "object" && "rationale" in d ? String(d.rationale) : "(undocumented)";
				const decisionOutcome = d && typeof d === "object" && "outcome" in d ? String(d.outcome) : "";
				lines.push(`- ${rationale}${decisionOutcome ? ` → ${decisionOutcome}` : ""}`);
			}
		}
		if (entry.nextSteps?.length) {
			lines.push("Next steps:");
			for (const ns of entry.nextSteps) lines.push(`- ${ns}`);
		}
		if (entry.outputText) {
			lines.push("Output:");
			lines.push(entry.outputText);
		}
		lines.push("");
	}

	// Append Fix C honesty markers verbatim — these note elided/oversized history.
	const notes = context.__chainHistoryNotes;
	if (Array.isArray(notes)) {
		for (const note of notes) {
			if (typeof note === "string" && note.length > 0) lines.push(note);
		}
	}

	return lines.join("\n").trimEnd();
}

/**
 * Map a completed team run's manifest+tasks → a chain `TaskResult`.
 *
 * Outcome is derived from the manifest status, cross-checked against task
 * statuses (a run that completed but with a failed task reads as "partial").
 * `usage.totalTokens` sums each task's input+output tokens; `duration` from
 * manifest timestamps; `error` is best-effort from the first failed task or
 * the manifest summary. `filesCreated`/`filesModified` are intentionally left
 * unset — `TeamTaskState` does not carry them, so we never fabricate them.
 *
 * Extracted as a pure function for unit testability (acceptance criterion 6b).
 */
export function mapRunToTaskResult(manifest: TeamRunManifest, tasks: TeamTaskState[]): TaskResult {
	// Determine outcome from manifest status.
	let outcome: TaskResult["outcome"];
	if (manifest.status === "completed") {
		outcome = "success";
	} else if (manifest.status === "failed" || manifest.status === "blocked" || manifest.status === "cancelled") {
		outcome = "failure";
	} else {
		// queued / planning / running → not terminal yet
		outcome = "partial";
	}

	// Cross-check tasks: if a manifest claims completed but a task failed, it is partial.
	const hasFailed = tasks.some((t) => t.status === "failed" || t.status === "needs_attention");
	const hasCompleted = tasks.some((t) => t.status === "completed");
	if (hasFailed && (hasCompleted || outcome === "success")) {
		outcome = "partial";
	}

	// Token usage: sum task input + output.
	let totalTokens = 0;
	for (const t of tasks) {
		totalTokens += (t.usage?.input ?? 0) + (t.usage?.output ?? 0);
	}

	// Duration from manifest timestamps.
	let duration = 0;
	const created = Date.parse(manifest.createdAt);
	const updated = Date.parse(manifest.updatedAt);
	if (!Number.isNaN(created) && !Number.isNaN(updated) && updated >= created) {
		duration = updated - created;
	}

	// Error: best-effort from first failed task, else manifest summary.
	let error: string | undefined;
	if (outcome !== "success") {
		const failedTask = tasks.find((t) => t.status === "failed");
		error = failedTask?.error ?? manifest.summary;
	}

	const taskResult: TaskResult = {
		outcome,
		usage: { totalTokens },
		duration,
	};
	if (error) taskResult.error = error;
	return taskResult;
}

/**
 * Read completed tasks' result artifacts and concatenate their output text.
 * Mirrors the pattern in task-output-context.ts:collectDependencyOutputContext
 * (readIfSmallWithTee with baseDir = artifactsRoot).
 *
 * Returns the concatenated output text, or undefined if no artifacts were readable.
 */
export function readChainStepOutput(manifest: TeamRunManifest, tasks: TeamTaskState[]): string | undefined {
	const parts: string[] = [];
	for (const t of tasks) {
		if (t.status !== "completed" || !t.resultArtifact?.path) continue;
		const read = readIfSmallWithTee(t.resultArtifact.path, {
			baseDir: manifest.artifactsRoot,
		});
		if (read?.content && read.content.trim().length > 0) {
			parts.push(read.content.trim());
		}
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Concrete `ChainTaskRunner`: each step is a full team run via the injected
 * `handleRun`. Step runIds are captured on `stepRunIds` so the dispatch can
 * surface them in the summary and acceptance verification.
 *
 * Errors are intentionally NOT caught here — `runChain` wraps each step's
 * `runTask` call in try/catch, records `outcome: "failure"`, and respects
 * `continueOnError`. Letting exceptions propagate keeps the chain-runner's
 * existing failure semantics intact.
 */
export class ChainTeamRunExecutor implements ChainTaskRunner {
	/** RunId captured per executed step, in execution order. */
	readonly stepRunIds: string[] = [];

	private readonly handleRunRef: HandleRunFn;
	private readonly ctx: TeamContext;
	private readonly overrides: ChainExecutorOverrides;

	constructor(opts: {
		handleRun: HandleRunFn;
		ctx: TeamContext;
		overrides?: ChainExecutorOverrides;
	}) {
		this.handleRunRef = opts.handleRun;
		this.ctx = opts.ctx;
		this.overrides = opts.overrides ?? {};
	}

	async runTask(packet: TaskPacket): Promise<TaskResult> {
		const context = packet.context ?? {};

		// 1. Format chain history into the goal — this is how context reaches the worker.
		//    Mirrors the parentContext pattern in child-pi.ts (parent context + task delimiter).
		const historyPrefix = formatChainHistory(context);
		const enrichedGoal = historyPrefix ? `${historyPrefix}\n\n---\n# Current Chain Step\n${packet.goal}` : packet.goal;

		// 2. Resolve team/workflow/model: step config (set by executeStep) → overrides → default.
		const stepTeam = (context.__chainStepTeam as string | undefined) ?? this.overrides.team ?? "default";
		const stepWorkflow = (context.__chainStepWorkflow as string | undefined) ?? this.overrides.workflow;
		const stepModel = (context.__chainStepModel as string | undefined) ?? this.overrides.model;

		// 3. Call handleRun for the heavy lifting. async:false forces each step to
		//    complete synchronously (overrides asyncByDefault) so the chain is sequential.
		//    NO `chain` key here — so the run.ts guard does not re-enter chain dispatch.
		const runParams: TeamToolParamsValue = {
			action: "run",
			goal: enrichedGoal,
			team: stepTeam,
			async: false,
			...(stepWorkflow ? { workflow: stepWorkflow } : {}),
			...(stepModel ? { model: stepModel } : {}),
		};
		const runRes = await this.handleRunRef(runParams, this.ctx);

		// 4. Extract runId + map to TaskResult. If no runId, the run was blocked before
		//    a manifest existed — map as a failure.
		const runId = runRes.details?.runId;
		if (!runId) {
			return {
				outcome: "failure",
				error: textFromToolResult(runRes) || "Chain step produced no runId",
			};
		}
		this.stepRunIds.push(runId);

		const cwd = this.ctx.cwd ?? process.cwd();
		const loaded = loadRunManifestById(cwd, runId);
		if (!loaded) {
			// Manifest not loadable — fall back to the tool result's own status.
			return {
				outcome: runRes.details?.status === "error" ? "failure" : "partial",
			};
		}
		const result = mapRunToTaskResult(loaded.manifest, loaded.tasks);
		const outputText = readChainStepOutput(loaded.manifest, loaded.tasks);
		if (outputText) result.outputText = outputText;
		return result;
	}
}

// ─── test helpers (exported for unit/integration tests) ──────────────────

/**
 * Write a minimal valid run fixture (manifest + tasks + events) to `cwd`'s
 * state root so `loadRunManifestById(cwd, runId)` validates and returns it.
 * Used by integration tests to exercise `ChainTeamRunExecutor` with a mocked
 * `handleRun` while still going through the REAL manifest loader + result mapper.
 */
export function writeRunFixture(
	cwd: string,
	runId: string,
	opts: {
		status?: TeamRunManifest["status"];
		tasks?: TeamTaskState[];
		summary?: string;
		/** Worker result text to write to results/<taskId>.txt (sets resultArtifact on tasks). */
		resultText?: string;
		/** Task ID for the result artifact (default: "01_task"). */
		taskId?: string;
	},
): TeamRunManifest {
	const paths = createRunPaths(cwd, runId);
	fs.mkdirSync(paths.stateRoot, { recursive: true });
	const now = new Date().toISOString();
	const start = new Date(Date.now() - 10_000).toISOString();
	const taskId = opts.taskId ?? "01_task";

	// Build tasks: if resultText is provided without explicit tasks, create a
	// default completed task carrying a resultArtifact pointing at the result file.
	let tasks = opts.tasks;
	if (opts.resultText) {
		const resultArtifact = {
			kind: "result" as const,
			path: `results/${taskId}.txt`,
			createdAt: now,
			producer: "worker",
			retention: "run" as const,
		};
		if (!tasks || tasks.length === 0) {
			tasks = [
				{
					id: taskId,
					runId,
					role: "executor",
					agent: "executor",
					title: "(chain step fixture)",
					status: "completed",
					dependsOn: [],
					cwd,
					resultArtifact,
				},
			];
		} else {
			// Attach resultArtifact to the first task if it doesn't have one.
			tasks = tasks.map((t, i) => (i === 0 && !t.resultArtifact ? { ...t, resultArtifact } : t));
		}
	}

	const manifest: TeamRunManifest = {
		schemaVersion: 1,
		runId,
		team: "default",
		workflow: "default",
		goal: "(chain step fixture)",
		status: opts.status ?? "completed",
		workspaceMode: "single",
		createdAt: start,
		updatedAt: now,
		cwd,
		stateRoot: paths.stateRoot,
		artifactsRoot: paths.artifactsRoot,
		tasksPath: paths.tasksPath,
		eventsPath: paths.eventsPath,
		artifacts: [],
		...(opts.summary ? { summary: opts.summary } : {}),
	};

	// Write the result artifact file + register on manifest if resultText provided.
	if (opts.resultText) {
		const resultDir = path.join(paths.artifactsRoot, "results");
		fs.mkdirSync(resultDir, { recursive: true });
		atomicWriteFile(path.join(resultDir, `${taskId}.txt`), opts.resultText);
		manifest.artifacts.push({
			kind: "result",
			path: `results/${taskId}.txt`,
			createdAt: now,
			producer: "worker",
			retention: "run",
		});
	}

	atomicWriteFile(paths.manifestPath, JSON.stringify(manifest));
	atomicWriteFile(paths.tasksPath, JSON.stringify(tasks ?? []));
	atomicWriteFile(paths.eventsPath, "");
	return manifest;
}

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
import type { TeamEventType } from "../../state/contracts.ts";
import { withRunLock } from "../../state/coordination/locks.ts";
import { appendEventAsync } from "../../state/event-log/event-log.ts";
import { writeArtifact } from "../../state/stores/artifact-store.ts";
import { saveRunManifestAsync } from "../../state/stores/state-store.ts";
import type {
	ArtifactDescriptor,
	OperationTerminalEvidence,
	TeamRunManifest,
	TeamTaskState,
	TeamTaskStatus,
	UsageState,
	VerificationEvidence,
} from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { buildGitSafeEnv, hardenGitArgs, worktreeTrustCheck } from "../../worktree/git-hardening.ts";
import { captureWorktreeDiffAsync, captureWorktreeDiffStatAsync } from "../../worktree/worktree-manager.ts";
import { appendTaskAttentionEvent } from "../attention-events.ts";
import { extractCommandTrace } from "../command-trace.ts";
import { emptyCrewAgentProgress, recordFromTask, upsertCrewAgent } from "../crew-agent-records.ts";
import { crewHooks } from "../crew-hooks.ts";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "../heartbeat/worker-heartbeat.ts";
import type { ModelAttemptSummary } from "../model/model-fallback.ts";
import { isStderrOnlyResult, type OutputValidationResult, validateWorkerOutput } from "../output/output-validator.ts";
import type { ParsedPiJsonOutput } from "../output/pi-json-output.ts";
import { permissionForRole } from "../role-permission.ts";
import { writeTaskSharedOutput } from "../task-output-context.ts";
import { evaluateCompletionMutationGuard } from "../verification/completion-guard.ts";
import { createVerificationEvidence } from "../verification/green-contract.ts";
import { computeGreenLevelFromResults, executeVerificationCommands } from "../verification/verification-gates.ts";
import { extractYieldResult, hasYieldInOutput, isYieldEvent, type YieldResult } from "../yield-handler.ts";
import { buildWorkerCapabilityInventory } from "./capabilities.ts";
import type { TaskExecutionContext } from "./pre-execution.ts";
import { buildWorkerPromptPipeline } from "./prompt-pipeline.ts";
import { computeSpecGate } from "./spec-evidence.ts";
import { persistSingleTaskUpdate, updateTask } from "./state-helpers.ts";

/**
 * R6-1 (DR-03, 2026-10-16): terminal status → singleton-path terminal event
 * type. When persistSingleTaskUpdate PRESERVED a disk terminal status (e.g.
 * `cancelled` written by crash-recovery while this worker was settling), the
 * emitted event must match the PRESERVED record — emitting task.completed
 * over a cancelled tasks.json entry recreates the event-log vs tasks.json
 * divergence crash-recovery reconstructs from. Every terminal task status
 * has a matching event type in TEAM_EVENT_TYPES; the lookup is total in
 * practice, the undefined guard is defensive only.
 */
const TERMINAL_TASK_EVENT_TYPES: Readonly<Partial<Record<TeamTaskStatus, TeamEventType>>> = {
	completed: "task.completed",
	failed: "task.failed",
	cancelled: "task.cancelled",
	skipped: "task.skipped",
	needs_attention: "task.needs_attention",
};

/**
 * Branch execution output — the set of variables produced by the
 * child-process / live-session / scaffold branch dispatch. These flow
 * into {@link finalizeTaskResult} for post-processing.
 *
 * `error`, `exitCode`, and `modelAttempts` are mutated in place by the
 * mutation guard (fail mode) inside finalizeTaskResult.
 */
export interface TaskExecutionResult {
	/**
	 * MuxSurface A1 (spec §7 D3): the worker's pane died with NO worker.completed
	 * inside the classify window — the worker never finished. When set,
	 * {@link finalizeTaskResult} short-circuits into a dedicated degrade
	 * terminalisation (needs_attention, no fabricated result) INSTEAD of the
	 * yield/mutation/output guards, which would misread the loss as an
	 * empty-result failure and trigger autoRetry double-dispatch.
	 */
	surfaceLost?: {
		taskId: string;
		paneId: string;
		cause: "pane-closed" | "mux-dead";
		exitReason: string;
		ts: string;
	};
	resultArtifact?: ArtifactDescriptor;
	logArtifact: ArtifactDescriptor | undefined;
	transcriptArtifact: ArtifactDescriptor | undefined;
	exitCode: number | null;
	error: string | undefined;
	modelAttempts: ModelAttemptSummary[] | undefined;
	parsedOutput: ParsedPiJsonOutput | undefined;
	finalStdout: string;
	/** Round-1: un-trimmed final assistant text (pre-compaction) — the spec
	 *  footer union prefers it, mirroring the result-artifact fallback chain. */
	rawFinalText?: string;
	transcriptPath: string | undefined;
	terminalEvidence: OperationTerminalEvidence[];
	startupEvidence: import("../heartbeat/worker-startup.ts").WorkerStartupEvidence;
	/** Which child-executor fallback branch produced the result artifact
	 *  content (rawFinalText → finalText → session → stdout → stderr → findings →
	 *  "(no output)"). Finding #2 (2026-09-29 battery): "stderr"/"none" mean
	 *  every authoritative worker output source was empty — finalizeTaskResult
	 *  fails those DETERMINISTICALLY; the stderr-noise classifier stays a
	 *  defense layer, never the verdict oracle. "session" (W2/P1-1) = the text
	 *  was tail-recovered from the worker's session JSONL on a signal-death
	 *  crash path — authoritative recovered output, not a failure source. */
	resultSource?: ResultSource;
}

/** Result-artifact provenance tags (see {@link TaskExecutionResult.resultSource}). */
export type ResultSource = "rawFinalText" | "finalText" | "session" | "stdout" | "stderr" | "findings" | "none";

/** Verifier verdict as read from the worker's own result text. */
export type VerifierVerdict = "pass" | "fail" | "none";

/**
 * Verdict line shape of the verifier output contract
 * (`live-session-runtime.ts` buildOutputContract → "PASS: <what verified> —
 * <evidence>" / "FAIL: <what failed> — <reason>"). Tolerates the markdown
 * decorations real workers emit (`**PASS:**`, `- FAIL:`, `> PASS:`,
 * `` `PASS:` ``, `# PASS:`) AND the bare-prose verdicts the child-process
 * workflow prompts used to ask for ("Give PASS or FAIL with evidence" →
 * `PASS`, `**PASS**`, `PASS — evidence`, `PASS. Evidence: …`): a wave-6 T7
 * live probe caught a FAILED-gate run blocking as `green_unsatisfied /
 * observed=none` because the verifier followed its prose prompt and wrote a
 * bare verdict. A token only counts at LINE START and only when followed by
 * punctuation/EOL/`(` — a bare mention inside prose ("the verifier said
 * PASS: that") still does NOT count, and a word continuation ("PASSED all
 * checks") does not either.
 */
const VERIFIER_VERDICT_LINE = /^[\s*_>#`=-]*(PASS|FAIL)[\s*_`]*(?=[:.\u2014\u2013-]|$|\()/i;

/** W10-5: the critic/oracle decision-drift guardian marker (see
 *  agents/critic.md + agents/oracle.md "Decision-drift guardian" sections). */
const DRIFT_BLOCK_MARKER = /DRIFT-BLOCK\b/i;

/**
 * W10-8 (pi-subagents lesson #4): bounded `git status --porcelain` probe for
 * READ-ONLY lanes — any entry (modified OR untracked) is an unexpected
 * mutation. Returns undefined when the tree is clean or git fails (fail-open:
 * a broken probe must not break task finalization). Note-only, never a fail.
 * R-A2 exception: a FAILED GITDIR-POINTER GUARD is not a broken probe but a
 * live corruption signal — it reports a mutation note (see body).
 */
export async function detectReadLaneMutation(worktreePath: string): Promise<NonNullable<TeamTaskState["unexpectedMutation"]> | undefined> {
	try {
		// R-A2 (MED-1 follow-up): this probe used to be a raw execFile with the
		// FULL process.env — API keys could leak to worker-planted fsmonitor /
		// hook config reachable from the probed worktree. It now routes through
		// the MED-1 hardening: hardenGitArgs config-injection overrides, the
		// sanitized git env (no process.env inheritance), and the gitdir-pointer
		// guard. Guard failure is fail-safe TOWARD REPORTING a mutation: a
		// corrupted `.git` pointer in a READ-ONLY lane is itself a lane
		// violation (the worker rewrote something it must not touch), so it
		// surfaces as a note + internal log instead of a clean verdict.
		const trust = worktreeTrustCheck(worktreePath);
		if (trust.kind === "worktree" && !trust.ok) {
			logInternalError(
				"post-execution.readLane.gitdirMismatch",
				new Error(`Refusing to run the mutation probe inside ${worktreePath}: ${trust.reason}`),
				`worktreePath=${worktreePath}`,
			);
			return {
				filesChanged: 0,
				sample: [`worktree corrupted — gitdir pointer check failed (${trust.reason}); no git executed`],
			};
		}
		// W10-8 one-shot git probe per read-only task — child_process is
		// already in the platform; dynamic keeps it off the static import graph.
		// LAZY: see above
		const { execFile } = await import("node:child_process");
		const out: string = await new Promise((resolve, reject) => {
			execFile(
				"git",
				hardenGitArgs(["status", "--porcelain"]),
				{
					cwd: worktreePath,
					env: buildGitSafeEnv(),
					encoding: "utf-8",
					timeout: 10_000,
					windowsHide: true,
				},
				(err, stdout) => (err ? reject(err) : resolve(stdout)),
			);
		});
		const entries = out
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		if (entries.length === 0) return undefined;
		return {
			filesChanged: entries.length,
			sample: entries.slice(0, 20).map((e) => e.slice(0, 200)),
		};
	} catch {
		return undefined;
	}
}

/**
 * W10-7 (v0.11.38, pi-subagents lesson #14 — usage reconciliation): compare
 * the SUM of every model attempt's own cost (failed fallback attempts burn
 * real tokens too, but task.usage carries only the FINAL run's numbers)
 * against the final cost. Returns a usageReconcile note ONLY when the gap
 * exceeds 5% AND at least two attempts reported usage — a single attempt is
 * trivially self-consistent. Observability only: never fails the task.
 */
export function reconcileUsage(
	attempts: ModelAttemptSummary[] | undefined,
	finalUsage: UsageState | undefined,
): { usageReconcile: NonNullable<TeamTaskState["usageReconcile"]> } | undefined {
	if (!attempts || attempts.length < 2) return undefined;
	// W10-7 batch-A threshold guard: with no final usage to reconcile AGAINST
	// (finalUsage missing, or its cost not a finite number) the comparison is
	// meaningless — an attempt-sum alone cannot prove a gap, and comparing to
	// 0 would file a false 100%-gap alarm against missing data. No note.
	if (typeof finalUsage?.cost !== "number" || !Number.isFinite(finalUsage.cost)) return undefined;
	const costs = attempts.map((a) => (typeof a.usage?.cost === "number" && Number.isFinite(a.usage.cost) ? a.usage.cost : undefined));
	const withUsage = costs.filter((c): c is number => c !== undefined);
	if (withUsage.length < 2) return undefined;
	const attemptTotal = withUsage.reduce((sum, c) => sum + c, 0);
	const finalCost = finalUsage.cost;
	if (attemptTotal <= 0) return undefined;
	const deltaPct = Math.abs(attemptTotal - finalCost) / attemptTotal;
	if (deltaPct <= 0.05) return undefined;
	return {
		usageReconcile: {
			attemptTotalCostUsd: Number(attemptTotal.toFixed(6)),
			finalRunCostUsd: finalCost,
			deltaPct: Number((deltaPct * 100).toFixed(1)),
			attemptsWithUsage: withUsage.length,
		},
	};
}

/**
 * W10-8 visibility (batch A): the unexpectedMutation note lives on the task
 * record where it is easy to miss — stamping it also emits ONE stderr line
 * so a READ-ONLY lane violation shows up in the run log without new
 * dependencies. Exported for the console-capture pin; fire-and-forget.
 */
export function warnReadLaneMutation(taskId: string, note: { filesChanged: number }): void {
	console.warn(`[pi-crew:read-lane] unexpected mutation in READ-ONLY lane: ${taskId} files=${note.filesChanged}`);
}

/**
 * M3-2 (R47-3/V4, fix-wave 6): read the verifier verdict out of the
 * authoritative result sources.
 *
 * Before the fix the `^(PASS:|FAIL:)` pattern existed ONLY in
 * `output-validator.ts`, OR'd with `MARKDOWN_STRUCTURED` — it answered "is some
 * contract format present?", never "which verdict?", and a `FAIL:` result
 * completed the task green. This is the semantic reader the terminal state
 * consults.
 *
 * Precedence (fail-closed):
 *  - ANY `FAIL:` line wins, even next to a `PASS:` line (a contradictory
 *    verdict is not a pass; a verifier that reports a failure must never be
 *    rubber-stamped).
 *  - Otherwise ≥1 `PASS:` line ⇒ "pass".
 *  - No verdict line in ANY source ⇒ "none" (not verified — the caller
 *    downgrades self-attested evidence, it does NOT fail the task: a verifier
 *    that delivered a substantive report without the magic line made a
 *    reporting error, not a verification failure).
 *
 * Sources are scanned in priority order (raw pre-compaction finalText → parsed
 * finalText → stdout) and the first source carrying a verdict decides, so a
 * compaction-truncated tail cannot lose the verdict line.
 */
export function extractVerifierVerdict(...sources: Array<string | undefined>): VerifierVerdict {
	for (const source of sources) {
		if (!source) continue;
		let sawPass = false;
		for (const line of source.split("\n")) {
			const match = VERIFIER_VERDICT_LINE.exec(line);
			if (!match) continue;
			if (match[1]?.toUpperCase() === "FAIL") return "fail";
			sawPass = true;
		}
		if (sawPass) {
			// W10-5 (v0.11.38, pi-subagents lesson #20 — oracle/drift-guardian): a
			// verdict that flags a decision-drift contradiction (the `DRIFT-BLOCK:`
			// marker the critic/oracle prompts mandate) is SELF-CONTRADICTORY as a
			// pass — the worker saw a contradiction with an inherited decision and
			// approved anyway. Degrade to "none" (not verified): the existing
			// self-attested downgrade path then demands human/leader review instead
			// of a green. FAIL still wins above — a flagged drift alongside FAIL is
			// already the honest verdict.
			if (DRIFT_BLOCK_MARKER.test(source)) return "none";
			return "pass";
		}
	}
	return "none";
}

/** First verdict line of a source set — the failure-cause excerpt. */
function firstVerdictLine(...sources: Array<string | undefined>): string {
	for (const source of sources) {
		if (!source) continue;
		for (const line of source.split("\n")) {
			if (VERIFIER_VERDICT_LINE.test(line)) return line.trim().slice(0, 300);
		}
	}
	return "";
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
	const breakdownArtifact = ctx.breakdownArtifact;
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
	const rawFinalText = execResult.rawFinalText;
	const transcriptPath = execResult.transcriptPath;
	const terminalEvidence = execResult.terminalEvidence;
	const startupEvidence = execResult.startupEvidence;

	// ── MuxSurface A1 (spec §7 D3): degrade terminalisation ───────────────
	// The pane died with NO worker.completed in the classify window: the worker
	// never finished, so the yield/mutation/output guards would MISREAD this as
	// an empty-result failure (autoRetry would then double-dispatch and a failed
	// task could abort the whole run at handleFailedTask). Terminalise as
	// needs_attention WITHOUT fabricating a result; team-runner's surface-degrade
	// drain re-queues the unit headless (scratchpad restore + pendingSteers
	// replay + resume note) WITHOUT consuming retry budget (spec §7 step 5).
	if (execResult.surfaceLost) {
		const lost = execResult.surfaceLost;
		task = {
			...task,
			status: "needs_attention",
			finishedAt: new Date().toISOString(),
			exitCode: null,
			error: undefined,
			claim: undefined,
			// FIX-2 note: no pid at write time — this terminal touch only marks
			// alive:false on the EXISTING heartbeat (worker already exited); a
			// live pid is pinned at spawn by child-executor's persistHeartbeat.
			heartbeat: touchWorkerHeartbeat(task.heartbeat ?? createWorkerHeartbeat(task.id), { alive: false }),
			terminalEvidence: terminalEvidence.length ? [...(task.terminalEvidence ?? []), ...terminalEvidence] : task.terminalEvidence,
			diagnostics: {
				...(task.diagnostics ?? {}),
				surfaceLost: { ts: lost.ts, cause: lost.cause, paneId: lost.paneId, exitReason: lost.exitReason },
			},
		};
		tasks = updateTask(tasks, task);
		// ST-7: durable terminal write under the run lock — crash recovery must
		// see needs_attention, not a phantom "running" worker.
		tasks = await withRunLock(manifest, async () => persistSingleTaskUpdate(manifest, tasks, task, undefined, true));
		upsertCrewAgent(manifest, recordFromTask(manifest, task, runtimeKind));
		await appendEventAsync(manifest.eventsPath, {
			type: "task.surface_lost",
			runId: manifest.runId,
			taskId: task.id,
			message: `Surface worker lost (${lost.cause}) before completing — re-dispatching headless`,
			data: { paneId: lost.paneId, cause: lost.cause, exitReason: lost.exitReason, ts: lost.ts },
		});
		return { manifest, tasks };
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
	// W10-8 (v0.11.38, pi-subagents lesson #4 — staged-files guard): a READ-ONLY
	// lane that dirtied its worktree is a contract violation worth surfacing —
	// note only (the diff artifact above is the evidence; the leader decides).
	// `git diff` alone misses UNTRACKED files, hence status --porcelain.
	const readLaneMutation =
		workspace.worktreePath && permissionForRole(task.role) === "read_only"
			? await detectReadLaneMutation(workspace.worktreePath)
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
	// Finding #2 (2026-09-29 battery): gate 2 alone is not a verdict oracle —
	// the strict-noise classifier missed colon-bearing/camelCase extension
	// tags (`[pi-crew:crash-recovery.reconcileStaleRuns]`, lock-contention
	// noise about a SIBLING run), so attempts whose stderr carried them
	// completed tasks with 100%-noise artifacts while sibling attempts on the
	// same runs failed — verdict divergence depended on per-attempt stderr
	// composition. The child-executor fallback chain now tags the winning
	// branch (resultSource); "stderr"/"none"-sourced artifacts fail
	// UNCONDITIONALLY (classifier-independent), making empty/stderr-only
	// results never complete a task, uniformly across roles.
	// A read error on the artifact is NOT a failure (conservative) — unless
	// the source tag already proves the artifact is stderr/none-sourced.
	// Mirrors the mutation-guard fail-mode precedent: error marker + exitCode
	// bump + last modelAttempt success:false → status flips to "failed" (retryable).
	if (!error) {
		const finalTextEmpty = !parsedOutput?.finalText?.trim();
		const finalStdoutEmpty = !finalStdout?.trim();
		const resultSource = execResult.resultSource;
		const degradedResultSource = resultSource === "stderr" || resultSource === "none";
		if (finalTextEmpty && finalStdoutEmpty && (resultArtifact?.path || degradedResultSource)) {
			let artifactContent: string | undefined;
			if (resultArtifact?.path) {
				try {
					artifactContent = readFileSync(resultArtifact.path, "utf8");
				} catch {
					artifactContent = undefined; // unreadable artifact — do not fail on read errors
				}
			}
			if (artifactContent !== undefined || degradedResultSource) {
				const trimmedArtifact = (artifactContent ?? "").trim();
				const emptyArtifact = trimmedArtifact === "" || trimmedArtifact === "(no output)";
				const stderrOnlyArtifact = !emptyArtifact && isStderrOnlyResult(artifactContent ?? "");
				if (degradedResultSource || emptyArtifact || stderrOnlyArtifact) {
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
								degradedResultSource && !emptyArtifact && !stderrOnlyArtifact
									? `result artifact was sourced from the ${resultSource} fallback (no authoritative worker output)`
									: emptyArtifact
										? "result artifact is empty"
										: "result artifact contains only stderr/session-log noise"
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
							...(resultSource ? { resultSource } : {}),
							resultPath: resultArtifact?.path,
						},
					});
				}
			}
		}
	}

	// ─── M3-2 (R47-3/V4, fix-wave 6): the PASS:/FAIL: verdict is a REAL consumer ───
	// Before this block NOTHING read the verdict: the terminal status came from
	// `error`/`noYield` alone, so a verifier that answered "FAIL: <red tests>"
	// ended `completed` and the run could close out green on it. The ruling is
	// two-sided and fail-closed:
	//   FAIL → hard-fail the task now (error marker + exitCode bump + last model
	//          attempt success:false — the same precedent as the
	//          empty/stderr-only gate above), so retry/escalate policy sees it;
	//   PASS → required before the task's self-attested evidence counts as
	//          VERIFIED (evidence ruling right after the evidence computation
	//          below); a missing verdict is "not verified", never a failure.
	// Excluded: the deterministic gate-skip path (task-runner.ts skip branch
	// terminalises the verifier task itself with the GATE's summary as stdout and
	// stamps diagnostics.verifyGate + synthetic — the deterministic gate already
	// verified, there is no LLM verdict to read) and scaffold mode (no worker).
	const verifierVerdictApplies =
		task.role === "verifier" &&
		runtimeKind !== "scaffold" &&
		task.diagnostics?.verifyGate === undefined &&
		task.diagnostics?.synthetic !== true;
	const verifierVerdict: VerifierVerdict = verifierVerdictApplies
		? extractVerifierVerdict(rawFinalText, parsedOutput?.finalText, finalStdout)
		: "none";
	if (!error && verifierVerdictApplies && verifierVerdict === "fail") {
		const verdictLine = firstVerdictLine(rawFinalText, parsedOutput?.finalText, finalStdout);
		error = `Verifier verdict FAIL (failureCause: verifier-verdict-fail): ${verdictLine}`;
		exitCode = exitCode === 0 ? 1 : exitCode;
		if (modelAttempts?.length) {
			modelAttempts = modelAttempts.map((attempt, index) =>
				index === modelAttempts!.length - 1 ? { ...attempt, success: false, exitCode, error } : attempt,
			);
		}
		outputValidation = {
			valid: false,
			formatMatch: true,
			structurePreserved: true,
			issues: [`verifier-verdict-fail: ${verdictLine}`],
		};
		await appendEventAsync(manifest.eventsPath, {
			type: "task.output_validation",
			runId: manifest.runId,
			taskId: task.id,
			message: "Verifier verdict FAIL — task failed instead of completing green",
			data: {
				valid: false,
				formatMatch: true,
				structurePreserved: true,
				issues: outputValidation.issues,
				failureCause: "verifier-verdict-fail",
				verdict: "FAIL",
				verdictLine,
			},
		});
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
	// R4-5 (DR-02 wave 2): decorative contract — required green level but zero
	// verification commands — means satisfaction is purely self-attested. The
	// `decorative` flag is stamped by createVerificationEvidence; surface it in
	// the notes too so the evidence artifact reads honestly WITHOUT changing
	// the satisfied logic or defaultVerificationContract defaults.
	const seededEvidence: VerificationEvidence = baseEvidence.decorative
		? {
				...baseEvidence,
				notes: `${baseEvidence.notes ?? ""} — self-attested (no verification commands configured)`,
			}
		: baseEvidence;

	// Only execute verification commands when:
	// 1. Task completed successfully (no error)
	// 2. Verification contract has commands
	// 3. Not in scaffold mode (scaffold mode intentionally skips execution)
	let verificationEvidence: VerificationEvidence = seededEvidence;
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
			// B4 (DR-02 wave 2): verification execution THREW — fail CLOSED instead of
			// keeping the self-attested baseEvidence (satisfied=true via manual
			// evidence), which used to green-light a task whose verification never
			// ran. Only contracts that require a green level flip to unsatisfied;
			// level "none" has nothing to gate, so baseEvidence stays untouched.
			if (taskPacket.verification && taskPacket.verification.requiredGreenLevel !== "none") {
				const message = execError instanceof Error ? execError.message : String(execError);
				verificationEvidence = {
					...seededEvidence,
					satisfied: false,
					observedGreenLevel: "none",
					notes: `Verification execution failed (fail-closed): ${message}`,
				};
			}
		}
	}

	// ─── M3-2 (R47-3/V4): PASS required for VERIFIED ───
	// Command-backed evidence stands on its own (a verifier task whose contract
	// declares real commands is verified by their exit codes). Without commands
	// the evidence is SELF-ATTESTED, and self-attestation of a verifier task is
	// now gated on its own verdict line:
	//   PASS           → satisfied, note stamped (the verdict was consumed);
	//   missing/none   → observedGreenLevel "none" + satisfied:false, so
	//                    policy-engine (evaluateGreenContract → green_unsatisfied)
	//                    blocks the run instead of closing it green.
	if (verifierVerdictApplies && !error && taskPacket.verification) {
		const commandBacked = verificationEvidence.commands.some((command) => command.status === "passed");
		if (!commandBacked) {
			const notes = verificationEvidence.notes ?? "";
			verificationEvidence =
				verifierVerdict === "pass"
					? { ...verificationEvidence, satisfied: true, notes: `${notes} — verifier verdict: PASS`.trim() }
					: {
							...verificationEvidence,
							satisfied: false,
							observedGreenLevel: "none",
							notes: `${notes} — not verified: verifier output carries no PASS:/FAIL: verdict line`.trim(),
						};
		}
	}

	// --- T4/R6 (ADR-6 §3/§4): SPEC-EVIDENCE gate (coverage default, strict opt-in) ---
	// Extends the classifier seam above. All mechanics live in computeSpecGate
	// (unit-testable, round-1 P3): footer = union of every authoritative result
	// source (rawFinalText/finalText/finalStdout — compaction can empty finalText
	// while the footer survives elsewhere); sandbox cwd = the TASK workspace
	// (worktree-aware); scaffold mode + already-failed tasks skip machine-checks;
	// a strict failure PREFIXES any pre-existing error (round-1 P3).
	const specGateResult = await computeSpecGate({
		packet: taskPacket,
		rawFinalText,
		finalText: parsedOutput?.finalText,
		finalStdout,
		sandboxCwd: task.cwd,
		runtimeKind,
		alreadyFailed: Boolean(error),
	});
	for (const event of specGateResult.events) {
		await appendEventAsync(manifest.eventsPath, {
			type: event.type,
			runId: manifest.runId,
			taskId: task.id,
			data: event.data,
		});
	}
	if (specGateResult.specGate?.badge) {
		await appendEventAsync(manifest.eventsPath, {
			type: "task.spec_gate",
			runId: manifest.runId,
			taskId: task.id,
			data: {
				mode: specGateResult.specGate.mode,
				badge: specGateResult.specGate.badge,
				footerPresent: specGateResult.specGate.footerPresent,
				missingMustIds: specGateResult.specGate.missingMustIds,
				unknownIds: specGateResult.specGate.unknownIds,
				...(specGateResult.specGate.strict ? { strictPassed: specGateResult.specGate.strict.passed } : {}),
			},
		});
	}
	const specGate = specGateResult.specGate;
	if (specGateResult.gateError) {
		// Strict gate failure fails the write-gate (ADR §4) — prefix, never
		// replace, the upstream failure cause (round-1 P3).
		error = error ? `${error}; ${specGateResult.gateError}` : specGateResult.gateError;
		exitCode = exitCode === 0 ? 1 : exitCode;
	}

	// W10-8 batch-A visibility: emit the one-line stderr event exactly when
	// the note below is stamped (only on detection).
	if (readLaneMutation) warnReadLaneMutation(task.id, readLaneMutation);
	task = {
		...task,
		status: error ? "failed" : noYield ? "needs_attention" : "completed",
		finishedAt: new Date().toISOString(),
		exitCode,
		modelAttempts,
		usage: parsedOutput?.usage,
		// W10-7 (v0.11.38): reconcile per-attempt costs (failed fallbacks burn
		// real tokens that the final run's usage never shows) against the final
		// cost — observability note only, >5% gap with >1 usage-carrying attempt.
		...(reconcileUsage(modelAttempts, parsedOutput?.usage) ?? {}),
		...(readLaneMutation ? { unexpectedMutation: readLaneMutation } : {}),
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
		// FIX-2 note: no pid at write time — terminal touch, worker already
		// exited; the live pid was pinned at spawn (child-executor).
		heartbeat: touchWorkerHeartbeat(task.heartbeat ?? createWorkerHeartbeat(task.id), { alive: false }),
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
			...(breakdownArtifact ? [breakdownArtifact] : []),
			...(resultArtifact ? [resultArtifact] : []),
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
	// R6-1 (DR-03): persistSingleTaskUpdate may have PRESERVED a disk terminal
	// status (e.g. cancelled by crash-recovery / stale-reconciler) instead of
	// this worker's settle status. Everything downstream of the persist — the
	// agents.json record, the terminal event, and the after_task_complete hook
	// status — must match the PRESERVED record, never the in-memory verdict.
	const persistedTask = tasks.find((t) => t.id === task.id) ?? task;
	const preservedStatus: TeamTaskStatus | undefined = persistedTask.status !== task.status ? persistedTask.status : undefined;
	const effectiveStatus: TeamTaskStatus = preservedStatus ?? task.status;
	upsertCrewAgent(manifest, recordFromTask(manifest, persistedTask, runtimeKind));
	// Execute task_result hook before emitting terminal event
	const hookReport = await executeHook("task_result", {
		runId: manifest.runId,
		taskId: task.id,
		cwd: manifest.cwd,
	});
	appendHookEvent(manifest, hookReport);
	// R6-1: emit the terminal event for the PRESERVED status when one was
	// preserved (task.cancelled over a cancelled record — never task.completed);
	// otherwise the inferred settle event exactly as before.
	const terminalEventType = TERMINAL_TASK_EVENT_TYPES[effectiveStatus];
	if (terminalEventType !== undefined) {
		// bug-026 sub-issue B: surface the classified fatal-fs cause (enospc/
		// edquot/emfile/enfile) on the failure event so operators see "disk
		// full" instead of a generic timeout diagnostic.
		const eventData: Record<string, unknown> = {
			...(task.failureCause ? { failureCause: task.failureCause } : {}),
			...(preservedStatus ? { preservedFrom: task.status } : {}),
		};
		await appendEventAsync(manifest.eventsPath, {
			type: terminalEventType,
			runId: manifest.runId,
			taskId: task.id,
			// For a preserved terminal the disk record's error (the cancel
			// reason) is the truthful message; otherwise the settle error.
			message: preservedStatus ? (persistedTask.error ?? error) : error,
			...(Object.keys(eventData).length > 0 ? { data: eventData } : {}),
		});
	}

	// Execute after_task_complete lifecycle hook (non-blocking)
	const afterTaskReport = await executeHook("after_task_complete", {
		runId: manifest.runId,
		taskId: task.id,
		cwd: manifest.cwd,
		status: effectiveStatus,
	});
	appendHookEvent(manifest, afterTaskReport);

	return { manifest, tasks };
}

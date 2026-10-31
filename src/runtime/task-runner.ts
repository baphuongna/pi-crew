import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewLimitsConfig, CrewRuntimeConfig } from "../config/config.ts";
import type { MetricRegistry } from "../observability/metric-registry.ts";
import { appendEventFireAndForget } from "../state/event-log/event-log.ts";
import { writeArtifact } from "../state/stores/artifact-store.ts";
import type { ArtifactDescriptor, OperationTerminalEvidence, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";
import { resolveClassifierEnabled, resolveClassifierModel } from "./classifier/classifier-service.ts";
import type { CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { registerStreamBridge } from "./event-stream-bridge.ts";
import type { ModelAttemptSummary } from "./model/model-fallback.ts";
import { awaitRuntimeWarmup } from "./model/runtime-warmup.ts";
import type { ParsedPiJsonOutput } from "./output/pi-json-output.ts";
import type { ResultArtifactReadCache } from "./task-output-context.ts";
import { runChildProcessTask } from "./task-runner/child-executor.ts";
// Type-only imports (erased at runtime — hybrid-tier stays lazily loaded).
import type { EmbeddedLiveOutcome, EmbeddedTierPlan } from "./task-runner/hybrid-tier.ts";
import { finalizeTaskResult, type TaskExecutionResult } from "./task-runner/post-execution.ts";
import { prepareTaskExecutionContext } from "./task-runner/pre-execution.ts";
import { cleanResultText } from "./task-runner/result-utils.ts";
import { runScaffoldTask } from "./task-runner/scaffold-executor.ts";
import { renderVerifyGateSummary, resolveVerifyGateEnabled, runVerifierGatePreGate } from "./verification/verify-gate.ts";
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
	/** P2-1 (pi 1.0.4 adoption): host-process metric registry threaded from
	 *  ExecuteTeamRunInput so the retry-triage classifier seam can count its
	 *  calls/decisions (crew.classifier.* counters). Optional — undefined keeps
	 *  the uncounted behavior (e.g. tests, hand-built contexts). */
	metricRegistry?: MetricRegistry;
	modelOverride?: string;
	teamRoleModel?: string;
	teamRoleFallbackModels?: string[];
	/** Per-role thinking level override (teamRole.thinking). Takes precedence over agent.thinking. */
	teamRoleThinking?: string;
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
	/**
	 * R10-1 residual: per-run result-artifact read cache shared with the
	 * closeout aggregation. Threading it here lets collectDependencyOutputContext
	 * reuse reads the closeout already performed (fan-in graphs re-read the same
	 * `results/<taskId>.txt` once per downstream dispatch + retry). ONE instance
	 * per RUN (created in executeTeamRunCore, spread through baseInput so
	 * retries inherit it by reference) — never per call. Optional: undefined
	 * keeps the uncached behavior.
	 */
	resultReadCache?: ResultArtifactReadCache;
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
		// ── U11 (hybrid 2-tier worker model): embedded-tier routing — DEFAULT-OFF ──
		// When runtime.embeddedWorkers is enabled AND the task's role opted in,
		// an otherwise-child-process task runs on the EMBEDDED tier (an
		// in-process live-session worker) with the SHARED global slot budget, a
		// fail-fast embedded ceiling, and the automatic 2-fault fallback to
		// subprocess. All of it lives in the lazily imported hybrid-tier
		// module — with the policy off (the default) this block never imports
		// it: no events, no budget reads, zero behavior change. The routing
		// guards (scaffold / depth>0 / isolatedRoles) are resolved inside
		// resolveTaskRuntimeKind and cannot be weakened by the opt-in.
		let tierPlan: EmbeddedTierPlan | undefined;
		if (
			input.runtimeConfig?.embeddedWorkers?.enabled === true &&
			input.executeWorkers &&
			input.runtimeKind !== "scaffold" &&
			input.taskRuntimeOverride !== "scaffold"
		) {
			// LAZY: hybrid-tier (tier planning + fault ledger + budget guard) loads only
			// when the embedded tier policy is enabled.
			const { planEmbeddedTier } = await import("./task-runner/hybrid-tier.ts"); // LAZY: embedded-tier policy path only
			tierPlan = planEmbeddedTier({
				baseRuntimeKind: input.taskRuntimeOverride ?? input.runtimeKind ?? "child-process",
				role: input.task.role,
				isolationPolicy: input.runtimeConfig?.isolationPolicy,
				runtimeConfig: input.runtimeConfig,
				task: input.task,
				manifest,
				env: process.env,
			});
		}
		const prepared = await prepareTaskExecutionContext(
			// Embedded-routed tasks execute as live-session (consistent agent
			// records + startup evidence labels; the child-only "started"
			// checkpoint stays off — the embedded attempt has no child pid).
			tierPlan?.route === "embedded" ? { ...input, taskRuntimeOverride: "live-session" } : input,
			manifest,
			streamBridge,
		);
		if (prepared.kind === "cancelled") return prepared.result;
		const ctx = prepared.ctx;
		// ── U13 (upgrade spec 2026-10-09): deterministic verifier pre-gate ──
		// For verifier-role tasks, run the deterministic gate (typecheck /
		// test:critical via package.json scripts, subprocess executor) BEFORE
		// spawning the LLM verifier worker:
		//   - gate PASS → SKIP the spawn: terminalize the task as completed
		//     with the gate evidence as its result (spec acceptance: "một run
		//     verification với gate xanh không spawn LLM verifier");
		//   - gate FAILED/INCONCLUSIVE (+ U6B classifier layer on the latter)
		//     → spawn the LLM verifier as today, with the gate results appended
		//     to its prompt (it diagnoses; it does not re-derive exit codes).
		// Disabled by PI_CREW_VERIFY_GATE=0; scaffold runtime never gates.
		if (ctx.task.role === "verifier" && ctx.runtimeKind !== "scaffold" && resolveVerifyGateEnabled()) {
			// PHASE 4 (U13-ADJ): the verify-gate itself must NEVER fail a task —
			// any unexpected error in the pre-gate block (engine bug, FS failure
			// on an artifact write) degrades to the ungated verifier spawn
			// (exactly the pre-U13 behavior) instead of throwing out of runTeamTask.
			// FIX (review round): the SKIP-path finalizer call is deliberately NOT
			// inside this try — it is hoisted below. When `return await
			// finalizeTaskResult(...)` lived in the try, a finalizer throw was
			// swallowed by the belt catch and execution FELL THROUGH to the
			// verifier spawn AFTER the skip event was emitted and diagnostics
			// mutated (double-finalize / divergent task state). A finalizer error
			// must propagate out of runTeamTask, exactly like the normal path's
			// finalizer (pre-belt semantics).
			let skipFinalize: TaskExecutionResult | undefined;
			try {
				const preGate = await runVerifierGatePreGate({
					cwd: ctx.task.cwd,
					// M1-7 (R47-1): host-owned ground truth pinned on the manifest at
					// dispatch — the gate verifies manifest integrity against it and
					// never re-derives checks from the worker-mutable task-cwd
					// package.json. Absent (old manifests / goal-loop runs) ⇒ the gate
					// resolves no checks ⇒ INCONCLUSIVE ⇒ verifier spawns (fail-closed).
					...(manifest.verifyGateSpec ? { hostSpec: manifest.verifyGateSpec } : {}),
					// W2 (worktree-verifier-gate-excludes-work): a green gate in THIS
					// task's tree must never certify dependency work it cannot see —
					// probe each dependency task's worktree; uncommitted work there
					// forces the LLM verifier spawn even on a PASS verdict (reason
					// "unverified_worktree_work"). Shared-cwd deps (no worktree) need
					// no probe — their work is inside the gate's own cwd.
					...(ctx.task.dependsOn.length > 0
						? {
								dependencyWorktreeProbes: ctx.task.dependsOn.map((depId) => ({
									taskId: depId,
									worktreePath: ctx.tasks.find((t) => t.id === depId)?.worktree?.path,
								})),
							}
						: {}),
					// S-1 (shared-cwd-untracked-harness, HIGH, 2026-10-31): host-owned
					// task records at gate time — the gate refuses the deterministic
					// skip when a WRITE-role task EXECUTED in the gate's own cwd
					// (gitignored node_modules shims sit outside every pinned binding,
					// so a shared-cwd executor's tampered harness could grade its own
					// gate). Host in-memory records ONLY — the gate must never read the
					// worker-mutable tasks.json itself. The verifier's own record is
					// excluded: the gate runs BEFORE its spawn.
					taskRecords: ctx.tasks
						.filter((t) => t.id !== ctx.task.id)
						.map((t) => ({
							taskId: t.id,
							role: t.role,
							status: t.status,
							cwd: t.cwd,
							worktreePath: t.worktree?.path,
						})),
					signal: input.signal,
					classifier: {
						enabled: resolveClassifierEnabled(input.runtimeConfig?.classifierEnabled),
						modelRegistry: input.modelRegistry,
						classifierModel: resolveClassifierModel(input.runtimeConfig?.classifierModel),
						eventsPath: manifest.eventsPath,
						runId: manifest.runId,
						taskId: ctx.task.id,
					},
					metricRegistry: input.metricRegistry,
				});
				// Diagnostic event (task.verifier_pre_gate — U6B's event type; now REGISTERED
				// in TEAM_EVENT_TYPES at src/state/contracts.ts:306, so the earlier
				// "report-only pending a src/state/** lane" note is stale — checked clean
				// by `check:event-types --enforce` in CI).
				appendEventFireAndForget(manifest.eventsPath, {
					type: "task.verifier_pre_gate",
					runId: manifest.runId,
					taskId: ctx.task.id,
					message: preGate.decision.skipVerifier
						? `Deterministic verify_gate ${preGate.outcome.verdict} — LLM verifier spawn SKIPPED (${preGate.decision.reason})`
						: `Deterministic verify_gate ${preGate.outcome.verdict} — LLM verifier spawns with gate context (${preGate.decision.reason})`,
					data: {
						verdict: preGate.outcome.verdict,
						decision: preGate.decision,
						evidenceLines: preGate.outcome.evidenceLines,
						...(preGate.outcome.determinismNote ? { determinismNote: preGate.outcome.determinismNote } : {}),
						...(preGate.preGate ? { classifierAction: preGate.preGate.action } : {}),
					},
				});
				if (preGate.decision.skipVerifier) {
					// Terminalize WITHOUT spawning: synthesize the branch result (gate
					// summary as the task result artifact + stdout) and reuse the full
					// finalizer — events, hooks, persistence, verification evidence.
					const summary = renderVerifyGateSummary(preGate.outcome, preGate.decision.reason);
					// PHASE 4 gap 1 (U13-ADJ): the skip-path artifact write must NEVER
					// fail the task — an FS error here (ENOSPC / EACCES / ENOTDIR)
					// degrades to "no result artifact" (the finalizer treats it as
					// optional) instead of throwing out of runTeamTask.
					let resultArtifact: ArtifactDescriptor | undefined;
					try {
						resultArtifact = writeArtifact(manifest.artifactsRoot, {
							kind: "result",
							relativePath: `results/${ctx.task.id}.txt`,
							content: `${summary}\n`,
							producer: ctx.task.id,
						});
					} catch (error) {
						console.error(
							`[task-runner] verify-gate skip-path writeArtifact failed — degrading (task continues without a result artifact): ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
					ctx.task = {
						...ctx.task,
						// Provenance: this verdict came from the deterministic gate, not a
						// model attempt (U6B mount note: evaluator/model provenance marker).
						diagnostics: {
							...(ctx.task.diagnostics ?? {}),
							verifyGate: {
								verdict: preGate.outcome.verdict,
								reason: preGate.decision.reason,
								evidenceLines: preGate.outcome.evidenceLines,
							},
							// R47-V7 (2026-10-19): the skip path FABRICATES the terminal result
							// below (exitCode:0, green summary, no model attempts). Tag the
							// provenance so consumers — the effectiveness guard — never mistake
							// this synthesized result for real worker output.
							// taskIsSyntheticGateSkip() (effectiveness.ts) reads this flag.
							synthetic: true,
						},
					};
					// FIX (review round): prepare the finalizer args here but DO NOT
					// call finalizeTaskResult inside the belt try — see the hoisted
					// call right after the catch below.
					skipFinalize = {
						resultArtifact,
						logArtifact: undefined,
						transcriptArtifact: undefined,
						exitCode: 0,
						error: undefined,
						modelAttempts: [],
						parsedOutput: undefined,
						finalStdout: summary,
						transcriptPath: undefined,
						terminalEvidence: [],
						startupEvidence: ctx.startupEvidence,
					};
				}
				if (preGate.promptContext) {
					// Spawn proceeds — attach the gate results to the verifier prompt
					// (both channels: full prompt + the user-message half). The prompt
					// artifact was written in pre-execution with the PRE-gate prompt;
					// rewrite it so the persisted artifact matches what the worker saw.
					ctx.prompt = `${ctx.prompt}\n\n${preGate.promptContext}`;
					if (ctx.userPrompt !== undefined) ctx.userPrompt = `${ctx.userPrompt}\n\n${preGate.promptContext}`;
					if (ctx.promptArtifact) {
						// PHASE 4 gap 1 (cont.): same never-fail-a-task degrade for the
						// prompt-artifact rewrite — on FS failure keep the pre-gate
						// artifact on disk (the worker still gets the extended prompt).
						try {
							ctx.promptArtifact = writeArtifact(manifest.artifactsRoot, {
								kind: "prompt",
								// Same relative-path convention pre-execution used
								// (prompts/<taskId>.md) — ArtifactDescriptor carries only the
								// absolute path, so the rewrite re-derives the relative path.
								relativePath: `prompts/${ctx.task.id}.md`,
								content: `${ctx.prompt}\n`,
								producer: ctx.task.id,
							});
						} catch (error) {
							console.error(
								`[task-runner] verify-gate prompt-artifact rewrite failed — degrading (persisted prompt keeps the pre-gate content): ${
									error instanceof Error ? error.message : String(error)
								}`,
							);
						}
					}
				}
			} catch (error) {
				console.error(
					`[task-runner] verify-gate pre-gate error — degrading to the ungated verifier spawn: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			// FIX (review round): skip-path finalizer — OUTSIDE the belt try so a
			// finalizer throw propagates out of runTeamTask (pre-belt semantics)
			// instead of being swallowed and falling through to the verifier spawn.
			if (skipFinalize !== undefined) {
				return await finalizeTaskResult(ctx, skipFinalize);
			}
		}
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

		// MuxSurface degrade path returns NO result artifact — undefined until a
		// branch produces one. RR-013 (F04): the finalizer's `surfaceLost` branch
		// IS reachable from this function — `surfaceLost` below is forwarded from
		// the child-process branch into `execResult`. That branch intentionally
		// ignores `resultArtifact` (no fabricated result for a lost worker).
		let resultArtifact: ArtifactDescriptor | undefined;
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
		// RR-013 (F04): the child-process branch may return these two fields; every
		// other branch leaves them undefined. They MUST be forwarded into
		// `execResult` — the hand-maintained field list here previously dropped
		// `surfaceLost` (which made finalizeTaskResult's `needs_attention`
		// terminalisation UNREACHABLE in production: a worker that lost its pane
		// was reported `completed` with no result) and `rawFinalText` (which
		// starved the spec-evidence footer union at post-execution.ts).
		//
		// Do NOT set these in the live-session/scaffold branches: live-session has
		// its own terminalisation path and scaffold must not inherit the degrade
		// branch. Leaving them undefined preserves those branches' behavior.
		let surfaceLost: TaskExecutionResult["surfaceLost"];
		let rawFinalText: string | undefined;
		// Finding #2 (2026-09-29 battery): result-artifact provenance tag from the
		// child-executor fallback chain — MUST be forwarded like surfaceLost/
		// rawFinalText above, or finalizeTaskResult's deterministic
		// stderr/none-source gate silently degrades to classifier-only.
		let resultSource: TaskExecutionResult["resultSource"];
		// Maps a completed child-executor run onto the branch locals. Shared by
		// the child-process branch and the U11 embedded→subprocess FALLBACK
		// path (which runs the child executor on the same task after the
		// embedded attempt resolved — sequential, single-writer preserved).
		const applyChildOutcome = (child: Awaited<ReturnType<typeof runChildProcessTask>>): void => {
			task = ctx.task;
			tasks = ctx.tasks;
			resultArtifact = child.resultArtifact ?? resultArtifact;
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
			surfaceLost = child.surfaceLost;
			rawFinalText = child.rawFinalText;
			resultSource = child.resultSource;
		};
		if (runtimeKind === "child-process") {
			// CORE-5 extraction 4: the entire child-process branch (model routing +
			// model-fallback attempt loop, runWorker callbacks, R3 listener-leak
			// cleanup, heartbeat persistence, transcript parsing, artifact assembly)
			// now lives in task-runner/child-executor.ts. It mutates ctx.task /
			// ctx.tasks in place and returns the branch output bag.
			// U11: embedded-routed tasks never reach this branch — the tier plan
			// overrode taskRuntimeOverride to "live-session" before pre-execution.
			applyChildOutcome(await runChildProcessTask(ctx));
		} else if (runtimeKind === "live-session") {
			// One live-session attempt as a closure so the U11 hybrid-tier wrapper
			// (shared slot budget + fault ledger + fallback decision) can run it,
			// while the legacy path (tierPlan undefined) keeps the pre-U11 flow.
			const runLiveBranch = async (): Promise<EmbeddedLiveOutcome> => {
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
					teamRoleFallbackModels: input.teamRoleFallbackModels,
					teamRoleThinking: input.teamRoleThinking,
					workspaceId: input.workspaceId,
					// U11: embedded-tier mitigation knobs (lane-B contract) — passed
					// ONLY on the hybrid-routed path so the live-session layer keeps
					// every mitigation inert on the legacy live-session path. The
					// session-side cap mirrors the routing-side ceiling above.
					...(tierPlan?.route === "embedded"
						? {
								embeddedMitigations: {
									...(tierPlan.policy.maxConcurrent !== undefined
										? { maxConcurrentEmbedded: tierPlan.policy.maxConcurrent }
										: {}),
									tier: "embedded",
								},
							}
						: {}),
				});
				// Bug #21 fix: live-session may not produce structured output via submit_result,
				// leaving finalText empty. Re-write resultArtifact with parsedOutput.finalText
				// so downstream tasks that depend on this task can read meaningful output.
				const liveText = cleanResultText(live.parsedOutput?.finalText);
				const liveResultArtifact = liveText
					? // Re-write the artifact with the captured stdout — this is the content
						// downstream tasks will read via task.resultArtifact.path.
						writeArtifact(manifest.artifactsRoot, {
							kind: "result",
							relativePath: `results/${live.task.id}.txt`,
							content: liveText,
							producer: live.task.id,
						})
					: live.resultArtifact;
				return {
					// Sync task.resultArtifact with the re-written artifact (if liveText was truthy)
					task: { ...live.task, resultArtifact: liveResultArtifact },
					tasks: live.tasks,
					startupEvidence: live.startupEvidence,
					exitCode: live.exitCode,
					error: live.error,
					fault: live.fault,
					parsedOutput: live.parsedOutput,
					resultArtifact: liveResultArtifact,
					logArtifact: live.logArtifact,
					transcriptArtifact: live.transcriptArtifact,
				};
			};
			const applyLiveOutcome = (live: EmbeddedLiveOutcome): void => {
				task = live.task;
				tasks = live.tasks;
				startupEvidence = live.startupEvidence;
				exitCode = live.exitCode;
				error = live.error;
				parsedOutput = live.parsedOutput;
				resultArtifact = live.resultArtifact;
				logArtifact = live.logArtifact;
				transcriptArtifact = live.transcriptArtifact;
			};
			if (tierPlan?.route !== "embedded") {
				applyLiveOutcome(await runLiveBranch());
			} else {
				// U11 hybrid tier — shared global slot budget, embedded ceiling, fault
				// ledger, and the 2-fault fallback decision around the embedded attempt.
				const { runEmbeddedTier } = await import("./task-runner/hybrid-tier.ts"); // LAZY: embedded-routed path only
				const tier = await runEmbeddedTier({
					plan: tierPlan,
					manifest,
					task,
					tasks,
					signal: input.signal,
					runLive: runLiveBranch,
				});
				if (tier.kind === "live") {
					applyLiveOutcome(tier.live);
				} else {
					// U11 automatic fallback: the embedded attempt exhausted its fault
					// budget (or hit the embedded ceiling) — reroute THIS attempt to
					// the subprocess tier. Sequential by construction (runLive
					// resolved and flushed its sinks before the decision), so the
					// single-writer invariant (crew-agent-records.ts) holds. Flip
					// ctx.runtimeKind so child-executor labels the attempt
					// child-process (agent records + transcript path resolution).
					ctx.task = tier.task;
					ctx.tasks = tier.tasks;
					ctx.runtimeKind = "child-process";
					applyChildOutcome(await runChildProcessTask(ctx));
				}
			}
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
			surfaceLost,
			rawFinalText,
			resultSource,
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

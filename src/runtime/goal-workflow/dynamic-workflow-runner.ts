/**
 * dynamic-workflow-runner.ts — Script-driven workflow runtime (P2).
 *
 * Spec: research-findings/goal-workflow/00-SPEC.md §3.3
 * Plan: 07-PLAN.md v3 P2 + §0c C5 (resolveRealContainedPath).
 *
 * Loads a `.dwf.ts` script's default export, transpiles it via jiti (the existing
 * TS loader used by async-runner.ts), and executes it with a FROZEN WorkflowCtx.
 *
 * HONEST v1 TRUST MODEL (review H-2): vm.runInNewContext is NOT used in v1 — the
 * script runs in plain module scope with full access to require/import/process.
 * The 'capability-locked WorkflowCtx' is the documented contract surface, NOT a
 * sandbox. A script can reach process/require via constructor walking or direct
 * import. `.dwf.ts` files MUST be commit-reviewed (postinstall-equivalent trust).
 * The path-allowlist (resolveRealContainedPath) limits WHERE scripts load from,
 * not WHAT they can do. isolated-vm (real V8 isolate) is planned for v1.5.
 * See docs/dynamic-workflows.md for the full threat model.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getCrewEnv } from "../../config/env-vars.ts";
import { appendEventAsync } from "../../state/event-log/event-log.ts";
import { writeArtifact } from "../../state/stores/artifact-store.ts";
import { saveRunManifestAsync } from "../../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { packageRoot, projectCrewRoot, userPiRoot } from "../../utils/paths.ts";
import { safeAbort } from "../../utils/safe-abort.ts";
import { resolveRealContainedPath } from "../../utils/safe-paths.ts";
import type { DynamicWorkflowConfig } from "../../workflows/workflow-config.ts";
import { assertDeterministicScript, isDeterminismCheckEnabled } from "../deterministic-ast.ts";
import { DwfStore } from "../dwf-state-store.ts";
import { getWorkflowFinalResult, getWorkflowPhaseState, makeWorkflowCtx } from "./dynamic-workflow-context.ts";

// RR-021 WI-2.1: esbuild is a heavy native dep (~35ms+ cold load) but is only
// needed when a .dwf.ts script actually executes. Lazy-load via a synchronous
// createRequire shim on first use (model: ui/syntax-highlight.ts) — call sites
// stay sync. esbuild remains external in the bundle and resolves through here.
const nodeRequire = createRequire(import.meta.url);
type EsbuildModule = typeof import("esbuild");
let cachedEsbuild: EsbuildModule | undefined;
function esbuild(): EsbuildModule {
	if (!cachedEsbuild) cachedEsbuild = nodeRequire("esbuild") as EsbuildModule;
	return cachedEsbuild;
}

export interface RunDynamicWorkflowInput {
	manifest: TeamRunManifest;
	workflow: DynamicWorkflowConfig;
	/** Optional team for role resolution (G4 tier 2). */
	team?: import("../../teams/team-config.ts").TeamConfig;
	signal: AbortSignal;
	concurrency?: number;
	modelOverride?: string;
	/** round-14 P1-2: per-workflow token budget. Overrides workflow.maxTokenBudget. */
	tokenBudget?: number;
	/** SDD-3 W-C G13: cap on ctx.agent() invocations. Overrides
	 *  workflow.maxAgentCalls; unset/invalid → DEFAULT_MAX_AGENT_CALLS.
	 *  Accepts stringified numbers (schema Union numeric-string branch; the
	 *  team-tool loose-numeric coercion list is owned by team-tool.ts, so this
	 *  boundary coerces defensively). */
	maxAgentCalls?: number | string;
}

export interface RunDynamicWorkflowResult {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
}

/** The signature a .dwf.ts default export must satisfy. */
export type DynamicWorkflowScript = (ctx: import("./dynamic-workflow-context.ts").WorkflowCtx) => Promise<void> | void;

/**
 * round-12 P0-4: defensive structured-clone guard at the runner boundary.
 *
 * Today this is mostly future-proofing: a DWF script's `setResult()` path
 * reads an artifact file as a string, and strings are always structured-
 * cloneable. But if a future code path produces a non-cloneable value
 * (e.g. a Worker postMessage payload that wraps a Symbol or function), we
 * want a clear, actionable error here — not a cryptic `DataCloneError`
 * from deep inside the artifact store. The error message also nudges
 * users toward the most common cause: forgetting `await` on ctx.agent()
 * or ctx.review() in their script.
 */
function assertStructuredCloneable(value: unknown, name: string): void {
	try {
		structuredClone(value);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${name} must be structured-cloneable; did you forget to await ctx.agent() or ctx.review()? ${detail}`);
	}
}

/**
 * Resolve + validate the script path against the allowlist of workflow dirs (§0c C5).
 * Returns the real contained path or throws.
 */
function resolveScriptPath(workflow: DynamicWorkflowConfig, cwd: string): string {
	const crewRoot = projectCrewRoot(cwd);
	// Allowlist: the script must resolve inside one of the workflow discovery dirs.
	// (discover-workflows.ts only reads from packageRoot/workflows, userPiRoot/workflows,
	//  and projectCrewRoot/workflows — so the script already came from an allowed dir,
	//  but we still validate containment to defeat symlink traversal.)
	// Fix round-5 P1: the round-4 P2-5 fix over-corrected to a SINGLE base (crewRoot/workflows).
	// But discoverWorkflows() reads from THREE dirs (builtin, user, project). Use the same bases
	// so user/builtin dynamic workflows aren't rejected.
	const allowedBases = [join(projectCrewRoot(cwd), "workflows"), join(userPiRoot(), "workflows"), join(packageRoot(), "workflows")];
	for (const base of allowedBases) {
		try {
			const real = resolveRealContainedPath(base, workflow.filePath);
			if (real) return real;
		} catch {
			// not contained in this base — try next
		}
	}
	// Not contained in any allowed base — refuse (do NOT fall back to the raw path).
	throw new Error(
		`Dynamic workflow '${workflow.filePath}' is outside the allowed workflows directories (${allowedBases.join(", ")}). Refusing to load.`,
	);
}

/**
 * Transpile + load the .dwf.ts default export. Uses jiti (already a dep) for TS→JS.
 * Returns the default export function or throws.
 *
 * Round-13 P0-2: after reading the script source, run `assertDeterministicScript`
 * to reject non-deterministic calls (Date.now()/Math.random()/new Date()) BEFORE
 * jiti executes the module. The check is opt-out via PI_CREW_DWF_SKIP_DETERMINISM_CHECK=1.
 */
async function loadWorkflowModule(scriptPath: string): Promise<DynamicWorkflowScript> {
	// Round-13 P0-2: read source first so we can AST-scan before execution.
	// jiti does not surface the transpiled source back to us, so we read the
	// raw .dwf.ts file. This is the same source jiti will execute.
	const scriptSource = readFileSync(scriptPath, "utf-8");
	if (isDeterminismCheckEnabled()) {
		// DISC-1: acorn can only parse JavaScript, not TypeScript. Real .dwf.ts files
		// contain type annotations/imports that cause a silent parse error, so the
		// determinism check never runs. Transpile to JS via esbuild first.
		const js = esbuild().transformSync(scriptSource, { loader: "ts", format: "esm" }).code;
		assertDeterministicScript(js);
	}
	// jiti is the same loader async-runner.ts uses (resolveTypeScriptLoader). We require it
	// lazily so this module stays importable in environments without jiti (type-only consumers).
	// Fix round-4: use createRequire(import.meta.url) so `require` works under the strip-types
	// loader fallback (Node ≥ 22.6) where bare `require` is not defined in ESM scope.
	// LAZY: defer dynamic import of node:module to its call site.
	const { createRequire } = await import("node:module");
	const require = createRequire(import.meta.url);
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const createJiti = require("jiti").default ?? require("jiti");
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const mod = await jiti(scriptPath);
	const fn = (mod as { default?: unknown }).default ?? mod;
	if (typeof fn !== "function") {
		throw new Error(`Dynamic workflow '${scriptPath}' must export a default async function(ctx).`);
	}
	return fn as DynamicWorkflowScript;
}

/** SDD-3 W-C G13: resolve the effective agent-call cap from the runner input /
 *  workflow config. Accepts the schema's stringified-number form; anything
 *  non-finite or < 1 falls back to the ctx default (DEFAULT_MAX_AGENT_CALLS). */
function resolveMaxAgentCalls(value: number | string | undefined | null): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n < 1) return undefined;
	return Math.floor(n);
}

/**
 * Run the dynamic workflow script. Loads it, builds the ctx, executes, and returns
 * {manifest, tasks} with the manifest updated to a terminal status + result artifact.
 */
export async function runDynamicWorkflow(input: RunDynamicWorkflowInput): Promise<RunDynamicWorkflowResult> {
	const { manifest, workflow, signal } = input;
	const eventsPath = manifest.eventsPath;
	const scriptPath = resolveScriptPath(workflow, manifest.cwd);

	// w3-dwf-trust: dispatch-time pin stamping (single point). The FIRST entry to the
	// runner for a run IS the dispatch — stamp manifest.dynamicScriptPin with the exact
	// resolved script path + sha256 of the CURRENT bytes and persist before any module
	// load. Both resume arms funnel back through runDynamicWorkflow, so every later
	// entry hits the pin-mismatch verification below: a plant that swaps the file
	// between dispatch and resume is refused instead of executing swapped bytes.
	// Absent pin (legacy manifests) gets stamped on first resume — backward compatible.
	if (manifest.dynamicScriptPin === undefined) {
		let sha256: string;
		try {
			sha256 = createHash("sha256").update(readFileSync(scriptPath)).digest("hex");
		} catch (error) {
			logInternalError("dynamic-workflow-runner: pin stamp hash failed", error);
			throw new Error(
				`Dynamic workflow script '${scriptPath}' could not be read for dispatch-time pinning — refusing to execute an unhashable script.`,
			);
		}
		manifest.dynamicScriptPin = { scriptPath, sha256 };
		try {
			await saveRunManifestAsync(manifest);
		} catch (error) {
			// Pin not durable → verification cannot be trusted later. Fail closed.
			logInternalError("dynamic-workflow-runner: pin stamp persist failed", error);
			throw new Error(`Dynamic workflow dispatch failed to persist the script pin — refusing to execute without a durable pin.`);
		}
	}

	// F-01: Trust gate — project/user-sourced .dwf.ts scripts have FULL Node access (process,
	// require, fs, child_process). Cloning a hostile repo and running its workflow = arbitrary
	// code execution; default-deny project workflows unless the user explicitly opts in via
	// PI_CREW_TRUST_PROJECT_DWF=1.
	// w3-dwf-trust (2026-10-29): the USER tier gets the SAME default-deny via
	// PI_CREW_TRUST_USER_DWF=1. ~/.pi/agent/workflows is writable by every WRITE-role
	// child worker (same OS uid, bash granted by role-tools), so directory location alone
	// is not human provenance: a worker-planted user-tier .dwf.ts previously executed in
	// this HOST process (parent env, in-memory broker state) and silently shadowed
	// same-named builtin/project workflows via the allWorkflows merge order. Builtin
	// (shipped, package-owned) workflows proceed without restriction.
	// U2 (2026-10-10): awaited appendEventAsync — the 2026-09-10 M2a revert
	// was required by BUFFERED (20ms-delayed) writes; awaiting the direct async
	// append keeps the read-your-writes contract (resume flow, dwf-setresult
	// tests, status display all read events only after runDynamicWorkflow
	// resolves) while dropping the sleepSync event-loop block.
	const trustEnv: "PI_CREW_TRUST_PROJECT_DWF" | "PI_CREW_TRUST_USER_DWF" | undefined =
		workflow.source === "project" ? "PI_CREW_TRUST_PROJECT_DWF" : workflow.source === "user" ? "PI_CREW_TRUST_USER_DWF" : undefined;
	if (trustEnv !== undefined && getCrewEnv(trustEnv) !== "1") {
		await appendEventAsync(eventsPath, {
			type: "dwf.trust_denied",
			runId: manifest.runId,
			data: { workflow: workflow.name, source: workflow.source, script: scriptPath },
		});
		throw new Error(
			workflow.source === "user"
				? `User dynamic workflow requires explicit trust. Set PI_CREW_TRUST_USER_DWF=1 to allow execution of user .dwf.ts scripts.`
				: `Project dynamic workflow requires explicit trust. Set PI_CREW_TRUST_PROJECT_DWF=1 to allow execution of project .dwf.ts scripts.`,
		);
	}

	// w3-dwf-trust: dispatch-time script pin. When the dispatcher stamped
	// manifest.dynamicScriptPin, re-hash the script bytes before EVERY load — fresh
	// dispatch AND both resume arms funnel through runDynamicWorkflow — so a plant
	// that swaps the file between dispatch and resume cannot execute. Optional/absent
	// on manifests dispatched before this field existed (and on dispatchers that do
	// not stamp it yet) → no pin verification (backward compatible).
	const pin = manifest.dynamicScriptPin;
	if (pin !== undefined) {
		let actualSha256: string | undefined;
		try {
			actualSha256 = createHash("sha256").update(readFileSync(scriptPath)).digest("hex");
		} catch {
			// Unreadable/missing script cannot match its pin — treat as mismatch.
			actualSha256 = undefined;
		}
		if (pin.scriptPath !== scriptPath || actualSha256 === undefined || pin.sha256 !== actualSha256) {
			await appendEventAsync(eventsPath, {
				type: "dwf.trust_denied",
				runId: manifest.runId,
				data: {
					workflow: workflow.name,
					source: workflow.source,
					script: scriptPath,
					reason: "script-pin-mismatch",
					...(actualSha256 !== undefined ? { expectedSha256: pin.sha256, actualSha256 } : {}),
				},
			});
			throw new Error(
				`Dynamic workflow script does not match the dispatch-time pin (path/sha256) — refusing to load a possibly swapped script. Re-dispatch the run to re-pin the current script bytes.`,
			);
		}
	}

	await appendEventAsync(eventsPath, {
		type: "dwf.started",
		runId: manifest.runId,
		data: { workflow: workflow.name, script: scriptPath },
	});

	// round-18 P2-3: resume/checkpoint. Load any existing checkpoint for this run's stateRoot.
	// stateRoot is already <crewRoot>/state/runs/<runId>, so the checkpoint lands at
	// <stateRoot>/dwf-checkpoint.json (no double-nesting). A missing checkpoint (fresh run)
	// yields undefined — makeWorkflowCtx starts with empty defaults (backward compatible).
	const dwfStore = new DwfStore(manifest.stateRoot);
	// w3-dwf-trust: bind the checkpoint to THIS run — a checkpoint whose runId
	// differs (stale/planted/enumerated under .crew/state/runs/) is rejected and
	// the run restarts fresh instead of replaying worker-writable state.
	const resumedState = dwfStore.load(manifest.runId);
	if (resumedState) {
		// R14-C3 (wave 7): fingerprint check — a resume that changes the dispatch
		// context (modelOverride/team) still replays the completed-call cache, but
		// that replay now carries an operator-visible mismatch warning instead of
		// silently passing off old-model results as current-model work.
		const savedCtx2 = resumedState.dispatchContext;
		const norm = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);
		if (savedCtx2 && norm(savedCtx2.modelOverride) !== norm(input.modelOverride)) {
			await appendEventAsync(eventsPath, {
				type: "dwf.resume_context_mismatch",
				runId: manifest.runId,
				data: {
					axis: "modelOverride",
					checkpoint: savedCtx2.modelOverride ?? null,
					current: input.modelOverride ?? null,
				},
				message: `resume modelOverride differs from checkpoint (was ${savedCtx2.modelOverride ?? "default"}, now ${input.modelOverride ?? "default"}) — replayed agent results were produced under the checkpoint's model`,
			});
		}
		if (savedCtx2 && norm(savedCtx2.team) !== norm(input.team?.name)) {
			await appendEventAsync(eventsPath, {
				type: "dwf.resume_context_mismatch",
				runId: manifest.runId,
				data: {
					axis: "team",
					checkpoint: savedCtx2.team ?? null,
					current: input.team?.name ?? null,
				},
				message: `resume team differs from checkpoint (was ${savedCtx2.team ?? "default"}, now ${input.team?.name ?? "default"}) — replayed agent results were produced under the checkpoint's team`,
			});
		}
		await appendEventAsync(eventsPath, {
			type: "dwf.resumed",
			runId: manifest.runId,
			data: {
				agentCount: resumedState.agentCount,
				phases: resumedState.phases,
				currentPhase: resumedState.currentPhase,
			},
		});
	}

	// ERR-1: Create a timeout AbortController so we can abort spawned children on script timeout.
	// Combine the input signal with the timeout controller's signal so EITHER source
	// (external abort OR our timeout) propagates to runChildPi via the ctx.
	// AbortSignal.any is available since Node 20.3 — the project requires Node 20+.
	const timeoutController = new AbortController();
	const combinedSignal = AbortSignal.any([signal, timeoutController.signal]);

	// R14-C3 (wave 7): dispatch-time fingerprint stamped into every checkpoint
	// save; the resume path above compares it against the CURRENT dispatch
	// context and emits dwf.resume_context_mismatch on drift.
	const dispatchContext: { modelOverride?: string; team?: string } = {
		...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
		...(input.team?.name ? { team: input.team.name } : {}),
	};

	const ctx = makeWorkflowCtx(manifest, {
		concurrency: input.concurrency ?? workflow.maxConcurrency ?? 4,
		signal: combinedSignal,
		team: input.team,
		modelOverride: input.modelOverride,
		tokenBudget: input.tokenBudget ?? workflow.maxTokenBudget,
		// SDD-3 W-C G13: explicit input wins over workflow config; both unset →
		// ctx falls back to DEFAULT_MAX_AGENT_CALLS (a run is always bounded).
		maxAgentCalls: resolveMaxAgentCalls(input.maxAgentCalls ?? workflow.maxAgentCalls),
		args: manifest.args,
		resumedState,
		// round-18 P2-3: checkpoint after each ctx.agent() call so a crash between calls
		// leaves durable state. onCheckpoint captures the closure values at call time.
		// R14-C3 (wave 7): dispatchContext (declared above the ctx) is stamped into
		// every save so a later resume can compare against the current dispatch.
		onCheckpoint: (state) => {
			try {
				dwfStore.save({ ...state, dispatchContext });
			} catch (error) {
				logInternalError("dynamic-workflow-runner.checkpoint-save", error, `runId=${manifest.runId}`);
			}
		},
	});

	// Freeze the ctx so the script cannot add/override capability methods (§0c C4).
	const frozenCtx = Object.freeze(ctx);

	try {
		const script = await loadWorkflowModule(scriptPath);
		// Round-11 test fix (runtime): hard timeout on script execution.
		// Without this, scripts that spawn long-running child processes (e.g., `spawn("pi", ...)`)
		// hang forever. The ctx.signal.timeout is cooperative only — it fires AbortSignal,
		// it does NOT kill the script. Promise.race with a hard timeout at least returns an
		// error so the runner doesn't hang. The spawned child process is leaked, but the
		// dynamic-workflow returns failure promptly. (v1.5: use Worker threads to actually kill.)
		const SCRIPT_TIMEOUT_MS = Number.parseInt(getCrewEnv("PI_CREW_DWF_SCRIPT_TIMEOUT_MS") ?? "", 10) || 1_800_000; // 30 min default (was 10 min; raised for distill-dwf + similar long pipelines)
		let timeoutHandle: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(() => {
				// ERR-1: abort the timeout controller so the abort propagates to
				// runChildPi (via the combined signal passed to makeWorkflowCtx),
				// which kills spawned children instead of letting them run.
				// safeAbort: the combined signal may feed a signal-spawned child
				// (abortChildProcess AbortError would otherwise reach the
				// uncaughtException handler from this timer callback).
				safeAbort(timeoutController, "dwf-script-timeout");
				reject(
					new Error(
						`Dynamic workflow script timed out after ${SCRIPT_TIMEOUT_MS}ms. The script may have spawned a child process that did not exit. Check for spawn/exec calls without proper stdio handling.`,
					),
				);
			}, SCRIPT_TIMEOUT_MS);
			timeoutHandle.unref?.();
		});
		try {
			await Promise.race([script(frozenCtx), timeoutPromise]);
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}
	} catch (error) {
		logInternalError("dynamic-workflow-runner.run", error, `runId=${manifest.runId}, workflow=${workflow.name}`);
		await appendEventAsync(eventsPath, {
			type: "dwf.failed",
			runId: manifest.runId,
			data: {
				error: error instanceof Error ? error.message : String(error),
			},
		});
		// Re-throw so background-runner's error handling marks the run failed.
		throw error;
	}

	const final = getWorkflowFinalResult(ctx);
	const finalText = final
		? readFinalArtifact(final.artifactPath)
		: `(dynamic workflow '${workflow.name}' completed without calling ctx.setResult())`;

	// round-12 P0-4: fail fast on unawaited Promise returns BEFORE we try to
	// write a 2 KB blob that contains a Promise reference. structuredClone on
	// a string always succeeds; if it doesn't, the script returned something
	// uncloneable (most often an unawaited Promise) and we want a clear error.
	assertStructuredCloneable(finalText, "final artifact content (set via ctx.setResult)");

	// Write a summary artifact mirroring the static-workflow summary.md contract (run.ts reads this).
	const summary = writeArtifact(manifest.artifactsRoot, {
		kind: "result",
		relativePath: "summary.md",
		content: finalText,
		producer: "dynamic-workflow",
	});

	// round-12 P0-1: safety net — if a script never explicitly closes its
	// final phase before returning, the runner emits a closing event so the
	// last open phase is always terminated before dwf.completed.
	const phaseState = getWorkflowPhaseState(ctx);
	if (phaseState?.currentPhase !== undefined) {
		await appendEventAsync(eventsPath, {
			type: "dwf.phase_completed",
			runId: manifest.runId,
			data: { phase: phaseState.currentPhase },
		});
		phaseState.currentPhase = undefined;
	}

	await appendEventAsync(eventsPath, {
		type: "dwf.completed",
		runId: manifest.runId,
		data: { workflow: workflow.name, summaryArtifact: summary.path },
	});

	// round-18 P2-3: the run completed cleanly — delete the checkpoint so a fresh re-run
	// (same runId) starts from scratch rather than resuming stale state.
	dwfStore.delete();

	// round-12 P0-4: also guard the manifest.summary slice (the value is
	// written into JSON-serialized manifest state — a Promise here would also
	// crash later in the run-event-bus emitter).
	const summaryText = finalText.slice(0, 2000);
	assertStructuredCloneable(summaryText, "manifest.summary (derived from final result)");

	const updatedManifest: TeamRunManifest = {
		...manifest,
		status: "completed",
		summary: summaryText,
		updatedAt: new Date().toISOString(),
		artifacts: [...manifest.artifacts, summary],
	};
	return { manifest: updatedManifest, tasks: [] };
}

function readFinalArtifact(artifactPath: string): string {
	try {
		return readFileSync(artifactPath, "utf-8");
	} catch (error) {
		logInternalError("dynamic-workflow-runner.readFinal", error, `artifactPath=${artifactPath}`);
		return `(failed to read final artifact ${artifactPath})`;
	}
}

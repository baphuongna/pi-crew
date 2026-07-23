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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "esbuild";
import { writeArtifact } from "../state/artifact-store.ts";
import { appendEvent } from "../state/event-log.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { packageRoot, projectCrewRoot, userPiRoot } from "../utils/paths.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import type { DynamicWorkflowConfig } from "../workflows/workflow-config.ts";
import { assertDeterministicScript, isDeterminismCheckEnabled } from "./deterministic-ast.ts";
import { DwfStore } from "./dwf-state-store.ts";
import { getWorkflowFinalResult, getWorkflowPhaseState, makeWorkflowCtx } from "./dynamic-workflow-context.ts";

export interface RunDynamicWorkflowInput {
	manifest: TeamRunManifest;
	workflow: DynamicWorkflowConfig;
	/** Optional team for role resolution (G4 tier 2). */
	team?: import("../teams/team-config.ts").TeamConfig;
	signal: AbortSignal;
	concurrency?: number;
	modelOverride?: string;
	/** round-14 P1-2: per-workflow token budget. Overrides workflow.maxTokenBudget. */
	tokenBudget?: number;
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
		const js = transformSync(scriptSource, { loader: "ts", format: "esm" }).code;
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

/**
 * Run the dynamic workflow script. Loads it, builds the ctx, executes, and returns
 * {manifest, tasks} with the manifest updated to a terminal status + result artifact.
 */
export async function runDynamicWorkflow(input: RunDynamicWorkflowInput): Promise<RunDynamicWorkflowResult> {
	const { manifest, workflow, signal } = input;
	const eventsPath = manifest.eventsPath;
	const scriptPath = resolveScriptPath(workflow, manifest.cwd);

	appendEvent(eventsPath, {
		type: "dwf.started",
		runId: manifest.runId,
		data: { workflow: workflow.name, script: scriptPath },
	});

	// round-18 P2-3: resume/checkpoint. Load any existing checkpoint for this run's stateRoot.
	// stateRoot is already <crewRoot>/state/runs/<runId>, so the checkpoint lands at
	// <stateRoot>/dwf-checkpoint.json (no double-nesting). A missing checkpoint (fresh run)
	// yields undefined — makeWorkflowCtx starts with empty defaults (backward compatible).
	const dwfStore = new DwfStore(manifest.stateRoot);
	const resumedState = dwfStore.load();
	if (resumedState) {
		appendEvent(eventsPath, {
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

	const ctx = makeWorkflowCtx(manifest, {
		concurrency: input.concurrency ?? workflow.maxConcurrency ?? 4,
		signal: combinedSignal,
		team: input.team,
		modelOverride: input.modelOverride,
		tokenBudget: input.tokenBudget ?? workflow.maxTokenBudget,
		args: manifest.args,
		resumedState,
		// round-18 P2-3: checkpoint after each ctx.agent() call so a crash between calls
		// leaves durable state. onCheckpoint captures the closure values at call time.
		onCheckpoint: (state) => {
			try {
				dwfStore.save(state);
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
		const SCRIPT_TIMEOUT_MS = Number.parseInt(process.env.PI_CREW_DWF_SCRIPT_TIMEOUT_MS ?? "", 10) || 1_800_000; // 30 min default (was 10 min; raised for distill-dwf + similar long pipelines)
		let timeoutHandle: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(() => {
				// ERR-1: abort the timeout controller so the abort propagates to
				// runChildPi (via the combined signal passed to makeWorkflowCtx),
				// which kills spawned children instead of letting them run.
				timeoutController.abort();
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
		appendEvent(eventsPath, {
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
		appendEvent(eventsPath, {
			type: "dwf.phase_completed",
			runId: manifest.runId,
			data: { phase: phaseState.currentPhase },
		});
		phaseState.currentPhase = undefined;
	}

	appendEvent(eventsPath, {
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

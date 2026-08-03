/**
 * Runtime module-graph warmup — general fix for the cold-start race.
 *
 * Problem: when N in-process live-session subagents spawn CONCURRENTLY, the
 * tsx loader can race module-record instantiation, yielding
 * `Cannot read properties of undefined (reading '<binding>')` for ANY named
 * import in the hot graph (observed: `existsSync`, `validateWorkflowForTeam`).
 * v0.8.1's per-import latch covered only the peer-dep namespace; this is the
 * GENERAL fix.
 *
 * Root cause: under tsx, a named import `import { X } from "mod"` compiles to
 * `mod_1.X` — a namespace-property access at runtime. If `mod_1` (the module
 * namespace object) is observed mid-instantiation as `undefined`, the access
 * throws. ANY module in the graph is vulnerable, not just the peer dep. So
 * per-import latching doesn't scale.
 *
 * Fix: pre-warm the hot module graph during SINGLE-THREADED extension
 * registration (before any subagent can spawn), then `await` the warmup at
 * every spawn entry point. By the time concurrent subagents touch the graph,
 * every module record is fully instantiated → no race window.
 *
 * Why this is general (not per-import):
 *   - `startRuntimeWarmup()` fires `import()` for the ROOT modules of each
 *     hot execution path. ESM transitively instantiates their entire import
 *     graph, so one import per path warms the whole reachable subgraph.
 *   - `awaitRuntimeWarmup()` is the gate: spawn paths await it before
 *     touching any module, guaranteeing the graph is warm regardless of
 *     which specific binding races.
 *
 * The warmup runs during `registerPiTeams()` (single-threaded, before pi
 * accepts user input). It resolves in milliseconds (module loading only, no
 * I/O for local modules). The `await` at spawn boundaries is belt-and-
 * suspenders for pathological cases where a spawn races the warmup promise.
 *
 * @module runtime-warmup
 */

/**
 * The modules whose transitive import graphs cover every hot execution path
 * a concurrent subagent can reach. Importing the ROOT of each path warms the
 * full subgraph (ESM instantiates imports eagerly during `import()`).
 *
 * - `./live-session-runtime.ts` — the in-process subagent spawn path
 *   (pulls in the peer dep + the entire runtime layer).
 * - `./task-runner.ts` — the child-process task dispatch path.
 * - `../extension/team-tool.ts` — the team tool (pulls in
 *   validate-resources → validate-workflow, the `validateWorkflowForTeam` site).
 * - `../extension/validate-resources.ts` — direct warm of the aggregator.
 * - `@earendil-works/pi-coding-agent` — the peer dep (the `existsSync` site;
 *   also latched in v0.8.1 — defense in depth).
 */
const HOT_MODULE_SPECIFIERS = [
	"./live-session-runtime.ts",
	"./task-runner.ts",
	"../extension/team-tool.ts",
	"../extension/team-tool/run.ts", // handleRun path — latched in team-tool.ts but its static graph (config-patch, validate-workflow) still cold-start-races under concurrent fanout
	"../extension/team-tool/config-patch.ts", // effectiveRunConfig (crash variant observed in repro)
	"../extension/validate-resources.ts",
	"../workflows/validate-workflow.ts", // validateWorkflowForTeam (crash variant observed across sessions)
	"../state/crew-init.ts", // TDZ-prone top-level consts (CREW_README); dynamically imported by team-tool/run.ts
] as const;

/** Additional bare-specifier peer deps to warm. */
const HOT_PEER_DEPS = ["@earendil-works/pi-coding-agent"] as const;

let warmupPromise: Promise<void> | undefined;
let warmupStarted = false;
let warmupCompleted = false;
let warmupDurationMs: number | undefined;
let warmupError: string | undefined;

/**
 * Start the runtime warmup (idempotent). Fires eager `import()` of the hot
 * module graph. Safe to call during single-threaded registration — the
 * promises resolve on the event loop before any subagent can spawn.
 *
 * Errors are swallowed: a failed warmup (e.g. peer dep absent) must never
 * block the extension from loading. The worst case is the old race returns
 * (which is no worse than before this fix).
 */
export function startRuntimeWarmup(): void {
	if (warmupStarted) return;
	warmupStarted = true;
	const startedAt = Date.now();
	warmupPromise = (async (): Promise<void> => {
		const imports: Array<Promise<unknown>> = [];
		for (const spec of HOT_MODULE_SPECIFIERS) {
			imports.push(
				import(new URL(spec, import.meta.url).href).catch(() => {
					// swallow — never block registration on a warmup failure
				}),
			);
		}
		for (const dep of HOT_PEER_DEPS) {
			imports.push(
				import(dep).catch(() => {
					// peer dep may be absent (optional dep) — swallow
				}),
			);
		}
		await Promise.all(imports);
	})()
		.then(() => {
			warmupCompleted = true;
			warmupDurationMs = Date.now() - startedAt;
		})
		.catch((err: unknown) => {
			// final safety net — warmup must never reject. Record for diagnostics.
			warmupError = err instanceof Error ? err.message : String(err ?? "unknown");
		});
}

/**
 * Await the runtime warmup at a spawn entry point. No-op if warmup hasn't
 * started (back-compat for callers that don't call startRuntimeWarmup) or has
 * already resolved. Guarantees the hot module graph is instantiated before
 * the caller touches any module — eliminating the concurrent cold-start race.
 */
export async function awaitRuntimeWarmup(): Promise<void> {
	if (warmupPromise) await warmupPromise;
}

/**
 * Test seam: reset the warmup state so tests can re-trigger it. Also lets
 * tests verify idempotency by calling startRuntimeWarmup() multiple times.
 */
export function resetRuntimeWarmupForTest(): void {
	warmupPromise = undefined;
	warmupStarted = false;
	warmupCompleted = false;
	warmupDurationMs = undefined;
	warmupError = undefined;
}

/** Test seam: has startRuntimeWarmup() been called? */
export function isRuntimeWarmupStarted(): boolean {
	return warmupStarted;
}

/**
 * Diagnostic snapshot of warmup state for `team doctor`. Surfaces whether the
 * v0.8.6 cold-start fix is active and how long the graph warmup took, so a
 * session can confirm the fix loaded (post-restart) and isn't pathologically
 * slow.
 */
export interface RuntimeWarmupStatus {
	started: boolean;
	completed: boolean;
	durationMs: number | undefined;
	error: string | undefined;
}

export function getRuntimeWarmupStatus(): RuntimeWarmupStatus {
	return {
		started: warmupStarted,
		completed: warmupCompleted,
		durationMs: warmupDurationMs,
		error: warmupError,
	};
}

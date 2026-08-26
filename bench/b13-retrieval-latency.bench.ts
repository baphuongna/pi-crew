/**
 * b13 (perf round 3): retrieval latency regression guard.
 *
 * Baseline context (2026-08-26, machine bom, cwd /home/bom/source/my_pi —
 * 77k rg files, ~57k post-ext-filter): runRetrievalCycle took 5266ms cold /
 * 4278ms warm before the single-pass + stopword + discovery-cache fixes.
 * Budgets below are deliberately generous (4x the post-fix expectation) so
 * slower CI machines stay green while a regression to the 3-cycle behavior
 * (which triples the cost) fails loudly.
 */
import { performance } from "node:perf_hooks";
import * as path from "node:path";
import * as url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const { runRetrievalCycle, __test_resetDiscoveredCache } = await import(
	"../src/runtime/task-runner/retrieval-orchestrator.ts"
);

const GOAL = "Smoke-verify pi-crew on this session: run `npm run test:critical` ONCE, cache the output to .crew/cache/, then report the exact pass/fail counts.";
const TASK = `Find the likely source of the issue: ${GOAL}`;

function ms(t0: number): number {
	return Math.round(performance.now() - t0);
}

const cases: Record<string, { wallMs: number; budgetMs: number; pass: boolean; note: string }> = {};

{
	__test_resetDiscoveredCache();
	const t0 = performance.now();
	const r = await runRetrievalCycle(TASK, GOAL, repoRoot);
	const wallMs = ms(t0);
	cases.retrievalColdRepoRoot = {
		wallMs,
		budgetMs: 2000,
		pass: wallMs < 2000 && r.files.length > 0,
		note: "single-pass over the pi-crew repo itself (~5k relevant files); must stay <2s and still suggest files",
	};
}
{
	// Warm: same cwd, DIFFERENT keywords — discovery must come from cache,
	// only scoring re-runs. This is the per-task steady state inside a run.
	const t0 = performance.now();
	const r = await runRetrievalCycle("verify package exports typecheck bundle", "typecheck the bundle", repoRoot);
	const wallMs = ms(t0);
	cases.retrievalWarmCacheHit = {
		wallMs,
		budgetMs: 400,
		pass: wallMs < 400 && r.files.length > 0,
		note: "discovery cache hit (same cwd, new keywords); must stay <400ms",
	};
}

const failures = Object.values(cases).filter((c) => !c.pass).length;
for (const [name, c] of Object.entries(cases)) {
	console.log(`b13 ${name}: ${c.wallMs}ms (budget <${c.budgetMs}ms — ${c.note}) ${c.pass ? "PASS" : "FAIL"}`);
}
console.log(
	JSON.stringify({ name: "b13.retrieval-latency", unit: "ms", cases: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, { wallMs: v.wallMs, budgetMs: v.budgetMs, pass: v.pass }])), failures }),
);
if (failures > 0) {
	console.log("b13 FAILED");
	process.exitCode = 1;
} else {
	console.log("b13 PASSED");
}

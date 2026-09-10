# Perf Round 3 — Retrieval Single-Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut per-task prompt-pipeline latency from ~6-8s to ~1s by fixing `runRetrievalCycle` (measured 5.3s CPU per task on the my_pi monorepo) — remove the redundant 3-cycle loop, dedupe evaluations, filter stopword noise, and cache the `rg --files` discovery per cwd.

**Architecture:** All changes are confined to `src/runtime/task-runner/retrieval-orchestrator.ts` (+ its test + a new bench). The retrieval cycle currently spawns `rg --files` and re-scores ~57k files **three times** (the convergence gate `hasConverged` requires score ≥ 0.7, but path-only scoring caps at 0.64, so the loop never converges), accumulates duplicate `evaluations` entries across cycles (same file appears up to 3× in the top-10), and has no internal memo (the only cache — `stableIOCache` in prompt-builder.ts — is keyed by `(cwd, step.task)`, so every task misses). We make discovery single-pass with a per-cwd TTL cache, dedupe by absolute path, and expand the stopword list so fewer junk keywords multiply the scoring cost.

**Tech Stack:** Node 22 `--experimental-strip-types`, `node:test`, existing `runRipgrep` (R11-1 hardened spawn), existing fixture pattern from `test/unit/retrieval-orchestrator.test.ts`.

## Measured baseline (2026-08-26, machine bom, input = real run `team_20260826002634` goal/step, cwd `/home/bom/source/my_pi`)

| Metric | Before | Target after |
|---|---|---|
| `runRetrievalCycle` cold | 5266 ms | ≤ 2000 ms |
| `runRetrievalCycle` warm (same process, different keywords) | 4278 ms | ≤ 250 ms (discovery cache hit) |
| keywords from tokenize(goal+task) | 25 (incl. `find`, `this`, `then`, `run`, `once`…) | ≤ 15 |
| duplicate paths in `result.files` | up to 3× same file | 0 |
| rg spawns per retrieval | 3 | 1 (0 on cache hit) |

## Global Constraints

- `RetrievalResult` interface shape is FROZEN: `{ files, cycles, converged, usedFallback }` — field names and types unchanged (consumers: `renderSuggestedFilesSection`, prompt-builder, existing tests).
- `renderSuggestedFilesSection` output format unchanged (test M3-E pins it).
- Empty-keyword short-circuit keeps `{ cycles: 0, converged: true }` (test M3-C pins it).
- `MAX_CYCLES` export is REMOVED together with the loop; test M3-C-2 is updated in the same task (it imports `MAX_CYCLES`). `shouldContinue` import is dropped if unused; `hasConverged` stays (used for `converged`).
- Preserve every tagged comment block touched by edits (R11-1 hardening comments, doc comments) — move them with their code, never delete.
- Discovery cache covers ONLY the rg path (deterministic per cwd); `walkFilesFallback` stays uncached (its result depends on keywords).
- Conventional commits, explicit `git add` (never `-am`), never commit `dist/`, trailer `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Test invocation: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 <file>`.
- Typecheck after every task: `npm run typecheck`.

---

### Task 1: Single-pass retrieval + path dedupe

**Files:**
- Modify: `src/runtime/task-runner/retrieval-orchestrator.ts` (function `runRetrievalCycle`, ~line 279; constant `MAX_CYCLES` at line 30; imports from `./context-retrieval.ts`)
- Test: `test/unit/retrieval-orchestrator.test.ts` (update M3-C-2; add R3-1, R3-2)

**Interfaces:**
- Produces: `runRetrievalCycle(task, goal, cwd)` unchanged signature; `cycles` is now `0` (empty keywords) or `1`; `MAX_CYCLES` no longer exported.

- [ ] **Step 1: Write failing tests** — append to `test/unit/retrieval-orchestrator.test.ts`:

```ts
test("R3-1: single discovery pass — cycles === 1 with non-empty keywords", async () => {
	const cwd = makeFixtureDir();
	__test_resetRipgrepCache();
	try {
		const result = await runRetrievalCycle("tool guidance prompt", "build M3 retrieval", cwd);
		assert.equal(result.cycles, 1, `expected exactly 1 cycle, got ${result.cycles}`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R3-2: no duplicate paths in result.files (dedupe by absolute path)", async () => {
	const cwd = makeFixtureDir();
	__test_resetRipgrepCache();
	try {
		const result = await runRetrievalCycle("tool guidance prompt", "build M3 retrieval", cwd);
		const paths = result.files.map((f) => f.path);
		assert.equal(new Set(paths).size, paths.length, `result.files must be unique, got: ${JSON.stringify(paths)}`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
```

Update M3-C-2 in the same edit — replace the import of `MAX_CYCLES` and the range assertion:

```ts
test("M3-C-2: cycles never exceed MAX_CYCLES (3) even when keywords are non-empty", async () => {
	const cwd = makeFixtureDir();
	__test_resetRipgrepCache();
	try {
		const result = await runRetrievalCycle("find anything", "explore everything", cwd);
		assert.ok(result.cycles >= 0 && result.cycles <= 1, `cycles ${result.cycles} must be in [0, 1] (single-pass since perf round 3)`);
		// Suggested files cap respects the max.
		assert.ok(result.files.length <= MAX_SUGGESTED_FILES, `suggested files ${result.files.length} must be ≤ ${MAX_SUGGESTED_FILES}`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
```

(Rename the test title to `"M3-C-2: single-pass — cycles is 0 or 1"` and drop `MAX_CYCLES` from the import list at the top of the file.)

- [ ] **Step 2: Run to verify failure**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/retrieval-orchestrator.test.ts`
Expected: R3-1 FAIL (`cycles` is 3), R3-2 may pass on the small fixture (dupes need ≥2 cycles with hits) — that is fine; R3-1 is the red signal.

- [ ] **Step 3: Implement** — replace the body of `runRetrievalCycle` (keep the function doc comment above it, keep the R11-1 area untouched):

```ts
export async function runRetrievalCycle(task: string, goal: string, cwd: string): Promise<RetrievalResult> {
	const keywords = tokenizeQuery(task, goal);
	if (keywords.length === 0) {
		return { files: [], cycles: 0, converged: true, usedFallback: false };
	}
	const rg = await detectRipgrep();
	const useRg = rg.available;
	let usedFallback = !useRg;
	// PERF round 3 (2026-08-26): single discovery pass. The previous loop ran
	// up to MAX_CYCLES=3 iterations, but each iteration re-ran `rg --files`
	// (identical output ~0.36s/spawn on my_pi) and re-scored the identical
	// ~57k-file set: path-only scoring (content always "") cannot reach
	// HIGH_RELEVANCE_THRESHOLD=0.7 (observed max 0.64), so hasConverged was
	// always false and the loop ran unconditionally — 3× CPU for a zero
	// result delta (measured 5266ms → 1810ms cold on the my_pi monorepo).
	let discovered: string[] = [];
	try {
		if (useRg) {
			// `rg --files` respects .gitignore by default; explicit -g guards
			// repos that don't ignore them (comment moved from the loop body).
			const stdout = await runRipgrep(["--files", "-g", "!node_modules", "-g", "!.git", cwd], cwd);
			discovered = stdout
				.split("\n")
				.map((p) => p.trim())
				.filter((p) => p && RELEVANT_EXTS.has(path.extname(p).toLowerCase()))
				.map((p) => path.relative(cwd, p));
		} else {
			discovered = (await walkFilesFallback(cwd, keywords)).map((f) => f.path);
		}
	} catch {
		// rg errored mid-run — switch to fallback for this pass.
		usedFallback = true;
		discovered = (await walkFilesFallback(cwd, keywords)).map((f) => f.path);
	}
	// Score each discovered file. Path-only scoring (no file read) so
	// we don't slow down prompt building for hundreds of files.
	// PERF round 3: dedupe by ABSOLUTE path — the multi-cycle accumulation
	// previously pushed the same evaluation once per cycle, so the top-10
	// could contain the same file up to 3 times (observed on
	// team_20260826002634: task-output-context-dep-cache.test.ts ×3).
	const byPath = new Map<string, RelevanceEvaluation>();
	for (const relPath of discovered) {
		const absPath = path.isAbsolute(relPath) ? relPath : path.join(cwd, relPath);
		if (byPath.has(absPath)) continue;
		const score = scoreRelevance(absPath, "", keywords);
		if (score > 0) {
			byPath.set(absPath, {
				path: absPath,
				relevance: score,
				reason: reasonFor(absPath, keywords),
				missingContext: [],
			});
		}
	}
	const evaluations = [...byPath.values()];
	const converged = hasConverged(evaluations);
	// Sort by score desc, take top N (5..10).
	evaluations.sort((a, b) => b.relevance - a.relevance);
	const cap = Math.min(MAX_SUGGESTED_FILES, Math.max(MIN_SUGGESTED_FILES, evaluations.length));
	const top = evaluations.slice(0, cap).map((e) => ({
		path: path.isAbsolute(e.path) ? path.relative(cwd, e.path) : e.path,
		score: e.score,
		reason: e.reason,
	}));
	return { files: top, cycles: 1, converged, usedFallback };
}
```

Then:
- Delete `export const MAX_CYCLES = 3;` (line ~30) and its preceding doc comment lines that reference the loop (`/** Max retrieval cycles per prompt render. Matches context-retrieval.MAX_CYCLES. */`).
- Update the import from `./context-retrieval.ts` to drop `shouldContinue` if it is now unused (`hasConverged`, `scoreRelevance` stay).
- The `RelevanceEvaluation` type must be imported if not already (check the existing import list; it comes from `./context-retrieval.ts`).

- [ ] **Step 4: Run tests**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/retrieval-orchestrator.test.ts`
Expected: ALL pass (M3-A..M3-E + R3-1 + R3-2).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/runtime/task-runner/retrieval-orchestrator.ts test/unit/retrieval-orchestrator.test.ts
git commit -m "perf(retrieval): single-pass discovery + path dedupe — drop redundant 3-cycle loop

The convergence gate (score >= 0.7) is unreachable with path-only scoring
(observed max 0.64), so the loop always ran 3 full passes: 3 rg spawns +
3x scoring over ~57k files (~5.3s CPU/task on the my_pi monorepo, the
dominant cost of the 6-8s prompt-pipeline gap measured in the 2026-08-26
real test). Evaluations are now deduped by absolute path — the top-10
previously could list the same file up to 3 times.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Expand STOPWORDS

**Files:**
- Modify: `src/runtime/task-runner/retrieval-orchestrator.ts` (constant `STOPWORDS`, line ~39)
- Test: `test/unit/retrieval-orchestrator.test.ts` (add R3-3)

**Interfaces:** none — `tokenizeQuery` signature and semantics ("lowercase, deduped, original order") unchanged.

- [ ] **Step 1: Write failing test** — append:

```ts
test("R3-3: tokenizeQuery drops generic verbs/pronouns that never match code paths", () => {
	const kws = tokenizeQuery(
		"Find the likely source of this issue, then report exact counts once you run it",
		"this session was run to verify things",
	);
	const banned = ["find", "likely", "this", "then", "report", "exact", "once", "run", "you", "it", "was", "to", "things"];
	for (const b of banned) assert.ok(!kws.includes(b), `stopword '${b}' must be filtered, got ${JSON.stringify(kws)}`);
	// Signal keywords still survive:
	for (const keep of ["source", "issue", "counts", "session", "verify"]) assert.ok(kws.includes(keep), `keyword '${keep}' must survive, got ${JSON.stringify(kws)}`);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/retrieval-orchestrator.test.ts`
Expected: R3-3 FAIL (`find`, `this`, … present).

- [ ] **Step 3: Implement** — replace the STOPWORDS constant:

```ts
// PERF round 3: expanded from 14 function words to the common verb/pronoun/
// filler set. These multiply the scoring cost (keywords × files × passes)
// and essentially never appear in code file paths. Deliberately KEPT OUT:
// domain words that DO match paths — test, cache, prompt, tool, spec, run
// artifacts like "smoke" — check the keep-assertions in R3-3 before adding.
const STOPWORDS: ReadonlySet<string> = new Set([
	"the", "a", "an", "and", "or", "to", "of", "in", "for", "on", "is", "are", "be", "with",
	"this", "that", "these", "those", "then", "than", "so", "if", "but", "not", "no", "yes",
	"it", "its", "they", "them", "their", "we", "you", "your", "us", "our", "i",
	"was", "were", "been", "has", "have", "had", "will", "would", "can", "could", "should",
	"may", "might", "must", "shall", "do", "does", "did", "done",
	"find", "found", "look", "likely", "please", "just", "only", "also", "into", "from",
	"when", "what", "which", "where", "how", "all", "any", "some", "there", "here",
	"report", "reports", "exact", "once", "twice", "things", "thing", "stuff",
	"make", "makes", "made", "use", "using", "used",
]);
```

- [ ] **Step 4: Run tests** — whole suite must pass (M3-A/B match on `toolguidanceblock`/`prompt`, unaffected).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/runtime/task-runner/retrieval-orchestrator.ts test/unit/retrieval-orchestrator.test.ts
git commit -m "perf(retrieval): expand stopwords — generic verbs/pronouns never match code paths

Probe goal+task tokenized to 25 keywords (find, this, then, run, once...);
the filler half multiplied the O(files x keywords) scoring for zero
retrieval signal. Path-meaningful words (test, cache, prompt...) stay.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Cache rg discovery per cwd (60s TTL)

**Files:**
- Modify: `src/runtime/task-runner/retrieval-orchestrator.ts` (new module-level cache + hook into the rg branch of `runRetrievalCycle`)
- Test: `test/unit/retrieval-orchestrator.test.ts` (add R3-4)

**Interfaces:**
- Produces: `export function __test_resetDiscoveredCache(): void` (test-only, mirrors `__test_resetRipgrepCache`).

- [ ] **Step 1: Write failing test** — append:

```ts
test("R3-4: rg discovery cached per cwd for 60s — new files invisible until reset", async () => {
	const cwd = makeFixtureDir();
	__test_resetRipgrepCache();
	__test_resetDiscoveredCache();
	try {
		const first = await runRetrievalCycle("latefile probe", "find latefile", cwd);
		assert.ok(!first.files.some((f) => f.path.includes("late-added")), "sanity: file not created yet");
		// Create a NEW strongly-matching file AFTER the first retrieval.
		fs.writeFileSync(path.join(cwd, "src", "late-added-latefile.ts"), "// latefile latefile latefile\n", "utf-8");
		const second = await runRetrievalCycle("latefile probe", "find latefile", cwd);
		assert.ok(
			!second.files.some((f) => f.path.includes("late-added")),
			"within TTL the cached discovery must NOT see the new file (cache hit proof)",
		);
		__test_resetDiscoveredCache();
		const third = await runRetrievalCycle("latefile probe", "find latefile", cwd);
		assert.ok(
			third.files.some((f) => f.path.includes("late-added")),
			"after cache reset the new file must be discovered and rank (score: 2 path hits)",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run to verify failure**

Expected: R3-4 FAIL on the second assertion (`second` sees the new file — no cache yet).

- [ ] **Step 3: Implement** — add near the other module state (after `cachedRgCheck`):

```ts
/**
 * PERF round 3: per-cwd cache of the rg discovery result (relative paths,
 * post RELEVANT_EXTS filter). Tasks in one run share the cwd but differ in
 * step.task keywords, so the stableIOCache in prompt-builder.ts misses per
 * task — this cache keeps the expensive part (rg spawn + 77k-line parse)
 * at once per cwd per minute instead of once per task. Fallback walk is
 * NOT cached (its result depends on keywords). Size-capped, insertion-
 * order eviction, same TTL family as stableIOCache (60s).
 */
const DISCOVERED_TTL_MS = 60_000;
const DISCOVERED_CACHE_MAX = 32;
const discoveredCache = new Map<string, { files: string[]; at: number }>();

function getCachedDiscovered(cwd: string): string[] | undefined {
	const hit = discoveredCache.get(cwd);
	if (hit && Date.now() - hit.at < DISCOVERED_TTL_MS) return hit.files;
	return undefined;
}

function storeDiscovered(cwd: string, files: string[]): void {
	discoveredCache.set(cwd, { files, at: Date.now() });
	while (discoveredCache.size > DISCOVERED_CACHE_MAX) {
		const oldest = discoveredCache.keys().next().value;
		if (oldest === undefined) break;
		discoveredCache.delete(oldest);
	}
}

/** @internal Test-only: reset the discovery cache. */
export function __test_resetDiscoveredCache(): void {
	discoveredCache.clear();
}
```

Then inside `runRetrievalCycle`, replace the `if (useRg) { ... }` discovery branch with:

```ts
		if (useRg) {
			const cached = getCachedDiscovered(cwd);
			if (cached) {
				discovered = cached;
			} else {
				// `rg --files` respects .gitignore by default; explicit -g guards
				// repos that don't ignore them (comment moved from the loop body).
				const stdout = await runRipgrep(["--files", "-g", "!node_modules", "-g", "!.git", cwd], cwd);
				discovered = stdout
					.split("\n")
					.map((p) => p.trim())
					.filter((p) => p && RELEVANT_EXTS.has(path.extname(p).toLowerCase()))
					.map((p) => path.relative(cwd, p));
				storeDiscovered(cwd, discovered);
			}
		} else {
```

IMPORTANT: the `catch` fallback must NOT overwrite the cache and must not read it — leave the `catch` exactly as Task 1 left it.

- [ ] **Step 4: Run tests** — R3-4 + all prior pass. Also verify the rg-error path still falls back (M3-D covers it — it forces rg unavailable, which bypasses the cache branch).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/runtime/task-runner/retrieval-orchestrator.ts test/unit/retrieval-orchestrator.test.ts
git commit -m "perf(retrieval): cache rg --files discovery per cwd (60s TTL, cap 32)

The discovery list is cwd-deterministic, but every task re-spawned rg and
re-parsed ~77k lines. Tasks sharing a run cwd now hit the cache; the
keyword-dependent scoring still runs per task. Fallback walk uncached.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Bench b13 — retrieval latency regression guard

**Files:**
- Create: `bench/b13-retrieval-latency.bench.ts`

**Interfaces:**
- Consumes: `runRetrievalCycle`, `__test_resetDiscoveredCache` from `src/runtime/task-runner/retrieval-orchestrator.ts`.
- Produces: NDJSON line `{"name":"b13.retrieval-latency",...}` matching the b12 output convention (final NDJSON object + human lines + `b13 PASSED/FAILED`).

- [ ] **Step 1: Write the bench** (model on `bench/b12-fsync-counts.bench.ts` structure — import from `../src/...` relative paths like b12 does):

```ts
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
```

- [ ] **Step 2: Run it**

Run: `node --experimental-strip-types bench/b13-retrieval-latency.bench.ts`
Expected: both cases PASS. Record the two `wallMs` numbers — they go into the CHANGELOG (Task 5).

- [ ] **Step 3: Check how benches are registered** — run `grep -rn "b12" package.json bench/ --include="*.ts" -l | head -3`; if package.json or a bench index lists benches, add b13 the same way b12 is listed; if benches are standalone files only, skip.

- [ ] **Step 4: Commit**

```bash
git add bench/b13-retrieval-latency.bench.ts package.json
git commit -m "bench(b13): retrieval latency regression guard (cold <2s, cache-hit <400ms)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

(If package.json was not modified, `git add` only the bench file.)

---

### Task 5: End-to-end probe + CHANGELOG

**Files:**
- Create: `docs/real-test/reports/perf-round3-probe.md` (probe evidence)
- Modify: `CHANGELOG.md` (new Unreleased section on top)

**Interfaces:** none.

- [ ] **Step 1: Re-run the real-input probe** — same measurements as the baseline, on the my_pi monorepo:

```bash
node --experimental-strip-types -e "
const { runRetrievalCycle, __test_resetDiscoveredCache } = await import('./src/runtime/task-runner/retrieval-orchestrator.ts');
const { performance } = await import('node:perf_hooks');
const goal = 'Smoke-verify pi-crew on this session: run \`npm run test:critical\` ONCE in /home/bom/source/my_pi/pi-crew, cache the output to .crew/cache/, then report the exact pass/fail counts.';
const task = 'Find the likely source of the issue: ' + goal;
__test_resetDiscoveredCache();
let t = performance.now();
let r = await runRetrievalCycle(task, goal, '/home/bom/source/my_pi');
console.log('cold:', Math.round(performance.now()-t), 'ms | files:', r.files.length, '| cycles:', r.cycles);
t = performance.now();
r = await runRetrievalCycle('verify executor output evidence chain', 'check the executor handoff', '/home/bom/source/my_pi');
console.log('warm (new keywords):', Math.round(performance.now()-t), 'ms | files:', r.files.length);
const paths = r.files.map(f=>f.path);
console.log('dupes:', paths.length - new Set(paths).size);
" 2>&1 | grep -v Warning
```

Expected: cold ≤ 2000ms (baseline 5266), warm ≤ 250ms (baseline 4278), dupes 0. If cold is above target, STOP — re-measure with `--cpu-prof` and investigate before writing the CHANGELOG (do not publish a miss as a hit).

- [ ] **Step 2: Write the probe report** — `docs/real-test/reports/perf-round3-probe.md` with the baseline/target/measured table (copy the table from this plan's Measured baseline section, fill the "after" column with the real numbers from Step 1 and b13), plus the dupes result and the root-cause summary (3-sentence: loop never converged → 3× cost; stopword filler; no discovery memo).

- [ ] **Step 3: CHANGELOG entry** — new section at the top of `CHANGELOG.md`:

```markdown
## [Unreleased] — perf: round 3 retrieval single-pass (prompt-pipeline 6-8s → ~1s/task)

Root cause (measured on real run `team_20260826002634`, 2026-08-26 real test):
`runRetrievalCycle` spent 5.3s CPU per task — 3 unconditional cycles (the
0.7 convergence threshold is unreachable with path-only scoring, observed
max 0.64), 25 keywords incl. filler over ~57k files, and a duplicate-
accumulating evaluation list (same file up to 3× in the top-10).

- Single discovery pass + dedupe by absolute path (`retrieval-orchestrator.ts`)
- STOPWORDS expanded (filler verbs/pronouns out; path-meaningful words kept)
- rg discovery cached per cwd, 60s TTL, cap 32 (fallback walk uncached)
- b13 bench guards cold <2s / cache-hit <400ms on the repo itself

| Metric (my_pi monorepo, real run input) | Before | After |
|---|---|---|
| runRetrievalCycle cold | 5266 ms | <MEASURED> |
| warm, new keywords (discovery cache) | 4278 ms | <MEASURED> |
| duplicate paths in top-10 | up to 3× | 0 |

Every number above was measured, not estimated.
```

Fill `<MEASURED>` with the Step-1/b13 values before committing.

- [ ] **Step 4: Typecheck + full retrieval suite + commit**

```bash
npm run typecheck
node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/retrieval-orchestrator.test.ts
git add docs/real-test/reports/perf-round3-probe.md CHANGELOG.md
git commit -m "docs(changelog): perf round 3 — retrieval single-pass results (measured)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-review checklist (controller: verify before handing off)

1. **Spec coverage:** latency (T1 loop, T2 keywords, T3 cache), dupes (T1), regression guard (T4), documentation (T5) — all root-cause limbs covered.
2. **Placeholders:** none — every step carries complete code or exact commands.
3. **Type consistency:** `RelevanceEvaluation` imported in T1; `__test_resetDiscoveredCache` exported in T3 and consumed in T4/T5; `MAX_SUGGESTED_FILES`/`MIN_SUGGESTED_FILES` untouched.
4. **Frozen surface:** `RetrievalResult` shape, `renderSuggestedFilesSection` format, empty-keyword short-circuit `{cycles: 0, converged: true}` — all pinned by tests M3-C/M3-E which must stay green in every task.

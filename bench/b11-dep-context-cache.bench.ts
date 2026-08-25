/**
 * b11 — R10-1 residual: dep-context result-artifact read cache bench.
 *
 * Wave 2A left ONE aggregation path uncached: `collectDependencyOutputContext`
 * (per-dep `readIfSmallWithTee` per dispatch + per retry). This bench proves
 * threading the SAME per-run `ResultArtifactReadCache` into that path pays off
 * WITHOUT changing a byte:
 *
 *   (a) fs-op counts via `__test__resultReadStats` (readFile/existsSync
 *       actually issued through the seams) for a cache-enabled run vs a
 *       cache-disabled control run (`PI_CREW_DISABLE_RESULT_READ_CACHE=1`,
 *       read once at cache creation);
 *   (b) byte-identity: `renderDependencyOutputContext(collect(...))` for EVERY
 *       consumer is identical cached vs bypassed — including consumers whose
 *       read follows an `aggregateTaskOutputs` population (real runtime order:
 *       batch closeout runs before the next batch's dispatch);
 *   (c) wall times for both runs printed.
 *
 * Workload (fan-in): 1 upstream dep with a settled result artifact + 4
 * downstream consumers; per iteration = 1 closeout aggregation + 4 dep-context
 * collects (the same artifact read 5× per cycle when uncached). Two scenarios:
 *   S1 "realistic" — 8 KB result (real-world data: 100% of artifacts <16 KB),
 *      cacheable band (no truncation);
 *   S2 "tee band" — >1.25× MAX_RESULT_INLINE_BYTES result, where the
 *      tee-safety fallthrough intentionally still reads per consumer (proof
 *      the cache never corrupts tee/fullOutputPath semantics).
 *
 * Output contract (scripts/run-bench.mjs): human tables first, then ONE final
 * NDJSON line `{"name":"b11.dep-context-cache",...}` with the per-scenario key
 * numbers — the runner parses the LAST JSON line on stdout.
 *
 * Run standalone (NO package.json script — bench/ files are standalone):
 *   node --experimental-strip-types bench/b11-dep-context-cache.bench.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
	__test__resultReadStats,
	aggregateTaskOutputs,
	collectDependencyOutputContext,
	createResultArtifactReadCache,
	MAX_RESULT_INLINE_BYTES,
	renderDependencyOutputContext,
	TEE_THRESHOLD_MULTIPLIER,
} from "../src/runtime/task-output-context.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../src/state/types.ts";
import type { WorkflowStep } from "../src/workflows/workflow-config.ts";

const DEP_ID = "dep-1";
const CONSUMER_IDS = ["fan-a", "fan-b", "fan-c", "fan-d"];
const ITERATIONS = 60;
const S1_CHARS = 8_000; // realistic: <16 KB (100% of observed real artifacts)
const S2_CHARS = Math.ceil(MAX_RESULT_INLINE_BYTES * TEE_THRESHOLD_MULTIPLIER) + 2_000; // tee band
const S2_ITERATIONS = 12; // compact-pipeline cost on >40KB inputs is high; keep the bench quick

const tmpDirs: string[] = [];

interface Snapshot {
	readFile: number;
	exists: number;
	hits: number;
	misses: number;
}

function stats(): Snapshot {
	const s = __test__resultReadStats;
	return { readFile: s.readFile, exists: s.exists, hits: s.hits, misses: s.misses };
}

function delta(after: Snapshot, before: Snapshot): Snapshot {
	return {
		readFile: after.readFile - before.readFile,
		exists: after.exists - before.exists,
		hits: after.hits - before.hits,
		misses: after.misses - before.misses,
	};
}

function makeCache(bypass: boolean) {
	if (!bypass) return createResultArtifactReadCache();
	const prev = process.env.PI_CREW_DISABLE_RESULT_READ_CACHE;
	process.env.PI_CREW_DISABLE_RESULT_READ_CACHE = "1";
	try {
		return createResultArtifactReadCache(); // env read ONCE at creation
	} finally {
		if (prev === undefined) delete process.env.PI_CREW_DISABLE_RESULT_READ_CACHE;
		else process.env.PI_CREW_DISABLE_RESULT_READ_CACHE = prev;
	}
}

function buildFixture(label: string, depChars: number) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-b11-${label}-`));
	tmpDirs.push(dir);
	const relResultPath = `results/${DEP_ID}.txt`;
	const absResultPath = path.join(dir, relResultPath);
	fs.mkdirSync(path.dirname(absResultPath), { recursive: true });
	const raw = `Result body line ${label}\n${"Z".repeat(depChars)}`;
	fs.writeFileSync(absResultPath, raw, "utf-8");
	const resultArtifact: ArtifactDescriptor = {
		path: relResultPath,
		sizeBytes: Buffer.byteLength(raw, "utf-8"),
		contentHash: `sha256:${label}`,
	};
	const manifest = { artifactsRoot: dir, artifacts: [] } as unknown as TeamRunManifest;
	const depTask = {
		id: DEP_ID,
		stepId: "dep-step",
		role: "explorer",
		agent: "worker",
		status: "completed",
		resultArtifact,
		dependsOn: [],
	} as unknown as TeamTaskState;
	const consumers = CONSUMER_IDS.map((id) => ({ id, dependsOn: ["dep-step"] }) as unknown as TeamTaskState);
	const step = {} as unknown as WorkflowStep;
	return { manifest, depTask, consumers, step };
}

interface RunResult {
	readOps: Snapshot;
	wallMs: number;
	renders: string[];
}

/** One fan-in closeout+dispatch cycle, repeated `iterations` times:
 *  closeout aggregation first (populates the cache in the cached run), then
 *  one dep-context collect per downstream consumer (the hot dispatch path).
 *  NOTE: the SAME fixture (tmpdir + manifest) backs both the cached and the
 *  bypassed run — renders embed absolute paths (resultPath / tee
 *  fullOutputPath), so byte-identity requires identical roots. */
function runScenario(fixture: ReturnType<typeof buildFixture>, bypass: boolean, iterations: number): RunResult {
	const { manifest, depTask, consumers, step } = fixture;
	const cache = makeCache(bypass);
	const renders: string[] = [];
	__test__resultReadStats.reset();
	const before = stats();
	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		// Closeout-style aggregation over the settled dep batch.
		aggregateTaskOutputs([depTask], manifest, cache);
		// Dispatch-style dep-context collection for each downstream consumer.
		for (const consumer of consumers) {
			const ctx = collectDependencyOutputContext(manifest, [depTask, ...consumers], consumer, step, cache);
			if (i === 0) renders.push(renderDependencyOutputContext(ctx));
		}
	}
	const wallMs = performance.now() - start;
	return { readOps: delta(stats(), before), wallMs, renders };
}

function pct(cached: number, bypassed: number): string {
	if (bypassed === 0) return "n/a";
	return `${(((bypassed - cached) / bypassed) * 100).toFixed(0)}%`;
}

let failures = 0;

interface ScenarioNumbers {
	iterations: number;
	depChars: number;
	cached: { readFile: number; exists: number; hits: number; misses: number; wallMs: number };
	bypassed: { readFile: number; exists: number; hits: number; misses: number; wallMs: number };
	readFileReductionPct: string;
	byteIdentity: boolean;
}

function report(label: string, depChars: number, iterations: number): ScenarioNumbers {
	const fixture = buildFixture(label, depChars);
	const cached = runScenario(fixture, false, iterations);
	const bypassed = runScenario(fixture, true, iterations);
	// (b) byte-identity: every consumer's rendered dep context is identical
	// between the cached and bypassed runs.
	let identical = cached.renders.length === bypassed.renders.length;
	if (identical) {
		for (let i = 0; i < cached.renders.length; i++) {
			if (cached.renders[i] !== bypassed.renders[i]) {
				identical = false;
				console.error(`  ✗ byte-identity FAILED at consumer #${i} (${label})`);
				failures++;
				break;
			}
		}
	} else {
		console.error(`  ✗ render count mismatch cached=${cached.renders.length} bypassed=${bypassed.renders.length} (${label})`);
		failures++;
	}
	console.log(
		`[${label}] ${iterations} cycles × (1 closeout aggregation + ${CONSUMER_IDS.length} dep-context collects), dep=${depChars} chars`,
	);
	console.log("            readFile  exists  hits  misses   wall ms");
	console.log(
		`  cached   : ${String(cached.readOps.readFile).padStart(7)} ${String(cached.readOps.exists).padStart(6)} ${String(cached.readOps.hits).padStart(5)} ${String(cached.readOps.misses).padStart(7)} ${cached.wallMs.toFixed(1).padStart(9)}`,
	);
	console.log(
		`  bypassed : ${String(bypassed.readOps.readFile).padStart(7)} ${String(bypassed.readOps.exists).padStart(6)} ${String(bypassed.readOps.hits).padStart(5)} ${String(bypassed.readOps.misses).padStart(7)} ${bypassed.wallMs.toFixed(1).padStart(9)}`,
	);
	console.log(
		`  reduction: readFile ${pct(cached.readOps.readFile, bypassed.readOps.readFile)} | exists ${pct(cached.readOps.exists, bypassed.readOps.exists)} | wall ${pct(cached.wallMs, bypassed.wallMs)}`,
	);
	console.log(`  byte-identity (render per consumer, cached vs bypassed): ${identical ? "PASS" : "FAIL"}`);
	return {
		iterations,
		depChars,
		cached: { ...cached.readOps, wallMs: round(cached.wallMs) },
		bypassed: { ...bypassed.readOps, wallMs: round(bypassed.wallMs) },
		readFileReductionPct: pct(cached.readOps.readFile, bypassed.readOps.readFile),
		byteIdentity: identical,
	};
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

console.log(`b11 — dep-context cache: ${CONSUMER_IDS.length} consumers per scenario (fan-in over 1 dep)`);
const scenarios: Record<string, ScenarioNumbers> = {};
scenarios["S1-realistic"] = report("S1-realistic", S1_CHARS, ITERATIONS);
scenarios["S2-tee-band"] = report("S2-tee-band", S2_CHARS, S2_ITERATIONS);

// NDJSON contract line — must be the LAST stdout line (runner parses it).
console.log(
	JSON.stringify({
		name: "b11.dep-context-cache",
		unit: "mixed",
		consumersPerScenario: CONSUMER_IDS.length,
		scenarios,
		failures,
	}),
);

for (const dir of tmpDirs) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

if (failures > 0) {
	console.error(`\nb11 FAILED (${failures} assertion(s))`);
	process.exit(1);
}
console.log("\nb11 PASSED");

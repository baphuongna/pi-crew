/**
 * b10 — R10-1 batch-closeout result-artifact read cache bench.
 *
 * Proves the per-run result-artifact read cache (task-output-context.ts,
 * `createResultArtifactReadCache`) eliminates the redundant
 * `results/<taskId>.txt` re-reads in the batch closeout path — every settled
 * batch is aggregated TWICE per closeout (team-runner.ts batch-summary
 * artifact + group-join delivery body) — WITHOUT changing any bytes:
 *
 *   (a) fs-op counts via `__test__resultReadStats` (readFile/existsSync
 *       actually issued through the cache seam) for a cache-enabled run vs a
 *       cache-disabled control run (`PI_CREW_DISABLE_RESULT_READ_CACHE=1`,
 *       read once at cache creation);
 *   (b) ≥50% readFile reduction on the closeout path (previously every
 *       settled artifact was read exactly twice per run — batch summary +
 *       group-join — so the expected cached-run reduction is exactly 50%;
 *       existsSync is reduced by the same factor since both ops are memoized
 *       as one unit);
 *   (c) byte-identity: every batches/*.md artifact written by EACH run equals
 *       a fresh UNCACHED `aggregateTaskOutputs()` over the same tasks in the
 *       same order, AND the per-task sections are identical between the
 *       cached and uncached runs after normalizing the tmpdir path (cached vs
 *       uncached parity; grouping-robust because sections are compared per
 *       task id, not per file);
 *   (d) both wall times printed.
 *
 * Synthetic workload: 6 phases × 4 tasks (24 tasks, chain deps — phase k
 * follows k-1, tasks within a phase settle one at a time),
 * `PI_TEAMS_MOCK_CHILD_PI=success` — the REAL closeout path with REAL
 * artifacts (small outputs). Harness mirrors
 * test/unit/teams/team-runner-characterization.test.ts. `groupJoin: "group"`
 * forces a group-join delivery for every closeout regardless of settled-batch
 * size (smart mode skips single-task batches), maximizing the measured
 * redundancy deterministically. The within-phase chain keeps settle order
 * deterministic (parallel mock settles raced run.lock in persistSingleTaskUpdate
 * under unrelated in-flight sibling work — transient, not this fix's subject).
 *
 * Run standalone (NO package.json script — bench/ files are standalone):
 *   node --experimental-strip-types bench/b10-batch-closeout.bench.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { __test__resultReadStats, aggregateTaskOutputs } from "../src/runtime/task-output-context.ts";
import { executeTeamRun } from "../src/runtime/team-runner.ts";
import { createRunManifest, saveRunTasks } from "../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../src/state/types.ts";

const PHASES = 6;
const PER_PHASE = 4;
const LETTERS = ["a", "b", "c", "d", "e", "f"] as const;

const tmpDirs: string[] = [];

interface MockEnvState {
	mock: string | undefined;
	allow: string | undefined;
	cacheBypass: string | undefined;
}

function saveMockEnv(): MockEnvState {
	return {
		mock: process.env.PI_TEAMS_MOCK_CHILD_PI,
		allow: process.env.PI_CREW_ALLOW_MOCK,
		cacheBypass: process.env.PI_CREW_DISABLE_RESULT_READ_CACHE,
	};
}

function restoreMockEnv(state: MockEnvState): void {
	if (state.mock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	else process.env.PI_TEAMS_MOCK_CHILD_PI = state.mock;
	if (state.allow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
	else process.env.PI_CREW_ALLOW_MOCK = state.allow;
	if (state.cacheBypass === undefined) delete process.env.PI_CREW_DISABLE_RESULT_READ_CACHE;
	else process.env.PI_CREW_DISABLE_RESULT_READ_CACHE = state.cacheBypass;
}

/** makeTask from team-runner-characterization.test.ts — graph.queue:"ready" is
 *  REQUIRED for task-graph-scheduler readiness classification. */
function makeTask(id: string, stepId: string, runId: string, cwd: string, dependsOn: string[] = []): TeamTaskState {
	return {
		id,
		runId,
		stepId,
		role: "worker",
		agent: "worker",
		title: id,
		status: "queued",
		dependsOn,
		cwd,
		graph: {
			taskId: id,
			children: [],
			dependencies: dependsOn,
			queue: "ready",
		},
	};
}

interface RunOutcome {
	label: string;
	cwd: string;
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	stats: { readFile: number; exists: number; hits: number; misses: number };
	wallMs: number;
}

/** One synthetic multi-batch run through the real executeTeamRun closeout. */
async function runSynthetic(label: string, cacheDisabled: boolean): Promise<RunOutcome> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-b10-${label}-`));
	tmpDirs.push(cwd);
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

	const team = {
		name: `b10-${label}`,
		description: "",
		roles: [{ name: "worker", agent: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const steps: Array<{ id: string; role: string; task: string; dependsOn?: string[] }> = [];
	const taskSpecs: Array<{ id: string; stepId: string; dependsOn: string[] }> = [];
	let counter = 0;
	let prevStep: string | undefined;
	for (let phase = 1; phase <= PHASES; phase++) {
		for (const letter of LETTERS.slice(0, PER_PHASE)) {
			const stepId = `p${phase}${letter}`;
			counter += 1;
			steps.push({ id: stepId, role: "worker", task: `work ${stepId}`, ...(prevStep ? { dependsOn: [prevStep] } : {}) });
			taskSpecs.push({ id: `${String(counter).padStart(2, "0")}_${stepId}`, stepId, dependsOn: prevStep ? [prevStep] : [] });
			prevStep = stepId;
		}
	}
	const workflow = {
		name: `b10-${label}`,
		description: "",
		steps,
		source: "test",
		filePath: "builtin",
	} as never;
	const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

	const created = createRunManifest({ cwd, team, workflow, goal: `b10 ${label}` });
	const tasks = taskSpecs.map((spec) => makeTask(spec.id, spec.stepId, created.manifest.runId, cwd, spec.dependsOn));
	saveRunTasks(created.manifest, tasks);

	// Mock child (real closeout path, real artifacts, small deterministic
	// outputs) + cache bypass for the control run. The bypass env is read ONCE
	// at cache creation inside executeTeamRunCore, so it must be set before the
	// call and is scrubbed immediately after.
	process.env.PI_TEAMS_MOCK_CHILD_PI = "success";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	if (cacheDisabled) process.env.PI_CREW_DISABLE_RESULT_READ_CACHE = "1";
	else delete process.env.PI_CREW_DISABLE_RESULT_READ_CACHE;

	__test__resultReadStats.reset();
	const start = performance.now();
	const result = await executeTeamRun({
		manifest: { ...created.manifest, status: "running" },
		tasks,
		team,
		workflow,
		agents,
		executeWorkers: true,
		reliability: { autoRetry: false },
		// "group" fires a group-join delivery for EVERY closeout (smart skips
		// single-task settled batches) — the second aggregation per artifact.
		runtimeConfig: { groupJoin: "group" },
		workspaceId: cwd,
	});
	const wallMs = Math.round(performance.now() - start);
	const stats = {
		readFile: __test__resultReadStats.readFile,
		exists: __test__resultReadStats.exists,
		hits: __test__resultReadStats.hits,
		misses: __test__resultReadStats.misses,
	};
	delete process.env.PI_CREW_DISABLE_RESULT_READ_CACHE;

	// Structural sanity: the closeout path actually ran to completion.
	const completed = result.tasks.filter((t) => t.status === "completed").length;
	if (completed !== PHASES * PER_PHASE) {
		throw new Error(`${label}: expected ${PHASES * PER_PHASE} completed tasks, got ${completed} (status=${result.manifest.status})`);
	}
	if (result.manifest.status !== "completed") {
		throw new Error(`${label}: expected manifest status "completed", got ${result.manifest.status}`);
	}
	console.log(`b10 ${label}: ${completed} tasks completed in ${PHASES} phases, wallMs=${wallMs}`);
	return { label, cwd, manifest: result.manifest, tasks: result.tasks, stats, wallMs };
}

/**
 * (c) byte-identity, grouping-robust half 1: every batches/*.md artifact written
 * by `outcome`'s run equals a fresh UNCACHED aggregateTaskOutputs() over the
 * same tasks in the same order. Returns taskId → normalized section text
 * (index stripped from the header, tmpdir path normalized).
 */
function verifyBatchBytesAndCollectSections(outcome: RunOutcome): Map<string, string> {
	const batchesDir = path.join(outcome.manifest.artifactsRoot, "batches");
	if (!fs.existsSync(batchesDir)) throw new Error(`${outcome.label}: no batches/ dir — closeout path not exercised`);
	const files = fs
		.readdirSync(batchesDir)
		.filter((f) => f.endsWith(".md"))
		.sort();
	if (files.length === 0) throw new Error(`${outcome.label}: no batch summary artifacts written`);
	const byId = new Map(outcome.tasks.map((t) => [t.id, t] as const));
	const sections = new Map<string, string>();
	for (const file of files) {
		const raw = fs.readFileSync(path.join(batchesDir, file), "utf-8");
		// Self-describing headers: "=== Task N: <id> (<agent>) ===" — parse the
		// aggregation order straight from the written bytes.
		const ids = [...raw.matchAll(/^=== Task \d+: (\S+) \(\S+\) ===$/gm)].map((m) => m[1]!);
		if (ids.length === 0) throw new Error(`${outcome.label}: batch artifact ${file} has no task headers`);
		const ordered: TeamTaskState[] = [];
		for (const id of ids) {
			const task = byId.get(id);
			if (!task) throw new Error(`${outcome.label}: batch artifact ${file} references unknown task ${id}`);
			ordered.push(task);
		}
		// Fresh UNCACHED aggregation — the exact bytes the disabled-cache path
		// would have written for this batch. (Counter pollution is irrelevant:
		// stats were captured before this verification runs.)
		const recomputed = aggregateTaskOutputs(ordered, outcome.manifest);
		if (recomputed !== raw) {
			throw new Error(
				`${outcome.label}: batch artifact ${file} is NOT byte-identical to the uncached aggregation\n--- written ---\n${raw.slice(0, 400)}\n--- recomputed ---\n${recomputed.slice(0, 400)}`,
			);
		}
		// Aggregate-output sections are self-delimiting: split before each
		// header keeps inter-section separators ("\n\n") attached to the END of
		// the preceding section, so trimEnd() makes a task's section text
		// independent of how tasks were grouped into batch files.
		const parts = raw.split(/(?=^=== Task \d+: )/m).filter((section) => section.length > 0);
		if (parts.length !== ids.length) {
			throw new Error(`${outcome.label}: batch artifact ${file} parsed ${ids.length} ids but ${parts.length} sections`);
		}
		for (let i = 0; i < ids.length; i++) {
			const id = ids[i]!;
			if (!sections.has(id)) {
				sections.set(
					id,
					parts[i]!.replace(/^=== Task \d+: /, "=== Task: ")
						// Normalize run-specific path segments: the tmp cwd AND the runId
						// (embedded in artifactsRoot = <base>/<runId>/artifacts — differs
						// per run by design).
						.replaceAll(outcome.cwd, "<CWD>")
						.replaceAll(outcome.manifest.runId, "<RUN>")
						.trimEnd(),
				);
			}
		}
	}
	if (sections.size !== PHASES * PER_PHASE) {
		throw new Error(`${outcome.label}: expected sections for ${PHASES * PER_PHASE} tasks, got ${sections.size}`);
	}
	return sections;
}

async function main(): Promise<void> {
	// (a) two fresh runs: cache-enabled vs cache-disabled control.
	const cached = await runSynthetic("cached", false);
	const uncached = await runSynthetic("uncached", true);

	// Cache engaged / control really bypassed.
	if (cached.stats.hits <= 0) throw new Error(`cached run recorded ${cached.stats.hits} hits — cache never engaged`);
	if (uncached.stats.hits !== 0) throw new Error(`uncached control recorded ${uncached.stats.hits} hits — bypass failed`);
	if (cached.stats.readFile <= 0) throw new Error("cached run recorded zero readFile ops — measurement broken");

	// (b) ≥50% readFile reduction (every settled artifact was read exactly
	// twice uncached: batch summary + group-join; cached: once).
	const readReduction = 1 - cached.stats.readFile / uncached.stats.readFile;
	const existsReduction = 1 - cached.stats.exists / uncached.stats.exists;
	if (uncached.stats.readFile < 2 * cached.stats.readFile) {
		throw new Error(
			`FAIL ≥50% readFile reduction: cached=${cached.stats.readFile} uncached=${uncached.stats.readFile} (reduction=${(readReduction * 100).toFixed(1)}%)`,
		);
	}
	if (uncached.stats.exists < 2 * cached.stats.exists) {
		throw new Error(
			`FAIL ≥50% existsSync reduction: cached=${cached.stats.exists} uncached=${uncached.stats.exists} (reduction=${(existsReduction * 100).toFixed(1)}%)`,
		);
	}

	// (c) byte-identity: written bytes vs uncached recomputation (per run) +
	// cached-vs-uncached per-task section parity across the two runs.
	const sectionsCached = verifyBatchBytesAndCollectSections(cached);
	const sectionsUncached = verifyBatchBytesAndCollectSections(uncached);
	for (const [id, section] of sectionsCached) {
		const other = sectionsUncached.get(id);
		if (other === undefined) throw new Error(`task ${id} has a batch section in the cached run but not the uncached run`);
		if (other !== section) {
			throw new Error(
				`task ${id} batch section differs between cached and uncached runs:\n--- cached ---\n${section.slice(0, 300)}\n--- uncached ---\n${other.slice(0, 300)}`,
			);
		}
	}

	console.log(
		`b10 comparison: readFile ${cached.stats.readFile} vs ${uncached.stats.readFile} (${(readReduction * 100).toFixed(1)}% reduction), existsSync ${cached.stats.exists} vs ${uncached.stats.exists} (${(existsReduction * 100).toFixed(1)}% reduction), cache hits/misses ${cached.stats.hits}/${cached.stats.misses}`,
	);
	// (d) wall times.
	const result = {
		name: "b10.batch-closeout",
		unit: "fs-ops (closeout path)",
		workload: { phases: PHASES, perPhase: PER_PHASE, tasks: PHASES * PER_PHASE },
		cached: { ...cached.stats, wallMs: cached.wallMs },
		uncached: { ...uncached.stats, wallMs: uncached.wallMs },
		readReductionPct: Math.round(readReduction * 1000) / 10,
		existsReductionPct: Math.round(existsReduction * 1000) / 10,
		batchBytesByteIdentical: true,
	};
	console.log(JSON.stringify(result));
}

const prevEnv = saveMockEnv();
try {
	await main();
} finally {
	restoreMockEnv(prevEnv);
	__test__resultReadStats.reset();
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
}

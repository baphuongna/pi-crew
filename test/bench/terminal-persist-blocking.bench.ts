/**
 * Bench: event-loop blocking during task completion persistence.
 *
 * Answers the A5-C2 question from docs/perf/performance-audit-report-2026-07.md:
 * "does persistSingleTaskUpdate's sync run lock block the event loop 200–800ms
 * during 4-way parallel completion?"
 *
 * Measures, against the REAL persist path (not just the atomic-write primitive):
 *   1. serialPersist        — full persistSingleTaskUpdate latency (lock + load +
 *                             CAS + coalesced write), single-threaded baseline.
 *   2. saveManifestLarge    — saveRunManifest cost with a realistic artifact count.
 *   3. singleTerminalBlock  — ONE full terminal block (saveRunManifest + persist),
 *                             direct timing. In reality completions are spread
 *                             over minutes, so each completion runs ONE such block.
 *                             THIS is the per-completion event-loop cost that matters.
 *   4. spacedBurst          — CONCURRENCY completions spaced by setTimeout gaps so
 *                             the event loop turns over between blocks, under
 *                             monitorEventLoopDelay. Quantifies real event-loop lag.
 *
 * Verdict logic:
 *   - If singleTerminalBlock is small (~tens of ms) and spacedBurst per-call ≈
 *     singleTerminalBlock (contentionRatio ~1.0), there is NO lock contention and
 *     A5-C2's async-lock conversion is not worth the ripple risk.
 *   - contentionRatio >> 1 would indicate lock contention between completions.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createRunManifest, __test__clearManifestCache as clearManifestCache, saveRunManifest } from "../../src/state/state-store.ts";
import { persistSingleTaskUpdate } from "../../src/runtime/task-runner/state-helpers.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

const ITERS = Number(process.env.BENCH_ITERS ?? 50);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 4);
const ARTIFACT_COUNT = Number(process.env.BENCH_ARTIFACTS ?? 60);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-bench-tpb-"));
try {
	fs.writeFileSync(path.join(tmpRoot, "package.json"), "{}\n", "utf-8");
	fs.mkdirSync(path.join(tmpRoot, ".git"), { recursive: true });

	const T0 = new Date().toISOString();

	function buildTeam(): TeamConfig {
		return {
			name: "bench-team",
			description: "bench",
			source: "project" as never,
			filePath: path.join(tmpRoot, "team.md"),
			roles: [{ name: "executor", agent: "executor" } as never],
		};
	}

	function buildWorkflow(steps: number): WorkflowConfig {
		return {
			name: "bench-workflow",
			description: "bench",
			source: "project" as never,
			filePath: path.join(tmpRoot, "wf.md"),
			steps: Array.from({ length: steps }, (_v, i) => ({
				id: `s${i}`,
				role: "executor",
				task: `bench step ${i}`,
				dependsOn: i === 0 ? [] : [`s${i - 1}`],
			})) as never,
		};
	}

	function freshRun(tasksCount: number): { manifest: TeamRunManifest; tasks: TeamTaskState[] } {
		const { manifest, tasks } = createRunManifest({
			cwd: tmpRoot,
			team: buildTeam(),
			workflow: buildWorkflow(tasksCount),
			goal: "bench goal",
		});
		// Persist initial state so persistSingleTaskUpdate has a real tasks file to CAS against.
		saveRunManifest(manifest);
		fs.writeFileSync(manifest.tasksPath, `${JSON.stringify(tasks, null, 2)}\n`, "utf-8");
		clearManifestCache();
		return { manifest, tasks };
	}

	/** Build a manifest carrying a realistic number of artifact descriptors. */
	function manifestWithArtifacts(manifest: TeamRunManifest, count: number): TeamRunManifest {
		const artifacts: ArtifactDescriptor[] = Array.from({ length: count }, (_v, i) => ({
			kind: "metadata",
			path: `${manifest.artifactsRoot}/metadata/task-${i}.json`,
			createdAt: T0,
			producer: `task-${i % 4}`,
			retention: "run" as const,
		}));
		return { ...manifest, artifacts, updatedAt: new Date().toISOString() };
	}

	// ---------------------------------------------------------------------------
	// Scenario 1: serial persistSingleTaskUpdate (full path: lock + load + CAS + write)
	// ---------------------------------------------------------------------------
	const serialSamples: number[] = [];
	for (let i = 0; i < ITERS; i++) {
		const { manifest, tasks } = freshRun(20);
		const task = { ...tasks[0], status: "completed" as const, finishedAt: T0 };
		// Warm once so we measure steady-state, not first-read cold cost.
		persistSingleTaskUpdate(manifest, tasks, task);
		clearManifestCache();
		const t0 = performance.now();
		persistSingleTaskUpdate(manifest, tasks, { ...task, title: `bench ${i}` });
		serialSamples.push(performance.now() - t0);
		clearManifestCache();
	}
	serialSamples.sort((a, b) => a - b);

	// ---------------------------------------------------------------------------
	// Scenario 2: saveRunManifest with ARTIFACT_COUNT descriptors (terminal size)
	// ---------------------------------------------------------------------------
	const saveSamples: number[] = [];
	for (let i = 0; i < ITERS; i++) {
		const { manifest } = freshRun(20);
		const big = manifestWithArtifacts(manifest, ARTIFACT_COUNT);
		saveRunManifest(big); // warm
		clearManifestCache();
		const t0 = performance.now();
		saveRunManifest({ ...big, updatedAt: new Date().toISOString() });
		saveSamples.push(performance.now() - t0);
		clearManifestCache();
	}
	saveSamples.sort((a, b) => a - b);

	// ---------------------------------------------------------------------------
	// Scenario 3: single realistic terminal block (the actual per-completion cost).
	// ---------------------------------------------------------------------------
	const singleBlockSamples: number[] = [];
	for (let i = 0; i < ITERS; i++) {
		const { manifest, tasks } = freshRun(20);
		const big = manifestWithArtifacts(manifest, ARTIFACT_COUNT);
		const task = { ...tasks[0], status: "completed" as const, finishedAt: T0 };
		saveRunManifest(big);
		persistSingleTaskUpdate(manifest, tasks, task);
		clearManifestCache();
		const t0 = performance.now();
		saveRunManifest(big);
		persistSingleTaskUpdate(manifest, tasks, { ...task, title: `bench ${i}` });
		singleBlockSamples.push(performance.now() - t0);
		clearManifestCache();
	}
	singleBlockSamples.sort((a, b) => a - b);

	// ---------------------------------------------------------------------------
	// Scenario 4: spaced burst under monitorEventLoopDelay. CONCURRENCY completions
	// spaced by setTimeout so the event loop turns over between blocks and the
	// internal ~10ms delay sampler can observe each sync block's lag.
	// ---------------------------------------------------------------------------
	const burstPerCallSamples: number[] = [];
	const delay = monitorEventLoopDelay({ resolution: 1 });
	delay.enable();
	for (let i = 0; i < ITERS; i++) {
		const { manifest, tasks } = freshRun(20);
		const big = manifestWithArtifacts(manifest, ARTIFACT_COUNT);
		let localTasks = tasks;
		for (let w = 0; w < CONCURRENCY; w++) {
			// Spacing: yield to the macrotask queue so the event loop turns over
			// between completions (mirrors real spread-out completions).
			await new Promise<void>((r) => setTimeout(r, 15));
			const task = { ...tasks[w % tasks.length], status: "completed" as const, finishedAt: T0 };
			const t0 = performance.now();
			saveRunManifest(big);
			localTasks = persistSingleTaskUpdate(manifest, localTasks, task);
			burstPerCallSamples.push(performance.now() - t0);
			clearManifestCache();
		}
	}
	delay.disable();
	burstPerCallSamples.sort((a, b) => a - b);

	const out = {
		name: "terminal-persist-blocking",
		iters: ITERS,
		concurrency: CONCURRENCY,
		artifactCount: ARTIFACT_COUNT,
		// Full persistSingleTaskUpdate path (lock + load + CAS + write), persist only.
		serialPersistMs: stats(serialSamples),
		// saveRunManifest with ARTIFACT_COUNT descriptors.
		saveManifestLargeMs: stats(saveSamples),
		// ONE realistic terminal block (saveManifest + persist) = per-completion cost.
		singleTerminalBlockMs: stats(singleBlockSamples),
		// Per-call latency under the spaced burst. Compare to singleTerminalBlock.
		spacedBurstPerCallMs: stats(burstPerCallSamples),
		// monitorEventLoopDelay across the whole spaced burst (ns -> ms).
		eventLoopDelayP50Ms: round(delay.percentile(50) / 1e6),
		eventLoopDelayP95Ms: round(delay.percentile(95) / 1e6),
		eventLoopDelayMaxMs: round(delay.max / 1e6),
		// Contention verdict: spaced per-call p50 / single-block p50.
		// ~1.0 = no lock contention; >>1 = contention between completions.
		contentionRatio: round(percentile(burstPerCallSamples, 0.5) / Math.max(0.001, percentile(singleBlockSamples, 0.5))),
	};
	process.stdout.write(JSON.stringify(out) + "\n");
} finally {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function stats(samples: number[]) {
	return {
		min: round(samples[0] ?? 0),
		p50: round(percentile(samples, 0.5)),
		p95: round(percentile(samples, 0.95)),
		p99: round(percentile(samples, 0.99)),
		max: round(samples[samples.length - 1] ?? 0),
	};
}
function percentile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
	return sorted[idx];
}
function round(n: number): number {
	return Math.round(n * 100) / 100;
}

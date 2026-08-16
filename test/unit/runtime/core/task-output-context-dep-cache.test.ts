/**
 * R10-1 residual — dep-context result-artifact read cache (unit).
 *
 * `collectDependencyOutputContext` now accepts an optional per-run
 * `ResultArtifactReadCache` (same instance the closeout aggregation uses).
 * This file pins the three behaviors the change must guarantee:
 *
 *   (a) cache param honored — the second collect for the same dep with the
 *       same descriptor (sizeBytes|contentHash identity) hits the cache
 *       (readFile counter stays put, hits increment) and renders
 *       byte-identical output;
 *   (b) bypass keeps the OLD behavior — no cache, or
 *       PI_CREW_DISABLE_RESULT_READ_CACHE=1 at cache creation, issues fresh
 *       reads per collect;
 *   (c) TEE-SAFE fallthrough — when the dep result lives in the tee band
 *       (> TEE_THRESHOLD_MULTIPLIER × MAX_RESULT_INLINE_BYTES) a warm cache
 *       is NOT reused: the real readIfSmallWithTee runs again so the
 *       per-consumer tee file is written and fullOutputPath survives.
 *
 * @see src/runtime/task-output-context.ts readTaskResultArtifactWithTee
 * @see bench/b11-dep-context-cache.bench.ts (wall-clock + fs-op proof)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	__test__resultReadStats,
	aggregateTaskOutputs,
	collectDependencyOutputContext,
	createResultArtifactReadCache,
	MAX_RESULT_INLINE_BYTES,
	renderDependencyOutputContext,
	TEE_THRESHOLD_MULTIPLIER,
} from "../../../../src/runtime/task-output-context.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { WorkflowStep } from "../../../../src/workflows/workflow-config.ts";

function makeTmpDir(prefix: string): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return {
		dir,
		cleanup: () => {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

/** Fan-in-style fixture: one completed dep with a result artifact descriptor
 *  carrying cache identity fields (sizeBytes|contentHash), one downstream
 *  consumer task that depends on it. Mirrors dependency-tee.test.ts. */
function buildFixtures(dir: string, depResultChars: number) {
	const relResultPath = "results/dep-1.txt";
	const fullResultPath = path.join(dir, relResultPath);
	fs.mkdirSync(path.dirname(fullResultPath), { recursive: true });
	const rawResult = "Y".repeat(depResultChars);
	fs.writeFileSync(fullResultPath, rawResult, "utf-8");
	const resultArtifact: ArtifactDescriptor = {
		kind: "result",
		path: relResultPath,
		createdAt: new Date().toISOString(),
		producer: "dep-1",
		sizeBytes: Buffer.byteLength(rawResult, "utf-8"),
		contentHash: `sha256:${depResultChars}`,
		retention: "run",
	};
	const manifest = {
		artifactsRoot: dir,
		artifacts: [],
	} as unknown as TeamRunManifest;
	const depTask = {
		id: "dep-1",
		stepId: "dep-step",
		role: "explorer",
		status: "completed",
		resultArtifact,
		dependsOn: [],
	} as unknown as TeamTaskState;
	const mainTask = {
		id: "t-1",
		dependsOn: ["dep-step"],
	} as unknown as TeamTaskState;
	const step = {} as unknown as WorkflowStep;
	return { manifest, depTask, mainTask, step, rawResult, resultArtifact };
}

function collect(manifest: TeamRunManifest, depTask: TeamTaskState, mainTask: TeamTaskState, step: WorkflowStep, cache?: unknown) {
	return collectDependencyOutputContext(manifest, [depTask, mainTask], mainTask, step, cache as never);
}

test("cache param honored: second collect for the same dep hits the cache (readFile stays 1, hits increment)", () => {
	const { dir, cleanup } = makeTmpDir("dep-cache-hit-");
	try {
		__test__resultReadStats.reset();
		const { manifest, depTask, mainTask, step } = buildFixtures(dir, 500); // small — no truncation
		const cache = createResultArtifactReadCache();
		const first = collect(manifest, depTask, mainTask, step, cache);
		assert.equal(__test__resultReadStats.readFile, 1, "first collect must issue exactly one disk read");
		assert.equal(__test__resultReadStats.misses >= 1, true, "first collect must be a cache miss");
		const second = collect(manifest, depTask, mainTask, step, cache);
		assert.equal(__test__resultReadStats.readFile, 1, "second collect must NOT hit the disk (cache hit)");
		assert.equal(__test__resultReadStats.hits, 1, "second collect must register exactly one cache hit");
		// Byte-identity: cached vs uncached renders are identical.
		assert.equal(renderDependencyOutputContext(first), renderDependencyOutputContext(second));
		const third = collect(manifest, depTask, mainTask, step); // no cache = old path
		assert.equal(
			renderDependencyOutputContext(third),
			renderDependencyOutputContext(first),
			"cached render must equal uncached render",
		);
	} finally {
		__test__resultReadStats.reset();
		cleanup();
	}
});

test("cache pre-warmed by aggregateTaskOutputs (closeout seam) is reused by the dep path", () => {
	const { dir, cleanup } = makeTmpDir("dep-cache-closeout-");
	try {
		__test__resultReadStats.reset();
		const { manifest, depTask, mainTask, step } = buildFixtures(dir, 800);
		const cache = createResultArtifactReadCache();
		// Closeout-style aggregation populates the cache first (real runtime
		// order: batch closeout runs before the next batch's dispatch).
		const aggregated = aggregateTaskOutputs([depTask], manifest, cache);
		assert.ok(aggregated.includes("Y".repeat(10)), "aggregation must include the dep body");
		const readsAfterAggregation = __test__resultReadStats.readFile;
		const cachedCtx = collect(manifest, depTask, mainTask, step, cache);
		assert.equal(__test__resultReadStats.readFile, readsAfterAggregation, "dep collect must reuse the closeout's cached read");
		const uncachedCtx = collect(manifest, depTask, mainTask, step);
		assert.equal(renderDependencyOutputContext(cachedCtx), renderDependencyOutputContext(uncachedCtx));
	} finally {
		__test__resultReadStats.reset();
		cleanup();
	}
});

test("bypass without a cache issues fresh reads per collect (old behavior)", () => {
	const { dir, cleanup } = makeTmpDir("dep-cache-nocache-");
	try {
		__test__resultReadStats.reset();
		const { manifest, depTask, mainTask, step } = buildFixtures(dir, 500);
		const first = collect(manifest, depTask, mainTask, step);
		const second = collect(manifest, depTask, mainTask, step);
		assert.equal(__test__resultReadStats.readFile, 2, "uncached collects must read per call");
		assert.equal(__test__resultReadStats.hits, 0, "no cache in play — zero hits");
		assert.equal(renderDependencyOutputContext(first), renderDependencyOutputContext(second));
	} finally {
		__test__resultReadStats.reset();
		cleanup();
	}
});

test("bypass via PI_CREW_DISABLE_RESULT_READ_CACHE=1 keeps the uncached behavior through the cache param", () => {
	const { dir, cleanup } = makeTmpDir("dep-cache-envbypass-");
	try {
		__test__resultReadStats.reset();
		const prev = process.env.PI_CREW_DISABLE_RESULT_READ_CACHE;
		process.env.PI_CREW_DISABLE_RESULT_READ_CACHE = "1";
		try {
			const { manifest, depTask, mainTask, step } = buildFixtures(dir, 500);
			const cache = createResultArtifactReadCache(); // env read once at creation
			const first = collect(manifest, depTask, mainTask, step, cache);
			const second = collect(manifest, depTask, mainTask, step, cache);
			assert.equal(__test__resultReadStats.readFile, 2, "bypassed cache must issue real reads per collect");
			assert.equal(__test__resultReadStats.hits, 0, "bypassed cache lookups always miss");
			assert.equal(renderDependencyOutputContext(first), renderDependencyOutputContext(second));
		} finally {
			if (prev === undefined) delete process.env.PI_CREW_DISABLE_RESULT_READ_CACHE;
			else process.env.PI_CREW_DISABLE_RESULT_READ_CACHE = prev;
		}
	} finally {
		__test__resultReadStats.reset();
		cleanup();
	}
});

test("tee-band truncation: warm cache is NOT reused — tee file written + fullOutputPath present on every collect", () => {
	const { dir, cleanup } = makeTmpDir("dep-cache-tee-");
	try {
		__test__resultReadStats.reset();
		const chars = Math.ceil(MAX_RESULT_INLINE_BYTES * TEE_THRESHOLD_MULTIPLIER) + 100; // >40K → tee fires
		const { manifest, depTask, mainTask, step, rawResult } = buildFixtures(dir, chars);
		const cache = createResultArtifactReadCache();
		const first = collect(manifest, depTask, mainTask, step, cache);
		assert.ok(first.dependencies[0]!.fullOutputPath, "first collect must expose fullOutputPath in the tee band");
		// Warm the cache fully (first collect stores the outcome), then collect
		// for a DIFFERENT consumer task — the per-consumer tee key differs and
		// the truncation fallthrough must still write it.
		const otherTask = { id: "t-2", dependsOn: ["dep-step"] } as unknown as TeamTaskState;
		const second = collect(manifest, depTask, otherTask, step, cache);
		assert.equal(__test__resultReadStats.readFile, 2, "tee-band reads must bypass the warm cache (real read each time)");
		const dep2 = second.dependencies[0]!;
		assert.ok(dep2.fullOutputPath, "truncation fallthrough must preserve fullOutputPath");
		assert.ok(fs.existsSync(dep2.fullOutputPath!), "truncation fallthrough must write the per-consumer tee file");
		assert.equal(fs.readFileSync(dep2.fullOutputPath!, "utf-8"), rawResult, "tee file must contain the FULL raw result");
		assert.notEqual(dep2.fullOutputPath, first.dependencies[0]!.fullOutputPath, "tee path is per-consumer");
		// Same consumer collected twice: byte-identical output, tee re-written idempotently.
		const third = collect(manifest, depTask, otherTask, step, cache);
		assert.equal(__test__resultReadStats.readFile, 3, "tee-band collect never reuses the truncated cache entry");
		assert.equal(renderDependencyOutputContext(third), renderDependencyOutputContext(second));
	} finally {
		__test__resultReadStats.reset();
		cleanup();
	}
});

test("mid-band truncation (above MAX, below tee threshold) still hits the cache byte-identically", () => {
	const { dir, cleanup } = makeTmpDir("dep-cache-mid-");
	try {
		__test__resultReadStats.reset();
		// MAX+1000 < 1.25×MAX → truncated inline, NO tee → cache reuse is safe.
		const { manifest, depTask, mainTask, step } = buildFixtures(dir, MAX_RESULT_INLINE_BYTES + 1000);
		const cache = createResultArtifactReadCache();
		const first = collect(manifest, depTask, mainTask, step, cache);
		assert.ok(first.dependencies[0]!.inlineBytes! < MAX_RESULT_INLINE_BYTES + 1000, "content must be truncated");
		assert.equal(first.dependencies[0]!.fullOutputPath, undefined, "no tee below the tee threshold");
		const second = collect(manifest, depTask, mainTask, step, cache);
		assert.equal(__test__resultReadStats.readFile, 1, "mid-band truncation is below the tee threshold — cache hit allowed");
		assert.equal(renderDependencyOutputContext(second), renderDependencyOutputContext(first));
	} finally {
		__test__resultReadStats.reset();
		cleanup();
	}
});

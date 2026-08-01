/**
 * RT-7 tests: writeProgress dedup cache key stability.
 *
 * Bug: the WeakMap cache was keyed on TeamRunManifest OBJECT IDENTITY, but
 * every writeProgress mutator returns a NEW object (spread) → cache NEVER hit.
 * Fix: key on manifest.runId (stable string). Also hash content once instead
 * of twice per call.
 *
 * These tests verify:
 *   1. The cache is a Map<string,string> keyed on runId (not object identity).
 *   2. Back-to-back calls with DIFFERENT manifest objects (same runId) actually
 *      hit the cache (reuse the existing progress artifact instead of writing).
 *   3. The stored cache value is a valid SHA-256 content hash.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { __test__lastProgressContentHash, __test__writeProgress } from "../../src/runtime/team-runner.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function makeManifest(runId: string, artifactsRoot: string): TeamRunManifest {
	return {
		runId,
		team: "test-team",
		workflow: "default",
		cwd: "/tmp/test-rt7",
		stateRoot: "/tmp/test-rt7/.crew/state",
		artifactsRoot,
		eventsPath: "/tmp/test-rt7/.crew/state/events.jsonl",
		status: "running",
		goal: "test goal",
		summary: "",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		artifacts: [],
		tasks: [],
	} as unknown as TeamRunManifest;
}

function makeTask(id: string, status: TeamTaskState["status"]): TeamTaskState {
	return {
		id,
		stepId: "step-1",
		role: "agent",
		agent: "default",
		status,
		goal: "test",
		taskPacket: { scope: "workspace" },
	} as unknown as TeamTaskState;
}

function makeTmpArtifactsRoot(prefix: string): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const artifactsRoot = path.join(tmpDir, "artifacts");
	fs.mkdirSync(artifactsRoot, { recursive: true });
	return artifactsRoot;
}

// ─── Tests ────────────────────────────────────────────────────────

test("[RT-7] cache is a Map (structural pin — not WeakMap)", () => {
	// WeakMap is not an instance of Map and has no .size. This structural
	// pin fails if the cache type is reverted to WeakMap.
	assert.ok(__test__lastProgressContentHash instanceof Map, "cache should be a Map, not WeakMap");
	assert.equal(typeof __test__lastProgressContentHash.size, "number");
});

test("[RT-7] cache is keyed on runId string, not manifest object identity", () => {
	const artifactsRoot = makeTmpArtifactsRoot("rt7-key-");
	const runId = "rt7-key-test";
	const tasks = [makeTask("task-1", "completed"), makeTask("task-2", "running")];

	const manifestA = makeManifest(runId, artifactsRoot);
	__test__writeProgress(manifestA, tasks, "test-producer");

	// After first call, cache should have an entry for the runId string.
	assert.ok(__test__lastProgressContentHash.has(runId), "cache should have entry for runId string after first writeProgress call");

	// Simulate what mutators do: spread to create a NEW object (same runId).
	const manifestB = { ...manifestA };
	assert.notEqual(manifestA, manifestB, "manifestB should be a different object");
	assert.equal(manifestA.runId, manifestB.runId, "runId should be the same");

	// The cache entry persists because it's keyed on the string runId,
	// not the object identity. With the old WeakMap this would NOT find
	// the entry for manifestB (different object).
	assert.ok(
		__test__lastProgressContentHash.has(manifestB.runId),
		"cache should find entry via runId even with different manifest object",
	);

	fs.rmSync(path.dirname(artifactsRoot), { recursive: true, force: true });
});

test("[RT-7] cache hits when content is identical (forced same timestamp)", () => {
	const artifactsRoot = makeTmpArtifactsRoot("rt7-hit-");
	const runId = "rt7-hit-test";
	const tasks = [makeTask("task-1", "completed")];

	// writeProgress embeds `new Date().toISOString()` in the rendered content.
	// Two back-to-back calls can straddle a millisecond boundary (writeArtifact
	// file I/O takes ~5ms), so the dedup cache would miss on different
	// timestamps. Mock Date to guarantee identical content → identical hash.
	const fixedMs = 1_735_900_800_000; // 2025-01-03T12:00:00.000Z
	const RealDate = globalThis.Date;
	const MockDate = class extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) {
				super(fixedMs);
			} else {
				super(...(args as [string | number | Date]));
			}
		}
		static now() {
			return fixedMs;
		}
	} as unknown as DateConstructor;
	globalThis.Date = MockDate;

	try {
		// First call: cache miss (empty cache) → writeArtifact creates a new
		// progress artifact descriptor.
		const manifestA = makeManifest(runId, artifactsRoot);
		const result1 = __test__writeProgress(manifestA, tasks, "test-producer");

		// Second call: manifestB is a NEW object (different identity) but same
		// runId. Both calls produce identical content (same timestamp via mock)
		// → identical hash → cache HIT. On cache hit, the existing progress
		// artifact is reused (same object reference).
		const manifestB = { ...result1 };
		const result2 = __test__writeProgress(manifestB, tasks, "test-producer");
		const progressArtifact2 = result2.artifacts.find((a) => a.kind === "progress");
		assert.ok(progressArtifact2, "second call should produce a progress artifact");

		// Cache hit: the progress artifact descriptor is REUSED (same reference
		// as the one in manifestB.artifacts, which came from result1).
		// With the old WeakMap (object-identity keying), this would be a NEW
		// descriptor from writeArtifact (different reference).
		assert.strictEqual(
			progressArtifact2,
			manifestB.artifacts.find((a) => a.kind === "progress"),
			"cache hit should reuse existing progress artifact from manifest.artifacts",
		);
	} finally {
		globalThis.Date = RealDate;
	}

	fs.rmSync(path.dirname(artifactsRoot), { recursive: true, force: true });
});

test("[RT-7] cache stores valid SHA-256 content hash per runId", () => {
	const artifactsRoot = makeTmpArtifactsRoot("rt7-hash-");
	const runId = "rt7-hash-test";

	const manifest = makeManifest(runId, artifactsRoot);
	__test__writeProgress(manifest, [], "test-producer");

	const cachedHash = __test__lastProgressContentHash.get(runId);
	assert.ok(cachedHash, "cached hash should exist after writeProgress call");
	assert.equal(cachedHash!.length, 64, "SHA-256 hex digest should be 64 chars");
	assert.match(cachedHash!, /^[0-9a-f]{64}$/, "should be a valid hex digest");

	fs.rmSync(path.dirname(artifactsRoot), { recursive: true, force: true });
});

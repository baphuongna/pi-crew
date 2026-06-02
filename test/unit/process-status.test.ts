import test from "node:test";
import assert from "node:assert/strict";
import {
	checkProcessLiveness,
	isActiveRunStatus,
	isFinishedRunStatus,
	isLikelyOrphanedActiveRun,
	hasStaleAsyncProcess,
} from "../../src/runtime/process-status.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

/**
 * Round 29 (test coverage gaps): `process-status.ts` provides process liveness
 * checks, run status predicates, and orphan/stale detection for team runs.
 *
 * Tests cover pure-function surface. isDisplayActiveRun is tested indirectly
 * through the other functions it delegates to.
 */

// ─── checkProcessLiveness ──────────────────────────────────────────────────

test("checkProcessLiveness: returns false for undefined pid", () => {
	const result = checkProcessLiveness(undefined);
	assert.equal(result.alive, false);
	assert.match(result.detail, /no pid/);
});

test("checkProcessLiveness: returns false for negative pid", () => {
	const result = checkProcessLiveness(-1);
	assert.equal(result.alive, false);
});

test("checkProcessLiveness: returns false for non-integer pid", () => {
	const result = checkProcessLiveness(1.5);
	assert.equal(result.alive, false);
});

test("checkProcessLiveness: returns false for zero pid", () => {
	const result = checkProcessLiveness(0);
	assert.equal(result.alive, false);
});

test("checkProcessLiveness: current process is alive", () => {
	const result = checkProcessLiveness(process.pid);
	assert.equal(result.alive, true);
	assert.match(result.detail, /alive/);
});

test("checkProcessLiveness: non-existent pid returns dead", () => {
	// PID 999999 is very unlikely to exist
	const result = checkProcessLiveness(999999);
	assert.equal(result.alive, false);
});

// ─── isActiveRunStatus ─────────────────────────────────────────────────────

test("isActiveRunStatus: true for active statuses", () => {
	assert.equal(isActiveRunStatus("queued"), true);
	assert.equal(isActiveRunStatus("planning"), true);
	assert.equal(isActiveRunStatus("running"), true);
	assert.equal(isActiveRunStatus("waiting"), true);
});

test("isActiveRunStatus: false for terminal statuses", () => {
	assert.equal(isActiveRunStatus("completed"), false);
	assert.equal(isActiveRunStatus("failed"), false);
	assert.equal(isActiveRunStatus("cancelled"), false);
	assert.equal(isActiveRunStatus("blocked"), false);
});

// ─── isFinishedRunStatus ───────────────────────────────────────────────────

test("isFinishedRunStatus: true for terminal statuses", () => {
	assert.equal(isFinishedRunStatus("completed"), true);
	assert.equal(isFinishedRunStatus("failed"), true);
	assert.equal(isFinishedRunStatus("cancelled"), true);
	assert.equal(isFinishedRunStatus("blocked"), true);
});

test("isFinishedRunStatus: false for active statuses", () => {
	assert.equal(isFinishedRunStatus("running"), false);
	assert.equal(isFinishedRunStatus("queued"), false);
});

// ─── isLikelyOrphanedActiveRun ──────────────────────────────────────────────

test("isLikelyOrphanedActiveRun: false for completed runs", () => {
	const manifest = { status: "completed", updatedAt: new Date().toISOString() } as TeamRunManifest;
	assert.equal(isLikelyOrphanedActiveRun(manifest), false);
});

test("isLikelyOrphanedActiveRun: false for async runs with pid", () => {
	const manifest = {
		status: "running",
		updatedAt: new Date().toISOString(),
		async: { pid: 12345 },
	} as TeamRunManifest;
	assert.equal(isLikelyOrphanedActiveRun(manifest), false);
});

test("isLikelyOrphanedActiveRun: true for stale run with specific summary and no agents", () => {
	const staleTime = Date.now() - 3 * 60 * 1000; // 3 minutes ago
	const manifest = {
		status: "running",
		updatedAt: new Date(staleTime).toISOString(),
		summary: "Creating workflow prompts and placeholder results.",
	} as TeamRunManifest;
	assert.equal(isLikelyOrphanedActiveRun(manifest, [], Date.now()), true);
});

test("isLikelyOrphanedActiveRun: false for stale run with no agents but different summary", () => {
	const staleTime = Date.now() - 3 * 60 * 1000;
	const manifest = {
		status: "running",
		updatedAt: new Date(staleTime).toISOString(),
		summary: "Some other summary",
	} as TeamRunManifest;
	assert.equal(isLikelyOrphanedActiveRun(manifest, [], Date.now()), false);
});

test("isLikelyOrphanedActiveRun: false for recently updated run", () => {
	const manifest = {
		status: "running",
		updatedAt: new Date().toISOString(),
	} as TeamRunManifest;
	assert.equal(isLikelyOrphanedActiveRun(manifest, [], Date.now()), false);
});

test("isLikelyOrphanedActiveRun: false for non-finite updatedAt", () => {
	const manifest = {
		status: "running",
		updatedAt: "not-a-date",
	} as TeamRunManifest;
	assert.equal(isLikelyOrphanedActiveRun(manifest, [], Date.now()), false);
});

// ─── hasStaleAsyncProcess ──────────────────────────────────────────────────

test("hasStaleAsyncProcess: false for completed runs", () => {
	const manifest = {
		status: "completed",
		updatedAt: new Date().toISOString(),
		async: { pid: 999999 },
	} as TeamRunManifest;
	assert.equal(hasStaleAsyncProcess(manifest), false);
});

test("hasStaleAsyncProcess: false when no async field", () => {
	const manifest = {
		status: "running",
		updatedAt: new Date().toISOString(),
	} as TeamRunManifest;
	assert.equal(hasStaleAsyncProcess(manifest), false);
});

test("hasStaleAsyncProcess: true when pid is dead", () => {
	const manifest = {
		status: "running",
		updatedAt: new Date().toISOString(),
		async: { pid: 999999 },
	} as TeamRunManifest;
	assert.equal(hasStaleAsyncProcess(manifest), true);
});

test("hasStaleAsyncProcess: true when pid alive but very stale", () => {
	// 31 minutes ago, but PID is our own (alive)
	const staleTime = Date.now() - 31 * 60 * 1000;
	const manifest = {
		status: "running",
		updatedAt: new Date(staleTime).toISOString(),
		async: { pid: process.pid },
	} as TeamRunManifest;
	assert.equal(hasStaleAsyncProcess(manifest), true);
});

test("hasStaleAsyncProcess: false for recent run with alive pid", () => {
	const manifest = {
		status: "running",
		updatedAt: new Date().toISOString(),
		async: { pid: process.pid },
	} as TeamRunManifest;
	assert.equal(hasStaleAsyncProcess(manifest), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { drainPendingUnits } from "../../src/runtime/team-runner.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

/**
 * Unit tests for drainPendingUnits (CORE-1 fix).
 *
 * CORE-1 problem: pendingUnits (Map of in-flight dispatch promises) was never
 * drained/aborted on early-return paths inside the main while loop in
 * executeTeamRun, leaving zombie child processes. drainPendingUnits aborts a
 * run-scoped AbortController and awaits all settled promises before clearing
 * the map, ensuring no in-flight promise is orphaned.
 */

type PendingUnitValue = { taskIds: string[]; promise: Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> };

/**
 * Builds a mock pendingUnits map. The drain helper never reads the resolved
 * payload, so we cast arbitrary promises to the expected type.
 */
function makePendingMap(entries: Array<{ key: string; promise: Promise<unknown> }>): Map<string, PendingUnitValue> {
	const map = new Map<string, PendingUnitValue>();
	for (const entry of entries) {
		map.set(entry.key, {
			taskIds: [entry.key],
			promise: entry.promise as Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }>,
		});
	}
	return map;
}

test("drainPendingUnits with empty map is a no-op (no abort, immediate resolve)", async () => {
	const controller = new AbortController();
	const abortedBefore = controller.signal.aborted;
	assert.equal(abortedBefore, false);

	const pendingUnits = makePendingMap([]);

	// Should resolve immediately without aborting the controller.
	await drainPendingUnits(pendingUnits, controller);

	assert.equal(pendingUnits.size, 0, "map should remain empty");
	assert.equal(controller.signal.aborted, false, "controller should NOT be aborted for empty map");
});

test("drainPendingUnits with empty map and no controller is a no-op", async () => {
	const pendingUnits = makePendingMap([]);
	await drainPendingUnits(pendingUnits, undefined);
	assert.equal(pendingUnits.size, 0);
});

test("drainPendingUnits aborts the controller when map is non-empty", async () => {
	const controller = new AbortController();
	let resolveFn: () => void;
	const promise = new Promise<void>((resolve) => {
		resolveFn = resolve;
	});
	const pendingUnits = makePendingMap([{ key: "task-1", promise }]);

	// Drain should abort the controller immediately.
	const drainPromise = drainPendingUnits(pendingUnits, controller);

	// The controller is aborted synchronously (before promises settle).
	assert.equal(controller.signal.aborted, true, "controller should be aborted");

	// Now let the promise settle so drain can complete.
	resolveFn!();
	await drainPromise;

	assert.equal(pendingUnits.size, 0, "map should be cleared after drain");
});

test("drainPendingUnits waits for allSettled — does not reject on rejected promises", async () => {
	const controller = new AbortController();
	let resolveFn1: () => void;
	let rejectFn2: (err: Error) => void;
	const promise1 = new Promise<void>((resolve) => {
		resolveFn1 = resolve;
	});
	const promise2 = new Promise<void>((_, reject) => {
		rejectFn2 = reject;
	});
	const pendingUnits = makePendingMap([
		{ key: "task-1", promise: promise1 },
		{ key: "task-2", promise: promise2 },
	]);

	const drainPromise = drainPendingUnits(pendingUnits, controller);

	assert.equal(controller.signal.aborted, true);

	// Settle both promises (one resolves, one rejects). allSettled must
	// swallow the rejection so drainPendingUnits itself never rejects.
	resolveFn1!();
	rejectFn2!(new Error("simulated worker failure"));

	// Should resolve without throwing.
	await drainPromise;

	assert.equal(pendingUnits.size, 0, "map should be cleared after all promises settle");
});

test("drainPendingUnits waits for ALL promises before clearing (waits for slow one)", async () => {
	const controller = new AbortController();
	let fastResolved = false;
	let slowResolveFn: () => void;

	const fastPromise = new Promise<void>((resolve) => {
		fastResolved = true;
		resolve();
	});
	const slowPromise = new Promise<void>((resolve) => {
		slowResolveFn = resolve;
	});
	const pendingUnits = makePendingMap([
		{ key: "fast", promise: fastPromise },
		{ key: "slow", promise: slowPromise },
	]);

	let drainCompleted = false;
	const drainPromise = drainPendingUnits(pendingUnits, controller).then(() => {
		drainCompleted = true;
	});

	// fastPromise already resolved, but drain must NOT complete yet (slow still pending).
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(drainCompleted, false, "drain should not complete while slow promise is pending");

	// Now resolve the slow promise — drain should complete and clear the map.
	slowResolveFn!();
	await drainPromise;

	assert.equal(drainCompleted, true);
	assert.equal(pendingUnits.size, 0, "map should be cleared only after all settle");
});

test("drainPendingUnits without controller still settles and clears promises", async () => {
	let resolveFn: () => void;
	const promise = new Promise<void>((resolve) => {
		resolveFn = resolve;
	});
	const pendingUnits = makePendingMap([{ key: "task-x", promise }]);

	const drainPromise = drainPendingUnits(pendingUnits, undefined);

	resolveFn!();
	await drainPromise;

	assert.equal(pendingUnits.size, 0, "map should be cleared after drain even without controller");
});

test("CORE-1 integration: all in-flight promises settle before early return", async () => {
	// Simulate the scenario CORE-1 addresses: a run hits an early-return
	// condition (e.g. signal aborted) while tasks are in-flight in pendingUnits.
	// Without drainPendingUnits, these promises (and their child processes)
	// would be orphaned as zombies. With the fix, all promises are settled.
	const runController = new AbortController();

	const settled: string[] = [];
	const makeTrackingPromise = (id: string): Promise<unknown> =>
		new Promise((resolve) => {
			// Simulate a child process that responds to the abort signal.
			runController.signal.addEventListener("abort", () => {
				settled.push(id);
				resolve({ manifest: { runId: "test" }, tasks: [] });
			});
		});

	const pendingUnits = makePendingMap([
		{ key: "task-A", promise: makeTrackingPromise("task-A") },
		{ key: "task-B", promise: makeTrackingPromise("task-B") },
		{ key: "task-C", promise: makeTrackingPromise("task-C") },
	]);

	assert.equal(pendingUnits.size, 3);
	assert.equal(settled.length, 0);

	// This mirrors what each early-return path does before `return`.
	await drainPendingUnits(pendingUnits, runController);

	// All three in-flight promises responded to the abort and settled.
	assert.equal(settled.length, 3, "all in-flight promises should settle after drain");
	assert.deepEqual(settled.sort(), ["task-A", "task-B", "task-C"]);
	assert.equal(pendingUnits.size, 0, "map should be cleared — no zombie promises left behind");
});

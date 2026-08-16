/**
 * Phase 5 (Vector #3) regression test for the health-notification filter.
 *
 * Previously the inline filter derived `currentSessionId` from a cast that was
 * always `undefined` and compared against `ownerSessionGeneration` (a field
 * absent from TeamRunManifest), so EVERY owned run was dropped — health
 * warnings never fired for any owned run. The fix derives the real session id
 * and keeps only the CURRENT session's owned runs (+ ownerless runs).
 *
 * Also covers the bug-026 sub-issue C stale-snapshot eviction helpers:
 * TERMINAL_RUN_EVENT_TYPES / isTerminalRunEventType / evictRunFromManifests /
 * applyTerminalRunEventToManifests, plus an end-to-end check against the real
 * runEventBus mirroring the setupRenderLoop onAny wiring.
 *
 * See docs/cross-session-leak-fix-plan.md "Phase 5" and
 * docs/bugs/bug-026-runner-reliability-gaps.md sub-issue C.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	applyTerminalRunEventToManifests,
	evictRunFromManifests,
	filterManifestsForHealthNotifications,
	isTerminalRunEventType,
} from "../../../../src/extension/registration/lifecycle-handlers.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import { runEventBus } from "../../../../src/ui/run-event-bus.ts";

/** Minimal manifest stub — the filter only inspects `ownerSessionId`. */
function makeRun(runId: string, ownerSessionId?: string): TeamRunManifest {
	return { runId, ownerSessionId } as unknown as TeamRunManifest;
}

test("health filter: a run owned by the CURRENT session passes", () => {
	const manifests = [makeRun("own-run", "session-A")];
	const result = filterManifestsForHealthNotifications(manifests, "session-A");
	assert.equal(result.length, 1);
	assert.equal(result[0].runId, "own-run");
});

test("health filter: a run owned by ANOTHER session is filtered out", () => {
	const manifests = [makeRun("other-run", "session-B")];
	const result = filterManifestsForHealthNotifications(manifests, "session-A");
	assert.equal(result.length, 0);
});

test("health filter: ownerless runs always pass", () => {
	const manifests = [makeRun("orphan-run", undefined)];
	// Even with a different/known session, ownerless runs are not attributed.
	const result = filterManifestsForHealthNotifications(manifests, "session-A");
	assert.equal(result.length, 1);
	assert.equal(result[0].runId, "orphan-run");
});

test("health filter: mixed batch keeps only own + ownerless", () => {
	const manifests = [makeRun("own", "session-A"), makeRun("other", "session-B"), makeRun("orphan", undefined)];
	const result = filterManifestsForHealthNotifications(manifests, "session-A");
	assert.deepEqual(
		result.map((r) => r.runId),
		["own", "orphan"],
	);
});

test("health filter: unknown currentSessionId drops all owned runs (back-compat/safety)", () => {
	// When the current session id is unavailable we cannot claim any owned run,
	// so only ownerless runs pass — matching the prior behavior for this case.
	const manifests = [makeRun("owned", "session-A"), makeRun("orphan", undefined)];
	const result = filterManifestsForHealthNotifications(manifests, undefined);
	assert.deepEqual(
		result.map((r) => r.runId),
		["orphan"],
	);
});

test("eviction: isTerminalRunEventType accepts all 6 terminal run event types across both namespaces", () => {
	for (const type of ["run.completed", "run.failed", "run.cancelled", "run_completed", "run_failed", "run_cancelled"]) {
		assert.ok(isTerminalRunEventType(type), `expected terminal: ${type}`);
	}
});

test("eviction: isTerminalRunEventType rejects non-terminal event types", () => {
	for (const type of ["run.started", "run_started", "task.failed", "task_failed", "run_blocked", "worker_status"]) {
		assert.ok(!isTerminalRunEventType(type), `expected NOT terminal: ${type}`);
	}
});

test("eviction: evictRunFromManifests removes the runId and leaves the rest (immutable)", () => {
	const manifests = [makeRun("run-a"), makeRun("run-b"), makeRun("run-c")];
	const result = evictRunFromManifests(manifests, "run-b");
	assert.deepEqual(
		result.map((r) => r.runId),
		["run-a", "run-c"],
	);
	// Pure filter: the input frame is untouched.
	assert.equal(manifests.length, 3);
	// Evicting an absent runId is a no-op pass-through.
	assert.deepEqual(
		evictRunFromManifests(manifests, "missing").map((r) => r.runId),
		["run-a", "run-b", "run-c"],
	);
});

test("eviction: applyTerminalRunEventToManifests evicts on terminal events, passes through otherwise", () => {
	const manifests = [makeRun("run-a"), makeRun("run-b")];
	assert.deepEqual(
		applyTerminalRunEventToManifests(manifests, { type: "run_completed", runId: "run-a" }).map((r) => r.runId),
		["run-b"],
	);
	assert.deepEqual(
		applyTerminalRunEventToManifests(manifests, { type: "run.failed", runId: "run-a" }).map((r) => r.runId),
		["run-b"],
	);
	// Non-terminal events leave the frame untouched (same reference).
	assert.equal(applyTerminalRunEventToManifests(manifests, { type: "task_completed", runId: "run-a" }), manifests);
});

test("eviction: runEventBus terminal events evict the runId from the preloaded frame (integration)", async () => {
	// Mirror the exact setupRenderLoop runEventBus.onAny wiring (bug-026
	// sub-issue C): the production handler is
	//   lastPreloadedManifests = applyTerminalRunEventToManifests(lastPreloadedManifests, event);
	let frame: TeamRunManifest[] = [makeRun("run-x"), makeRun("run-y")];
	const scheduled: string[] = [];
	const unsub = runEventBus.onAny((event) => {
		frame = applyTerminalRunEventToManifests(frame, event);
		scheduled.push(`${event.type}:${event.runId}`);
	});
	try {
		// Underscore namespace — what team-runner actually emits (src/runtime/team-runner.ts:441).
		runEventBus.emit({ type: "run_completed", runId: "run-x" });
		await Promise.resolve(); // emit fan-out is microtask-batched
		assert.deepEqual(
			frame.map((r) => r.runId),
			["run-y"],
		);
		runEventBus.emit({ type: "run_cancelled", runId: "run-y" });
		runEventBus.emit({ type: "task_completed", runId: "run-y" });
		await Promise.resolve();
		assert.equal(frame.length, 0);
		assert.deepEqual(scheduled, ["run_completed:run-x", "run_cancelled:run-y", "task_completed:run-y"]);
	} finally {
		unsub();
	}
});

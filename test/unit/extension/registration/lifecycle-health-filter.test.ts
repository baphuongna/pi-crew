/**
 * Phase 5 (Vector #3) regression test for the health-notification filter.
 *
 * Previously the inline filter derived `currentSessionId` from a cast that was
 * always `undefined` and compared against `ownerSessionGeneration` (a field
 * absent from TeamRunManifest), so EVERY owned run was dropped — health
 * warnings never fired for any owned run. The fix derives the real session id
 * and keeps only the CURRENT session's owned runs (+ ownerless runs).
 *
 * See docs/cross-session-leak-fix-plan.md "Phase 5".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { filterManifestsForHealthNotifications } from "../../../../src/extension/registration/lifecycle-handlers.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

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

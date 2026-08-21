/**
 * B1 battery 2026-08-18 case (b) regression — orphan-cancel vs intentional wait.
 *
 * Live failure chain (run team_20260818162626_1d3e8baadf2a200b):
 *   park on ask → kill -9 owner → respond (requeue) → resume (dispatch) →
 *   worker parks on a fresh ask → a THIRD session's startup scan saw the DEAD
 *   ORIGINAL ownerSessionId (resume never re-owned) + no heartbeat from the
 *   parked worker → orphan-cancelled the LIVE resumed run 5m18s into a
 *   10-minute park, leaving waitState set on the cancelled manifest.
 *
 * Pins the three fixes:
 *   1. cancelOrphanedRuns / detectInterruptedRuns use isIntentionalWait
 *      (plan approval OR pending ask within TTL) — parked runs are skipped.
 *   2. Beyond the waiting TTL, the cancel proceeds AND clears waitState.
 *   3. handleResume adopts the run (ownerSessionId := resuming session).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ManifestCache } from "../../../../src/runtime/manifest-cache.ts";
import { cancelOrphanedRuns, detectInterruptedRuns } from "../../../../src/runtime/recovery/crash-recovery.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

function scaffoldParkedRun(cwd: string, askedAt: Date): TeamRunManifest {
	const created = createRunManifest({
		cwd,
		team: {
			name: "fast-fix",
			description: "",
			roles: [{ name: "explorer", agent: "explorer" }],
			source: "test",
			filePath: "builtin",
		} as never,
		workflow: {
			name: "fast-fix",
			description: "",
			steps: [{ id: "explore", role: "explorer" }],
			source: "test",
			filePath: "builtin",
		} as never,
		goal: "orphan-cancel vs intentional wait",
	});
	const now = new Date().toISOString();
	const manifest: TeamRunManifest = {
		...created.manifest,
		status: "running",
		ownerSessionId: "session-DEAD-OWNER",
		waitState: { taskId: "01_explore", questionId: "q-orphan-test", askedAt: askedAt.toISOString() },
		// Realistic: the manifest was last written when the park state was
		// saved — for a park that is TTL-expired this is old, not `now`.
		updatedAt: askedAt.toISOString(),
	};
	const tasks = created.tasks.map((t) => (t.id === "01_explore" ? { ...t, status: "waiting" as const, startedAt: now } : t));
	saveRunManifest(manifest);
	saveRunTasks(manifest, tasks);
	return manifest;
}

function fakeCache(manifests: TeamRunManifest[]): ManifestCache {
	return { list: () => manifests } as unknown as ManifestCache;
}

test("orphan-cancel: run parked on a LIVE ask answer (within TTL) is SKIPPED even with a dead owner and no heartbeat", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-orphan-wait-"));
	try {
		const manifest = scaffoldParkedRun(cwd, new Date()); // asked just now
		const res = cancelOrphanedRuns(cwd, fakeCache([manifest]), "session-THIRD", 300_000);
		assert.deepEqual(res.cancelled, [], "intentional-wait run must NOT be orphan-cancelled");
		assert.ok(res.skipped.includes(manifest.runId), "run must be in the skipped list");
		const after = loadRunManifestById(cwd, manifest.runId)!;
		assert.equal(after.manifest.status, "running", "run survives the third session's scan");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("orphan-cancel: parked run BEYOND the waiting TTL is cancelled AND waitState is cleared (leak fix)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-orphan-ttl-"));
	try {
		// 25h ago — beyond WAITING_TTL_MS (24h) and beyond the heartbeat threshold.
		const manifest = scaffoldParkedRun(cwd, new Date(Date.now() - 25 * 60 * 60 * 1000));
		const res = cancelOrphanedRuns(cwd, fakeCache([manifest]), "session-THIRD", 300_000);
		assert.deepEqual(res.cancelled, [manifest.runId], "expired intentional-wait run IS orphan-cancelled");
		const after = loadRunManifestById(cwd, manifest.runId)!;
		assert.equal(after.manifest.status, "cancelled");
		assert.equal(after.manifest.waitState, undefined, "cancel must clear the waitState pointer (24h-TTL leak)");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * Regression (session-view): opening an agent's session view mid-run starts a
 * NEW pi session whose deferred startup scan runs cancelOrphanedRuns. The
 * view session id differs from the run's owner, and a FOREGROUND run (async
 * null) has no owner PID to liveness-check — so a run only SECONDS old, whose
 * first worker heartbeat has not been written yet, was orphan-cancelled the
 * instant the user looked at it.
 */
test("orphan-cancel: a young foreground run (fresh manifest, no heartbeat yet) is SKIPPED", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-orphan-young-"));
	try {
		const created = createRunManifest({
			cwd,
			team: { name: "default", description: "", roles: [], source: "test", filePath: "builtin" } as never,
			workflow: { name: "default", description: "", steps: [], source: "test", filePath: "builtin" } as never,
			goal: "young foreground run must survive a view switch",
		});
		const fresh = new Date().toISOString();
		const manifest: TeamRunManifest = {
			...created.manifest,
			status: "running",
			ownerSessionId: "session-MAIN", // owner is the MAIN (pre-view) session
			// foreground/in-process — no async worker pid. Real manifests carry
			// `async: null` (the type only knows `undefined`; keep the null cast).
			async: null as unknown as TeamRunManifest["async"],
			updatedAt: fresh, // written 0s ago by the runner
		};
		saveRunManifest(manifest);
		// Task is running but has NO heartbeat yet (worker still booting).
		saveRunTasks(
			manifest,
			created.tasks.map((t) => (t.id === "01_explore" ? { ...t, status: "running" as const, startedAt: fresh } : t)),
		);
		// A THIRD (view) session's startup scan while the run is still young.
		const res = cancelOrphanedRuns(cwd, fakeCache([manifest]), "session-VIEW", 300_000);
		assert.deepEqual(res.cancelled, [], "a seconds-old run must NOT be orphan-cancelled");
		assert.ok(res.skipped.includes(manifest.runId), "young run must be in the skipped list");
		const after = loadRunManifestById(cwd, manifest.runId)!;
		assert.equal(after.manifest.status, "running", "run survives the view session's scan");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("orphan-cancel: a foreground run QUIET beyond the threshold is still cancelled", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-orphan-quiet-"));
	try {
		const created = createRunManifest({
			cwd,
			team: { name: "default", description: "", roles: [], source: "test", filePath: "builtin" } as never,
			workflow: { name: "default", description: "", steps: [], source: "test", filePath: "builtin" } as never,
			goal: "quiet foreground run still orphan-cancelled",
		});
		const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		const manifest: TeamRunManifest = {
			...created.manifest,
			status: "running",
			ownerSessionId: "session-MAIN",
			async: null as unknown as TeamRunManifest["async"],
			updatedAt: stale, // no writes for 10 min — owner process gone
		};
		saveRunManifest(manifest);
		saveRunTasks(
			manifest,
			created.tasks.map((t) => ({ ...t, status: "running" as const, startedAt: stale })),
		);
		const res = cancelOrphanedRuns(cwd, fakeCache([manifest]), "session-VIEW", 300_000);
		assert.deepEqual(res.cancelled, [manifest.runId], "quiet foreground run IS orphan-cancelled");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("detectInterruptedRuns: run parked on a live ask answer is NOT offered for auto-resume", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-orphan-detect-"));
	try {
		const manifest = scaffoldParkedRun(cwd, new Date());
		const plans = detectInterruptedRuns(cwd, fakeCache([manifest]), 300_000, "session-THIRD");
		assert.equal(plans.length, 0, "parked-on-ask run must not appear in recovery plans");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

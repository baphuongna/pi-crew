/**
 * FIX-2 (live catch, run team_20261030044630_3935473bc4886682): watcher
 * attempt-clamp. crew.task.heartbeat_dead fired 3× for adaptive-01-executor
 * attempt-1 with elapsedMs≈302-305s while the worker was ALIVE — the
 * heartbeat had been silent >5min (deadMs) AND, critically, retry re-queues
 * carry attempt-1's stale heartbeat/agentProgress timestamps forward, so
 * attempt-2 inherits meaningless evidence.
 *
 * Clamp under test (heartbeat-watcher.ts): heartbeat/agentProgress evidence
 * older than the CURRENT attempt's task.startedAt is inadmissible; with no
 * usable evidence, elapsed is computed from startedAt itself — "dead" becomes
 * impossible for any task younger than deadMs.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createMetricRegistry } from "../../../../src/observability/metric-registry.ts";
import { HeartbeatWatcher } from "../../../../src/runtime/heartbeat/heartbeat-watcher.ts";
import { createManifestCache } from "../../../../src/runtime/manifest-cache.ts";
import { createRunManifest, saveRunTasks, updateRunStatus } from "../../../../src/state/stores/state-store.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const team = {
	name: "t",
	description: "",
	source: "test",
	filePath: "t",
	roles: [{ name: "r", agent: "a" }],
} as never;
const workflow = {
	name: "w",
	description: "",
	source: "test",
	filePath: "w",
	steps: [{ id: "s", role: "r", task: "x" }],
} as never;

interface Harness {
	cwd: string;
	notifications: string[];
	watcher: HeartbeatWatcher;
	cache: ReturnType<typeof createManifestCache>;
	dispose: () => void;
}

async function makeHarness(prefix: string, patchTask: (task: Record<string, unknown>) => Record<string, unknown>): Promise<Harness> {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		const r = fs.realpathSync.native(cwd);
		cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		/* keep as-is */
	}
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	const created = createRunManifest({ cwd, team, workflow, goal: "attempt-clamp" });
	const manifest = updateRunStatus(created.manifest, "running", "running");
	saveRunTasks(
		manifest,
		created.tasks.map((task) => patchTask(task as unknown as Record<string, unknown>) as unknown as typeof task),
	);
	const cache = createManifestCache(cwd, { watch: false, debounceMs: 0 });
	const notifications: string[] = [];
	const watcher = new HeartbeatWatcher({
		cwd,
		manifestCache: cache,
		registry: createMetricRegistry(),
		router: {
			enqueue: (n) => {
				notifications.push(n.id ?? "");
				return true;
			},
		},
	});
	return {
		cwd,
		notifications,
		watcher,
		cache,
		dispose: () => {
			watcher.dispose();
			cache.dispose();
		},
	};
}

test("attempt-clamp: heartbeat+agentProgress older than startedAt (inherited from a prior attempt) → NOT dead", async () => {
	const h = await makeHarness("pi-crew-hb-clamp-stale-evidence-", (task) => ({
		...task,
		status: "running" as const,
		// Attempt-2 started at 00:20:00 (task.startedAt resets per attempt);
		// the heartbeat (00:00:00) and agentProgress (00:05:00) are stale
		// attempt-1 artifacts — 20min old, way past deadMs=300s.
		startedAt: "2026-01-01T00:20:00.000Z",
		heartbeat: { workerId: task.id as string, lastSeenAt: "2026-01-01T00:00:00.000Z", alive: true },
		agentProgress: { lastActivityAt: "2026-01-01T00:05:00.000Z" },
	}));
	try {
		h.watcher.tick(Date.parse("2026-01-01T00:22:00.000Z"));
		assert.equal(
			h.notifications.length,
			0,
			"stale pre-attempt evidence must be ignored — task is only 2min into its attempt (< deadMs)",
		);
	} finally {
		h.dispose();
		await removeDirWithRetry(h.cwd);
	}
});

test("attempt-clamp: fresh task with NO heartbeat/agentProgress at all → NOT dead (elapsed from startedAt)", async () => {
	const h = await makeHarness("pi-crew-hb-clamp-fresh-", (task) => ({
		...task,
		status: "running" as const,
		startedAt: "2026-01-01T00:20:00.000Z",
		// no heartbeat, no agentProgress — previously elapsed=∞ → instant "dead".
	}));
	try {
		h.watcher.tick(Date.parse("2026-01-01T00:22:00.000Z"));
		assert.equal(h.notifications.length, 0, "a 2min-old attempt with no evidence cannot be dead");
	} finally {
		h.dispose();
		await removeDirWithRetry(h.cwd);
	}
});

test("attempt-clamp regression pin: old running task with a GENUINELY stale in-attempt heartbeat → still dead", async () => {
	const h = await makeHarness("pi-crew-hb-clamp-real-stale-", (task) => ({
		...task,
		status: "running" as const,
		// Heartbeat written INSIDE the current attempt (after startedAt) but
		// 10min silent — this is a real stuck worker and must stay dead.
		startedAt: "2026-01-01T00:00:00.000Z",
		heartbeat: { workerId: task.id as string, lastSeenAt: "2026-01-01T00:10:00.000Z", alive: true },
	}));
	try {
		h.watcher.tick(Date.parse("2026-01-01T00:20:00.000Z"));
		assert.equal(h.notifications.length, 1, "genuinely stale in-attempt heartbeat must still fire dead");
	} finally {
		h.dispose();
		await removeDirWithRetry(h.cwd);
	}
});

test("attempt-clamp: no startedAt keeps legacy behavior (stale heartbeat → dead)", async () => {
	const h = await makeHarness("pi-crew-hb-clamp-no-start-", (task) => ({
		...task,
		status: "running" as const,
		// No startedAt (never dispatched through the normal ladder): the clamp
		// cannot anchor, so classification falls back to the raw heartbeat —
		// preserving the pre-fix behavior for such fixtures.
		heartbeat: { workerId: task.id as string, lastSeenAt: "2026-01-01T00:00:00.000Z", alive: true },
	}));
	try {
		h.watcher.tick(Date.parse("2026-01-01T00:10:00.000Z"));
		assert.equal(h.notifications.length, 1, "legacy shape (no startedAt) must classify dead exactly as before");
	} finally {
		h.dispose();
		await removeDirWithRetry(h.cwd);
	}
});

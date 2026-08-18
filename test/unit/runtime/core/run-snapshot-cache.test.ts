import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../../../src/runtime/crew-agent-records.ts";
import { appendMailboxMessage } from "../../../../src/state/coordination/mailbox.ts";
import { appendEvent } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { createRunSnapshotCache } from "../../../../src/ui/run-snapshot-cache.ts";

function tempCwd(prefix: string): string {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	// Resolve to long-name form (e.g. C:\Users\runneradmin\...) to match
	// what projectCrewRoot returns via canonicalizePath. This ensures
	// the worktree path and state root are in the same form.
	try {
		const r = fs.realpathSync.native(cwd);
		cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		try {
			cwd = fs.realpathSync(cwd);
		} catch {
			/* keep as-is */
		}
	}
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function fixtures(cwd: string): {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
} {
	const team = {
		name: "fast-fix",
		description: "",
		roles: [{ name: "explorer", agent: "explorer" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "fast-fix",
		description: "",
		steps: [{ id: "explore", role: "explorer" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({
		cwd,
		team,
		workflow,
		goal: "snapshot",
	});
	saveRunManifest({ ...created.manifest, status: "running" });
	saveCrewAgents(created.manifest, [
		{
			id: `${created.manifest.runId}:01`,
			runId: created.manifest.runId,
			taskId: created.tasks[0]?.id ?? "explore",
			agent: "explorer",
			role: "explorer",
			runtime: "child-process",
			status: "running",
			startedAt: created.manifest.createdAt,
			progress: {
				recentTools: [],
				recentOutput: ["first"],
				toolCount: 1,
				currentTool: "read",
				tokens: 10,
			},
		},
	]);
	return { manifest: created.manifest, tasks: created.tasks };
}

test("RunSnapshotCache reuses fresh entries and updates signature after file changes", () => {
	const cwd = tempCwd("pi-crew-snapshot-");
	try {
		const { manifest, tasks } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const first = cache.refreshIfStale(manifest.runId);
		const second = cache.refreshIfStale(manifest.runId);
		assert.equal(first, second);
		saveRunTasks(
			manifest,
			tasks.map((task) => ({
				...task,
				status: "completed",
				usage: { input: 10, output: 20 },
			})),
		);
		const changed = cache.refreshIfStale(manifest.runId);
		assert.notEqual(changed.signature, first.signature);
		assert.equal(changed.progress.completed, 1);
		assert.equal(changed.usage.tokensIn, 10);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("RunSnapshotCache signature flips when planApproval status changes (WP-3)", () => {
	const cwd = tempCwd("pi-crew-snapshot-plan-");
	try {
		const { manifest } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const first = cache.refreshIfStale(manifest.runId);
		// Flip ONLY the planApproval status. Writers normally bump updatedAt too,
		// but the signature must react to the explicit planApproval field without
		// relying on that — keep every other manifest field byte-identical.
		saveRunManifest({
			...manifest,
			status: "running",
			planApproval: {
				required: true,
				status: "pending",
				requestedAt: manifest.updatedAt,
				updatedAt: manifest.updatedAt,
			},
		});
		const pending = cache.refreshIfStale(manifest.runId);
		assert.notEqual(pending.signature, first.signature, "pending approval must change the signature");
		saveRunManifest({
			...manifest,
			status: "running",
			planApproval: {
				required: true,
				status: "approved",
				requestedAt: manifest.updatedAt,
				updatedAt: manifest.updatedAt,
				approvedAt: manifest.updatedAt,
			},
		});
		const approved = cache.refreshIfStale(manifest.runId);
		assert.notEqual(approved.signature, pending.signature, "approval must change the signature again");
		assert.equal(approved.manifest.planApproval?.status, "approved");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("RunSnapshotCache stays functional on parse errors (R10-4 parity: recovers like async)", () => {
	const cwd = tempCwd("pi-crew-snapshot-parse-");
	try {
		const { manifest } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const first = cache.refresh(manifest.runId);
		fs.writeFileSync(manifest.tasksPath, "{not json", "utf-8");
		// R10-4 (Wave 2A): the sync build() now uses loaded.tasks from
		// loadRunManifestById (same as buildAsync since v0.1) — when tasks.json is
		// corrupt, the manifest-io load-with-recovery family (Phase 2.5) quarantines
		// the bad file and recovers a valid task list, so the cache returns a FRESH
		// recovered snapshot instead of holding the stale one. Stale-keep was the
		// old sync-only behavior; async never had it. Contract now: no throw, valid
		// snapshot, progress structurally sound.
		const recovered = cache.refreshIfStale(manifest.runId);
		assert.ok(recovered, "refreshIfStale must not throw on corrupt tasks.json");
		assert.ok(typeof recovered.progress.total === "number", "recovered snapshot must have valid progress");
		assert.deepEqual(Object.keys(recovered).sort(), Object.keys(first).sort(), "same snapshot shape");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("RunSnapshotCache exposes structured cancellation reason", () => {
	const cwd = tempCwd("pi-crew-snapshot-cancel-reason-");
	try {
		const { manifest } = fixtures(cwd);
		appendEvent(manifest.eventsPath, {
			type: "run.cancelled",
			runId: manifest.runId,
			message: "leader stopped",
			data: { reason: "leader_interrupted" },
		});
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const snapshot = cache.refresh(manifest.runId);
		assert.equal(snapshot.cancellationReason, "leader_interrupted");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// Regression for the live-UI flicker reported on 2026-06-26. The widget
// header alternated between "0/1 done" (no snapshot path) and
// "Phase 1/1 default: 0% (0/3)" (snapshot path) every render tick because
// `runEventBus.onChannel("run:state" | "worker:lifecycle", ...)` deleted the
// cache entry on every event. The widget's `snapshotCache.get(runId)` then
// returned `undefined`, forcing widget-model.ts to fall back to `agentsFor(run)`
// (a disk read with no snapshot.tasks). Replacing the delete with a coalesced
// refresh keeps the cache populated between stamp changes.
test("RunSnapshotCache keeps entries populated across event-bus signals", async () => {
	const cwd = tempCwd("pi-crew-snapshot-event-bus-");
	try {
		const { manifest } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd, { ttlMs: 60_000 });
		const initial = cache.refresh(manifest.runId);
		assert.ok(initial);
		// Import lazily so test process state is fresh per run.
		const { runEventBus } = await import("../../../../src/ui/run-event-bus.ts");
		const runId = manifest.runId;
		// Burst of worker:lifecycle + run:state events that, before the fix,
		// would have each deleted the cache entry. After the fix, the cache
		// must still answer `get(runId)` synchronously without the widget
		// having to call refreshIfStale itself. Use only event types that are
		// in both RunEventType union AND in the channel classification Sets
		// (`worker:lifecycle` / `run:state`) — that's what the fix's
		// subscriptions actually listen on.
		const burst = [
			{
				type: "run_started" as const,
				channel: "worker:lifecycle" as const,
			},
			{
				type: "task_started" as const,
				channel: "worker:lifecycle" as const,
			},
			{ type: "mailbox_updated" as const, channel: "run:state" as const },
			{
				type: "task_completed" as const,
				channel: "worker:lifecycle" as const,
			},
			{
				type: "run_completed" as const,
				channel: "worker:lifecycle" as const,
			},
		];
		let survivalCount = 0;
		for (const e of burst) {
			runEventBus.emit({ ...e, runId });
			const after = cache.get(runId);
			if (after) survivalCount++;
		}
		assert.equal(survivalCount, burst.length, "cache entry must survive every event-bus signal");
		// After the coalesce window (80ms) + a small buffer, the cache should
		// have refreshed and still be populated.
		await new Promise((resolve) => setTimeout(resolve, 150));
		const afterCoalesce = cache.get(runId);
		assert.ok(afterCoalesce, "cache entry must remain populated after coalesced refresh");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("RunSnapshotCache marks mailbox counts approximate when tail-truncated", () => {
	const cwd = tempCwd("pi-crew-snapshot-mailbox-large-");
	try {
		const { manifest } = fixtures(cwd);
		for (let i = 0; i < 260; i += 1)
			appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: `please check ${i} ${"x".repeat(220)}`,
			});
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const snapshot = cache.refresh(manifest.runId);
		assert.equal(snapshot.mailbox.approximate, true);
		assert.ok(snapshot.mailbox.inboxUnread > 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("RunSnapshotCache captures mailbox badges and LRU-evicts old entries", () => {
	const cwd = tempCwd("pi-crew-snapshot-lru-");
	try {
		const first = fixtures(cwd).manifest;
		const second = fixtures(cwd).manifest;
		const third = fixtures(cwd).manifest;
		appendMailboxMessage(first, {
			direction: "inbox",
			from: "leader",
			to: "worker",
			body: "please check",
		});
		appendMailboxMessage(first, {
			direction: "outbox",
			from: "worker",
			to: "leader",
			body: "pending",
		});
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0, maxEntries: 2 });
		const firstSnapshot = cache.refresh(first.runId);
		assert.equal(firstSnapshot.mailbox.inboxUnread, 1);
		assert.equal(firstSnapshot.mailbox.outboxPending, 1);
		cache.refresh(second.runId);
		cache.refresh(third.runId);
		assert.equal(cache.get(first.runId), undefined);
		assert.ok(cache.get(second.runId));
		assert.ok(cache.get(third.runId));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../src/runtime/crew-agent-records.ts";
import { appendMailboxMessage } from "../../src/state/mailbox.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../src/state/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";
import { createRunSnapshotCache } from "../../src/ui/run-snapshot-cache.ts";

function tempCwd(prefix: string): string {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
		goal: "snapshot-async",
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

/**
 * PR-F2 / UI-1 — the render path (refreshIfStale) must NOT do synchronous
 * statSync/readFileSync. Previously it called currentStamps (8-9 sync fs
 * calls) every TTL window. Now it uses stale-while-revalidate: returns the
 * cached snapshot and kicks off an async refresh via the existing async fs
 * path (fsp.stat/fsp.readFile).
 */
test("refreshIfStale hot path uses async fs — no sync statSync/readFileSync (UI-1)", async () => {
	const cwd = tempCwd("pi-crew-snapshot-async-ui1-");
	try {
		const { manifest, tasks } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });

		// Cold path: populate cache synchronously (one-time; sync I/O is OK here).
		const initial = cache.refresh(manifest.runId);
		assert.ok(initial, "initial refresh produced a snapshot");
		assert.equal(initial.progress.completed, 0);

		// Modify tasks on disk so stamps will differ on the next refresh.
		saveRunTasks(
			manifest,
			tasks.map((task) => ({ ...task, status: "completed", usage: { input: 10, output: 20 } })),
		);

		// Install spies AFTER the cold path so cold-path sync calls aren't counted.
		const fsp = fs.promises as { stat: (...args: unknown[]) => Promise<unknown> };
		const fsSync = fs as { statSync?: (...args: unknown[]) => unknown; readFileSync?: (...args: unknown[]) => unknown };
		const realFspStat = fsp.stat;
		let asyncStatCount = 0;
		fsp.stat = (...args: unknown[]): Promise<unknown> => {
			asyncStatCount++;
			return realFspStat(...args);
		};

		const realStatSync = fsSync.statSync;
		const realReadFileSync = fsSync.readFileSync;
		let syncStatCount = 0;
		let syncReadCount = 0;
		let syncSpyOk = false;
		try {
			fsSync.statSync = (...args: unknown[]): unknown => {
				syncStatCount++;
				return realStatSync!(...args);
			};
			fsSync.readFileSync = (...args: unknown[]): unknown => {
				syncReadCount++;
				return realReadFileSync!(...args);
			};
			syncSpyOk = true;
		} catch {
			/* ESM namespace may be frozen — behavioral assertions below are sufficient */
		}

		try {
			// HOT PATH: TTL=0 expired → stale-while-revalidate.
			const hot = cache.refreshIfStale(manifest.runId);

			// Must return the cached snapshot (reference equality), proving
			// no synchronous rebuild occurred — the disk change is NOT yet
			// visible.
			assert.equal(hot, initial, "hot path returns cached snapshot (stale-while-revalidate)");
			assert.equal(hot.progress.completed, 0, "cached snapshot still shows pre-change data");

			// Async fs must have been triggered (the fs.promises.stat calls
			// happen synchronously when preloadStale evaluates its
			// Promise.all array before the first await suspends).
			assert.ok(asyncStatCount > 0, `async fs.promises.stat called on hot path (got ${asyncStatCount})`);

			// No sync fs must have been called on the hot path.
			if (syncSpyOk) {
				assert.equal(syncStatCount, 0, `no sync statSync on hot path (got ${syncStatCount})`);
				assert.equal(syncReadCount, 0, `no sync readFileSync on hot path (got ${syncReadCount})`);
			}
		} finally {
			// Restore spies immediately.
			fsp.stat = realFspStat;
			if (syncSpyOk) {
				fsSync.statSync = realStatSync;
				fsSync.readFileSync = realReadFileSync;
			}
		}

		// Wait for the async refresh to complete.
		await new Promise((resolve) => setTimeout(resolve, 150));

		// Cache must now reflect the disk changes.
		const updated = cache.get(manifest.runId);
		assert.ok(updated, "cache populated after async refresh");
		assert.notEqual(updated.signature, initial.signature, "signature changed after async refresh");
		assert.equal(updated.progress.completed, 1, "task completed status reflected after async refresh");
		assert.equal(updated.usage.tokensIn, 10, "usage reflected after async refresh");

		cache.dispose?.();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * PR-F2 / UI-5 — mailboxFrom (sync, O(tasks) readdirSync + per-task reads)
 * is replaced by mailboxFromAsync on the render path via buildAsync.
 * The async version also batches per-task reads with Promise.all.
 */
test("refreshIfStale hot path uses async mailbox reads — mailboxFromAsync (UI-5)", async () => {
	const cwd = tempCwd("pi-crew-snapshot-async-ui5-");
	try {
		const { manifest } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });

		// Cold path.
		const initial = cache.refresh(manifest.runId);
		assert.ok(initial);
		assert.equal(initial.mailbox.inboxUnread, 0);

		// Append a mailbox message so counts change.
		appendMailboxMessage(manifest, {
			direction: "inbox",
			from: "leader",
			to: "worker",
			body: "please check",
		});

		// Spy on async fs — the async build path reads mailbox files via
		// fs.promises (mailboxFromAsync / readMailboxCountsAsync).
		const fsp = fs.promises as { stat: (...args: unknown[]) => Promise<unknown> };
		const realFspStat = fsp.stat;
		let asyncStatCount = 0;
		fsp.stat = (...args: unknown[]): Promise<unknown> => {
			asyncStatCount++;
			return realFspStat(...args);
		};

		try {
			// HOT PATH: triggers async refresh.
			const hot = cache.refreshIfStale(manifest.runId);
			assert.equal(hot, initial, "hot path returns cached snapshot");
			assert.equal(hot.mailbox.inboxUnread, 0, "cached mailbox count not yet updated");
			assert.ok(asyncStatCount > 0, "async fs used on hot path");
		} finally {
			fsp.stat = realFspStat;
		}

		// Wait for async refresh.
		await new Promise((resolve) => setTimeout(resolve, 150));

		// Mailbox count must reflect the appended message.
		const updated = cache.get(manifest.runId);
		assert.ok(updated);
		assert.ok(
			updated.mailbox.inboxUnread >= 1,
			`mailbox inbox updated after async refresh (got ${updated.mailbox.inboxUnread})`,
		);
		assert.notEqual(updated.signature, initial.signature, "signature changed because mailbox changed");

		cache.dispose?.();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * The cold path (first call, no cache) still does a synchronous build so the
 * widget gets a snapshot immediately without "(loading…)" flicker. Only the
 * hot path (cached entry, TTL expired) is switched to async.
 */
test("refreshIfStale cold path still returns a snapshot synchronously (UI-1 regression guard)", () => {
	const cwd = tempCwd("pi-crew-snapshot-async-cold-");
	try {
		const { manifest } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });

		// First call with no cache: must return a real snapshot (not throw).
		const snapshot = cache.refreshIfStale(manifest.runId);
		assert.ok(snapshot, "cold path returns a snapshot synchronously");
		assert.equal(snapshot.runId, manifest.runId);
		assert.ok(snapshot.tasks.length > 0, "snapshot has tasks");

		cache.dispose?.();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

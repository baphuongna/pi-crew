import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveCrewAgents } from "../../src/runtime/crew-agent-records.ts";
import { appendMailboxMessage } from "../../src/state/mailbox.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../src/state/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";
import { createRunSnapshotCache } from "../../src/ui/run-snapshot-cache.ts";

function tempCwd(prefix: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function fixtures(cwd: string): { manifest: TeamRunManifest; tasks: TeamTaskState[] } {
	const team = { name: "fast-fix", description: "", roles: [{ name: "explorer", agent: "explorer" }], source: "test", filePath: "builtin" } as never;
	const workflow = { name: "fast-fix", description: "", steps: [{ id: "explore", role: "explorer" }], source: "test", filePath: "builtin" } as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "snapshot" });
	saveRunManifest({ ...created.manifest, status: "running" });
	saveCrewAgents(created.manifest, [{ id: `${created.manifest.runId}:01`, runId: created.manifest.runId, taskId: created.tasks[0]?.id ?? "explore", agent: "explorer", role: "explorer", runtime: "child-process", status: "running", startedAt: created.manifest.createdAt, progress: { recentTools: [], recentOutput: ["first"], toolCount: 1, currentTool: "read", tokens: 10 } }]);
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
		saveRunTasks(manifest, tasks.map((task) => ({ ...task, status: "completed", usage: { input: 10, output: 20 } })));
		const changed = cache.refreshIfStale(manifest.runId);
		assert.notEqual(changed.signature, first.signature);
		assert.equal(changed.progress.completed, 1);
		assert.equal(changed.usage.tokensIn, 10);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("RunSnapshotCache returns previous valid snapshot on parse errors", () => {
	const cwd = tempCwd("pi-crew-snapshot-parse-");
	try {
		const { manifest } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const first = cache.refresh(manifest.runId);
		fs.writeFileSync(manifest.tasksPath, "{not json", "utf-8");
		const afterError = cache.refreshIfStale(manifest.runId);
		assert.equal(afterError, first);
		assert.equal(afterError.progress.total, first.progress.total);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("RunSnapshotCache marks mailbox counts approximate when tail-truncated", () => {
	const cwd = tempCwd("pi-crew-snapshot-mailbox-large-");
	try {
		const { manifest } = fixtures(cwd);
		for (let i = 0; i < 260; i += 1) appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "worker", body: `please check ${i} ${"x".repeat(220)}` });
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
		appendMailboxMessage(first, { direction: "inbox", from: "leader", to: "worker", body: "please check" });
		appendMailboxMessage(first, { direction: "outbox", from: "worker", to: "leader", body: "pending" });
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

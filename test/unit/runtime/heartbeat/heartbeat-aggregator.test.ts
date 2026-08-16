import assert from "node:assert/strict";
import test from "node:test";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { summarizeHeartbeats } from "../../../../src/ui/heartbeat-aggregator.ts";
import type { RunUiSnapshot } from "../../../../src/ui/snapshot-types.ts";

function task(id: string, status: TeamTaskState["status"], lastSeenAt?: string, alive = true): TeamTaskState {
	return {
		id,
		runId: "run",
		role: "r",
		agent: "a",
		title: id,
		status,
		dependsOn: [],
		cwd: process.cwd(),
		heartbeat: lastSeenAt ? { workerId: id, lastSeenAt, alive } : undefined,
	};
}

function snapshot(tasks: TeamTaskState[], manifestStatus: TeamRunManifest["status"] = "running"): RunUiSnapshot {
	return {
		runId: "run",
		cwd: process.cwd(),
		fetchedAt: 0,
		signature: "s",
		manifest: {
			schemaVersion: 1,
			runId: "run",
			cwd: process.cwd(),
			team: "t",
			workflow: "w",
			goal: "g",
			status: manifestStatus,
			createdAt: "",
			updatedAt: "",
			stateRoot: "",
			artifactsRoot: "",
			tasksPath: "",
			eventsPath: "",
			artifacts: [],
			workspaceMode: "single",
		},
		tasks,
		agents: [],
		progress: {
			total: tasks.length,
			completed: 0,
			running: 0,
			failed: 0,
			queued: 0,
		},
		usage: { tokensIn: 0, tokensOut: 0, toolUses: 0 },
		mailbox: { inboxUnread: 0, outboxPending: 0, needsAttention: 0 },
		recentEvents: [],
		recentOutputLines: [],
	};
}

test("summarizeHeartbeats classifies healthy stale dead and missing", () => {
	const now = Date.parse("2026-01-01T00:10:00.000Z");
	const summary = summarizeHeartbeats(
		snapshot([
			task("healthy", "running", "2026-01-01T00:09:30.000Z"),
			task("stale", "running", "2026-01-01T00:08:00.000Z"),
			task("dead", "running", "2026-01-01T00:00:00.000Z"),
			task("missing", "running"),
			task("finished", "completed"),
		]),
		{ now, staleMs: 60_000, deadMs: 5 * 60_000 },
	);
	assert.equal(summary.healthy, 1);
	assert.equal(summary.stale, 1);
	assert.equal(summary.dead, 1);
	assert.equal(summary.missing, 1);
	assert.equal(summary.worstStaleMs, 10 * 60_000);
});

test("summarizeHeartbeats treats alive=false running tasks as dead and supports custom thresholds", () => {
	const summary = summarizeHeartbeats(snapshot([task("a", "running", "2026-01-01T00:00:00.000Z", false)]), {
		now: Date.parse("2026-01-01T00:00:01.000Z"),
		staleMs: 10,
		deadMs: 20,
	});
	assert.equal(summary.dead, 1);
});

test("summarizeHeartbeats ignores queued tasks that have not started", () => {
	const summary = summarizeHeartbeats(snapshot([task("queued", "queued")]), {
		now: Date.parse("2026-01-01T00:00:00.000Z"),
	});
	assert.equal(summary.healthy + summary.stale + summary.dead + summary.missing, 0);
});

test("summarizeHeartbeats ignores terminal tasks", () => {
	const summary = summarizeHeartbeats(snapshot([task("done", "completed")]), {
		now: Date.parse("2026-01-01T00:00:00.000Z"),
	});
	assert.equal(summary.healthy + summary.stale + summary.dead + summary.missing, 0);
});

test("summarizeHeartbeats treats current heartbeat as healthy", () => {
	const summary = summarizeHeartbeats(snapshot([task("now", "running", "2026-01-01T00:00:00.000Z")]), {
		now: Date.parse("2026-01-01T00:00:00.000Z"),
	});
	assert.equal(summary.healthy, 1);
	assert.equal(summary.worstStaleMs, 0);
});

test("summarizeHeartbeats counts invalid heartbeat dates as missing", () => {
	const summary = summarizeHeartbeats(snapshot([task("bad", "running", "not-a-date")]), { now: Date.parse("2026-01-01T00:00:00.000Z") });
	assert.equal(summary.missing, 1);
});

test("summarizeHeartbeats uses strict greater-than thresholds", () => {
	const summary = summarizeHeartbeats(snapshot([task("edge", "running", "2026-01-01T00:00:00.000Z")]), {
		now: Date.parse("2026-01-01T00:01:00.000Z"),
		staleMs: 60_000,
		deadMs: 120_000,
	});
	assert.equal(summary.healthy, 1);
});

test("summarizeHeartbeats regression: running task with >5min stale heartbeat is dead", () => {
	// Pin the invariant: a GENUINELY running task (running manifest) whose
	// heartbeat aged past the dead threshold (default 5 min) MUST still be
	// classified as dead so the health alert fires. The bug-026 sub-issue C
	// run-level gate only suppresses counting when the manifest itself is
	// terminal; for a running manifest summarizeHeartbeats must never be
	// weakened to silently drop real dead-worker alerts.
	const now = Date.parse("2026-01-01T00:10:00.000Z");
	const summary = summarizeHeartbeats(snapshot([task("running-stale", "running", "2026-01-01T00:03:00.000Z")]), {
		now,
		staleMs: 60_000,
		deadMs: 5 * 60_000,
	});
	// heartbeat is 7 min old -> older than deadMs (5 min) -> dead.
	assert.ok(summary.dead >= 1, `expected dead >= 1, got ${summary.dead}`);
});

test("summarizeHeartbeats ignores terminal tasks with ancient heartbeats (bug-026 sub-issue C)", () => {
	// Lock in the task-level gate: isActiveTask() only counts status "running",
	// so a terminal task must never land in dead/missing/stale counters no
	// matter how old its heartbeat is (opts.now far in the future).
	const statuses: TeamTaskState["status"][] = ["completed", "failed", "cancelled", "skipped"];
	for (const status of statuses) {
		const summary = summarizeHeartbeats(snapshot([task(`t-${status}`, status, "2026-01-01T00:00:00.000Z", true)]), {
			now: Date.parse("2026-01-02T00:00:00.000Z"), // heartbeat is a day old
		});
		assert.equal(summary.dead, 0, `dead for ${status}`);
		assert.equal(summary.missing, 0, `missing for ${status}`);
		assert.equal(summary.stale, 0, `stale for ${status}`);
		assert.equal(summary.healthy, 0, `healthy for ${status}`);
	}
});

test("summarizeHeartbeats run-level gate: terminal manifest suppresses lagging running tasks (bug-026 sub-issue C)", () => {
	// Defense-in-depth: a stale snapshot whose task statuses lag the manifest's
	// terminal transition (task still says "running" with an ancient heartbeat)
	// must not report dead/stale workers for a finished run.
	const terminalStatuses = ["blocked", "completed", "failed", "cancelled"] as const;
	for (const manifestStatus of terminalStatuses) {
		const summary = summarizeHeartbeats(snapshot([task("lagging", "running", "2026-01-01T00:00:00.000Z")], manifestStatus), {
			now: Date.parse("2026-01-01T00:10:00.000Z"), // heartbeat 10 min old -> would be dead
		});
		assert.equal(summary.dead, 0, `dead for ${manifestStatus}`);
		assert.equal(summary.missing, 0, `missing for ${manifestStatus}`);
		assert.equal(summary.stale, 0, `stale for ${manifestStatus}`);
		assert.equal(summary.healthy, 0, `healthy for ${manifestStatus}`);
		assert.equal(summary.worstStaleMs, 0, `worstStaleMs for ${manifestStatus}`);
	}
});

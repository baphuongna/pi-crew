/**
 * Module-direct table-driven pin for src/runtime/merge-gate.ts (W-G/G8, V2b).
 *
 * The RT-16 STATUS-LEVEL gate is already exhaustively pinned by
 * test/unit/teams/team-runner-should-merge-table.test.ts (via the team-runner
 * re-export at team-runner.ts:263). This suite pins what that suite does NOT
 * touch — everything the module exports DIRECTLY:
 *
 *  - pure helpers: isNonTerminalTaskStatus, safeFinishedAt,
 *    isMalformedFinishedAtReplacement, statusMergeKey;
 *  - REJECTED_STATUS_MERGE_TRANSITIONS as a VALUE (size + membership +
 *    non-membership of the intentionally-allowed pairs);
 *  - the FIELD-LEVEL guards in shouldMergeTaskUpdate that run AFTER the status
 *    gate (resultArtifact preservation on running/completed, finishedAt
 *    monotonicity, malformed finishedAt replacement, terminal updates must
 *    carry finishedAt, the hasMeaningfulUpdate enumeration);
 *  - mergeTaskUpdatesPreservingTerminal batch semantics (base order,
 *    unknown-id skip, terminal preservation across batches, last-accepted-wins,
 *    silent vs warned rejection, task-graph queue refresh).
 *
 * NOTE: shouldMergeTaskUpdate logs via logInternalError(severity "warn") when
 * the current finishedAt is malformed — always emitted through console.error —
 * and mergeTaskUpdatesPreservingTerminal console.warn's REAL rejected changes.
 * Both are mocked in the tests that trigger them to keep runner output clean
 * and to pin the visibility contract itself.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	isMalformedFinishedAtReplacement,
	isNonTerminalTaskStatus,
	mergeTaskUpdatesPreservingTerminal,
	REJECTED_STATUS_MERGE_TRANSITIONS,
	safeFinishedAt,
	shouldMergeTaskUpdate,
	statusMergeKey,
} from "../../../src/runtime/merge-gate.ts";
import { TEAM_TASK_STATUSES, TEAM_TERMINAL_TASK_STATUSES, type TeamTaskStatus } from "../../../src/state/contracts.ts";
import type { ArtifactDescriptor, TeamTaskState } from "../../../src/state/types.ts";

const NON_TERMINAL: ReadonlyArray<TeamTaskStatus> = TEAM_TASK_STATUSES.filter((s) => !TEAM_TERMINAL_TASK_STATUSES.has(s));
const TERMINAL: ReadonlyArray<TeamTaskStatus> = [...TEAM_TERMINAL_TASK_STATUSES] as TeamTaskStatus[];

function artifact(path: string): ArtifactDescriptor {
	return {
		kind: "result",
		path,
		createdAt: "2026-01-01T00:00:00.000Z",
		producer: "test",
		retention: "run",
	};
}

/** Minimal valid task fixture; `patch` overrides fields under test. */
function task(status: TeamTaskStatus, patch: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id: "t1",
		runId: "run1",
		stepId: "step1",
		role: "executor",
		agent: "executor",
		title: "t1",
		status,
		dependsOn: [],
		cwd: "/tmp",
		...patch,
	};
}

// ─── isNonTerminalTaskStatus ───────────────────────────────────────

test("isNonTerminalTaskStatus: full 8-status table (3 non-terminal true / 5 terminal false)", () => {
	const expected: Record<TeamTaskStatus, boolean> = {
		queued: true,
		running: true,
		waiting: true,
		completed: false,
		failed: false,
		cancelled: false,
		skipped: false,
		needs_attention: false,
	};
	for (const status of TEAM_TASK_STATUSES) {
		assert.equal(isNonTerminalTaskStatus(status), expected[status], `${status} misclassified`);
	}
});

// ─── safeFinishedAt ────────────────────────────────────────────────

test("safeFinishedAt: undefined finishedAt sorts before everything (-Infinity)", () => {
	assert.equal(safeFinishedAt(task("running")), -Infinity);
});

test("safeFinishedAt: valid ISO timestamp returns epoch ms", () => {
	assert.equal(safeFinishedAt(task("completed", { finishedAt: "1970-01-01T00:00:01.000Z" })), 1000);
});

test("safeFinishedAt: malformed (unparseable) finishedAt sorts after everything (Infinity)", () => {
	assert.equal(safeFinishedAt(task("completed", { finishedAt: "not-a-date" })), Infinity);
});

// ─── isMalformedFinishedAtReplacement ─────────────────────────────

test("isMalformedFinishedAtReplacement: finite×finite decision table", () => {
	const rows: ReadonlyArray<[number, number, boolean]> = [
		// [currentTime, updatedTime, expected] — true ONLY when current is
		// non-finite AND updated is finite (corruption replaced by a real value).
		[Infinity, 1000, true],
		[-Infinity, 1000, true],
		[Infinity, Infinity, false],
		[-Infinity, -Infinity, false],
		[1000, Infinity, false],
		[1000, 1000, false],
		[1000, 2000, false],
		[2000, 1000, false],
	];
	for (const [currentTime, updatedTime, expected] of rows) {
		assert.equal(
			isMalformedFinishedAtReplacement(currentTime, updatedTime),
			expected,
			`(${currentTime}, ${updatedTime}) => ${expected}`,
		);
	}
});

// ─── statusMergeKey + REJECTED_STATUS_MERGE_TRANSITIONS (value pin) ──

test("statusMergeKey: stable 'from->to' key format", () => {
	assert.equal(statusMergeKey("waiting", "running"), "waiting->running");
	assert.equal(statusMergeKey("completed", "completed"), "completed->completed");
});

test("REJECTED_STATUS_MERGE_TRANSITIONS: exactly 21 members (15 P1 + 5 P2 + 1 P3)", () => {
	assert.equal(REJECTED_STATUS_MERGE_TRANSITIONS.size, 21);
});

test("REJECTED_STATUS_MERGE_TRANSITIONS: P1 — every terminal→non-terminal pair present", () => {
	for (const from of TERMINAL) {
		for (const to of NON_TERMINAL) {
			assert.ok(REJECTED_STATUS_MERGE_TRANSITIONS.has(statusMergeKey(from, to)), `${from}->${to} must be rejected`);
		}
	}
});

test("REJECTED_STATUS_MERGE_TRANSITIONS: P2 — the 5 completed-integrity flips present", () => {
	const flips: ReadonlyArray<[TeamTaskStatus, TeamTaskStatus]> = [
		["completed", "failed"],
		["completed", "needs_attention"],
		["failed", "completed"],
		["cancelled", "completed"],
		["needs_attention", "completed"],
	];
	for (const [from, to] of flips) {
		assert.ok(REJECTED_STATUS_MERGE_TRANSITIONS.has(statusMergeKey(from, to)), `${from}->${to} must be rejected`);
	}
});

test("REJECTED_STATUS_MERGE_TRANSITIONS: P3 — waiting->running present", () => {
	assert.ok(REJECTED_STATUS_MERGE_TRANSITIONS.has("waiting->running"));
});

test("REJECTED_STATUS_MERGE_TRANSITIONS: intentionally-ALLOWED pairs are absent", () => {
	// completed may be downgraded to cancelled/skipped, and skipped may be
	// completed; non-terminal moves out of queued/running/waiting (except the
	// P3 pair) are legal; same-status keys never sit in the table.
	const allowed: ReadonlyArray<[TeamTaskStatus, TeamTaskStatus]> = [
		["completed", "cancelled"],
		["completed", "skipped"],
		["skipped", "completed"],
		["queued", "running"],
		["running", "waiting"],
		["waiting", "queued"],
		["failed", "cancelled"],
		["cancelled", "skipped"],
	];
	for (const [from, to] of allowed) {
		assert.ok(!REJECTED_STATUS_MERGE_TRANSITIONS.has(statusMergeKey(from, to)), `${from}->${to} must NOT be rejected`);
	}
	for (const s of TEAM_TASK_STATUSES) {
		assert.ok(!REJECTED_STATUS_MERGE_TRANSITIONS.has(statusMergeKey(s, s)), `${s}->${s} must never be rejected`);
	}
});

// ─── shouldMergeTaskUpdate — field-level guards (post status gate) ──

test("field guard: running resultArtifact is never dropped by a stale running snapshot", () => {
	const current = task("running", { resultArtifact: artifact("a.json") });
	const updated = task("running"); // stale: same status, no resultArtifact
	assert.equal(shouldMergeTaskUpdate(current, updated), false);
});

test("field guard: completed resultArtifact is never dropped by a later completed update", () => {
	const current = task("completed", { resultArtifact: artifact("a.json"), finishedAt: "2026-01-01T00:00:00.000Z" });
	const updated = task("completed", { finishedAt: "2026-01-01T00:10:00.000Z" }); // newer, but artifact-less
	assert.equal(shouldMergeTaskUpdate(current, updated), false);
});

test("field guard: gaining a resultArtifact on running is a meaningful update (accepted)", () => {
	const current = task("running");
	const updated = task("running", { resultArtifact: artifact("a.json") });
	assert.equal(shouldMergeTaskUpdate(current, updated), true);
});

test("field guard: replacing a resultArtifact with a different one is accepted", () => {
	const current = task("running", { resultArtifact: artifact("a.json") });
	const updated = task("running", { resultArtifact: artifact("b.json") });
	assert.equal(shouldMergeTaskUpdate(current, updated), true);
});

test("field guard: older finishedAt never overwrites a fresher completion (completed->skipped)", () => {
	// completed->skipped is an ALLOWED pair at the status gate, so the
	// finishedAt comparison is what rejects the stale snapshot.
	const current = task("completed", { finishedAt: "2026-01-01T00:10:00.000Z" });
	const updated = task("skipped", { finishedAt: "2026-01-01T00:05:00.000Z" });
	assert.equal(shouldMergeTaskUpdate(current, updated), false);
});

test("field guard: newer finishedAt flows through (completed->skipped accepted)", () => {
	const current = task("completed", { finishedAt: "2026-01-01T00:05:00.000Z" });
	const updated = task("skipped", { finishedAt: "2026-01-01T00:10:00.000Z" });
	assert.equal(shouldMergeTaskUpdate(current, updated), true);
});

test("field guard: equal finishedAt alone is not a meaningful update (completed->completed)", () => {
	const current = task("completed", { finishedAt: "2026-01-01T00:00:00.000Z" });
	const updated = task("completed", { finishedAt: "2026-01-01T00:00:00.000Z" });
	assert.equal(shouldMergeTaskUpdate(current, updated), false);
});

test("field guard: malformed current finishedAt is replaced by a valid update (accepted + warned)", (t) => {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: swallow console.error noise while pinning the warn contract
	const errorLog = t.mock.method(console, "error", () => {});
	const current = task("completed", { finishedAt: "not-a-date" });
	const updated = task("completed", { finishedAt: "2026-01-01T00:00:00.000Z" });
	assert.equal(shouldMergeTaskUpdate(current, updated), true, "corrupt finishedAt must be replaceable");
	assert.ok(errorLog.mock.callCount() >= 1, "malformed finishedAt must surface via logInternalError warn");
	assert.match(String(errorLog.mock.calls[0]?.arguments.join(" ")), /\[pi-crew:merge-gate\]/);
});

test("field guard: a terminal update without finishedAt is rejected", () => {
	const current = task("skipped", { finishedAt: "2026-01-01T00:00:00.000Z" });
	const updated = task("skipped"); // same-status terminal, finishedAt stripped
	assert.equal(shouldMergeTaskUpdate(current, updated), false);
	// Also via a status transition into a terminal state:
	const currentQueued = task("queued");
	const updatedCompleted = task("completed"); // terminal without finishedAt
	assert.equal(shouldMergeTaskUpdate(currentQueued, updatedCompleted), false);
});

test("field guard: non-terminal heartbeat-only update is accepted (running->running)", () => {
	const current = task("running", { heartbeat: { workerId: "w1", lastSeenAt: "2026-01-01T00:00:00.000Z" } });
	const updated = task("running", { heartbeat: { workerId: "w1", lastSeenAt: "2026-01-01T00:01:00.000Z" } });
	assert.equal(shouldMergeTaskUpdate(current, updated), true);
});

test("field guard: hasMeaningfulUpdate — each meaningful field alone flips the decision", () => {
	const rows: ReadonlyArray<[string, Partial<TeamTaskState>]> = [
		["error", { error: "boom" }],
		["modelAttempts", { modelAttempts: [{ model: "m1", success: true }] }],
		["usage (populated)", { usage: { input: 10, output: 20 } }],
		["usage (empty object still counts as new usage)", { usage: {} }],
		["attempts", { attempts: [{ startedAt: "2026-01-01T00:00:00.000Z" }] }],
		["jsonEvents", { jsonEvents: 5 }],
		[
			"agentProgress.lastActivityAt",
			{ agentProgress: { recentTools: [], recentOutput: [], toolCount: 0, lastActivityAt: "2026-01-01T00:01:00.000Z" } },
		],
		["startedAt", { startedAt: "2026-01-01T00:00:00.000Z" }],
		["heartbeat.lastSeenAt", { heartbeat: { workerId: "w1", lastSeenAt: "2026-01-01T00:01:00.000Z" } }],
	];
	for (const [label, patch] of rows) {
		const current = task("running");
		const updated = task("running", patch);
		assert.equal(shouldMergeTaskUpdate(current, updated), true, `${label} must be meaningful`);
	}
});

test("field guard: a byte-identical snapshot is not a meaningful update", () => {
	const current = task("running", { heartbeat: { workerId: "w1", lastSeenAt: "2026-01-01T00:00:00.000Z" } });
	const updated = task("running", { heartbeat: { workerId: "w1", lastSeenAt: "2026-01-01T00:00:00.000Z" } });
	assert.equal(shouldMergeTaskUpdate(current, updated), false);
});

test("field guard: status change alone (queued->waiting) is meaningful", () => {
	assert.equal(shouldMergeTaskUpdate(task("queued"), task("waiting")), true);
});

// ─── mergeTaskUpdatesPreservingTerminal — batch semantics ─────────

test("batch: base order preserved, unknown ids ignored, accepted updates applied", () => {
	const base = [task("queued", { id: "a" }), task("running", { id: "b" })];
	const results = [
		{
			tasks: [
				task("completed", { id: "a", finishedAt: "2026-01-01T00:01:00.000Z" }),
				task("running", { id: "ghost", error: "unknown id" }), // ignored
			],
		},
	];
	const merged = mergeTaskUpdatesPreservingTerminal(base, results);
	assert.deepEqual(
		merged.map((t) => t.id),
		["a", "b"],
		"base order is reassembled verbatim",
	);
	assert.equal(merged[0]?.status, "completed");
	assert.equal(merged[1]?.status, "running");
});

test("batch: RT-16 terminal preservation holds across result batches (warned, not silent)", (t) => {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: swallow the expected console.warn
	const warn = t.mock.method(console, "warn", () => {});
	const base = [task("completed", { id: "a", finishedAt: "2026-01-01T00:00:00.000Z" })];
	const results = [{ tasks: [task("running", { id: "a", heartbeat: { workerId: "w1", lastSeenAt: "2026-01-01T00:00:00.000Z" } })] }];
	const merged = mergeTaskUpdatesPreservingTerminal(base, results);
	assert.equal(merged[0]?.status, "completed", "a settled task is never resurrected by a batch");
	assert.equal(merged[0]?.finishedAt, "2026-01-01T00:00:00.000Z");
	assert.equal(warn.mock.callCount(), 1, "a REAL rejected change is surfaced exactly once");
});

test("batch: routine no-op skip stays silent (no console.warn)", (t) => {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: mock must swallow output
	const warn = t.mock.method(console, "warn", () => {});
	const base = [task("running", { id: "a", heartbeat: { workerId: "w1", lastSeenAt: "2026-01-01T00:00:00.000Z" } })];
	const results = [{ tasks: [task("running", { id: "a", heartbeat: { workerId: "w1", lastSeenAt: "2026-01-01T00:00:00.000Z" } })] }];
	const merged = mergeTaskUpdatesPreservingTerminal(base, results);
	assert.equal(merged[0]?.status, "running");
	assert.equal(warn.mock.callCount(), 0, "unchanged snapshot skips are normal parallel-merge noise — must stay silent");
});

test("batch: last accepted update wins across sequential result batches", () => {
	const base = [task("running", { id: "a" })];
	const results = [
		{ tasks: [task("running", { id: "a", heartbeat: { workerId: "w1", lastSeenAt: "2026-01-01T00:01:00.000Z" } })] },
		{ tasks: [task("running", { id: "a", heartbeat: { workerId: "w1", lastSeenAt: "2026-01-01T00:02:00.000Z" } })] },
	];
	const merged = mergeTaskUpdatesPreservingTerminal(base, results);
	assert.equal(merged[0]?.heartbeat?.lastSeenAt, "2026-01-01T00:02:00.000Z");
});

test("batch: merged output is queue-refreshed via refreshTaskGraphQueues", () => {
	const base = [
		task("queued", {
			id: "a",
			graph: { taskId: "a", children: [], dependencies: [], queue: "blocked" },
		}),
	];
	const results = [
		{
			tasks: [
				task("running", {
					id: "a",
					graph: { taskId: "a", children: [], dependencies: [], queue: "blocked" },
				}),
			],
		},
	];
	const merged = mergeTaskUpdatesPreservingTerminal(base, results);
	assert.equal(merged[0]?.status, "running");
	assert.equal(merged[0]?.graph?.queue, "running", "running status resolves graph queue to 'running'");

	// Completed tasks resolve to 'done'.
	const doneBase = [
		task("queued", {
			id: "a",
			graph: { taskId: "a", children: [], dependencies: [], queue: "ready" },
		}),
	];
	const doneMerged = mergeTaskUpdatesPreservingTerminal(doneBase, [
		{
			tasks: [
				task("completed", {
					id: "a",
					finishedAt: "2026-01-01T00:00:00.000Z",
					graph: { taskId: "a", children: [], dependencies: [], queue: "ready" },
				}),
			],
		},
	]);
	assert.equal(doneMerged[0]?.graph?.queue, "done");
});

test("batch: empty results return the base (queues refreshed, order intact)", () => {
	const base = [task("queued", { id: "a" }), task("completed", { id: "b", finishedAt: "2026-01-01T00:00:00.000Z" })];
	const merged = mergeTaskUpdatesPreservingTerminal(base, []);
	assert.deepEqual(
		merged.map((t) => t.id),
		["a", "b"],
	);
	assert.equal(merged[0]?.status, "queued");
	assert.equal(merged[1]?.status, "completed");
});

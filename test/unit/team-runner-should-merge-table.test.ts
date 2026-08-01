/**
 * RT-16: exhaustive contract test for the shouldMergeTaskUpdate STATUS-LEVEL
 * gate (REJECTED_STATUS_MERGE_TRANSITIONS in src/runtime/team-runner.ts).
 *
 * This locks the table contract for EVERY old→new status pair so the
 * table-driven refactor cannot silently change a merge/reject decision. The
 * expected matrix below was captured from the original 7 hand-written guards
 * BEFORE the refactor and is byte-for-byte identical (21 rejected pairs, 43
 * accepted pairs).
 *
 * Three policies are covered explicitly:
 *  - P1 terminal preservation  (15 pairs): terminal→non-terminal always rejected.
 *  - P2 completed integrity    (5 pairs):  the completed↔failed/needs_attention
 *    + cancelled→completed / needs_attention→completed flips are rejected.
 *  - P3 waiting→running        (1 pair):   the stale-snapshot regression.
 *
 * NOTE: shouldMergeTaskUpdate returns true=merge / false=reject. The status
 * gate only ever REJECTS (early `return false`); it never forces acceptance.
 * For accepted pairs the function continues to field-level checks, so each
 * `updated` is built with a meaningful field so an accepted decision surfaces
 * as `true` (proving the status gate did not reject). For rejected pairs the
 * gate short-circuits to `false` regardless of fields.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { __test__shouldMergeTaskUpdate } from "../../src/runtime/team-runner.ts";
import { TEAM_TASK_STATUSES, TEAM_TERMINAL_TASK_STATUSES, type TeamTaskStatus } from "../../src/state/contracts.ts";
import type { TeamTaskState } from "../../src/state/types.ts";

const NON_TERMINAL: ReadonlySet<TeamTaskStatus> = new Set(TEAM_TASK_STATUSES.filter((s) => !TEAM_TERMINAL_TASK_STATUSES.has(s)));

/** Build a minimal task; `patch` supplies status + meaningful fields. */
function task(status: TeamTaskStatus, patch: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id: "a",
		runId: "r",
		stepId: "a",
		role: "x",
		agent: "x",
		title: "a",
		status,
		dependsOn: [],
		cwd: "/tmp",
		...patch,
	};
}

/**
 * Build the "current" task (no meaningful payload — baseline snapshot).
 * finishedAt/resultArtifact/error are intentionally absent so the field-level
 * guards (which run AFTER the status gate) don't interfere with rejected pairs.
 */
function currentTask(status: TeamTaskStatus): TeamTaskState {
	return task(status);
}

/**
 * Build the "updated" task. For accepted pairs to surface as `true`, the update
 * must carry a meaningful change (`error`) and — when the target is terminal — a
 * `finishedAt` (guard 11 rejects a terminal update without finishedAt). For
 * rejected pairs these fields are irrelevant because the status gate fires first.
 */
function updatedTask(status: TeamTaskStatus): TeamTaskState {
	const patch: Partial<TeamTaskState> = { error: "meaningful" };
	if (!NON_TERMINAL.has(status)) patch.finishedAt = "2026-01-01T00:00:00.000Z";
	return task(status, patch);
}

// ─── Expected decision matrix ──────────────────────────────────────
//
// Exactly 21 pairs are rejected at the status gate. Everything else is accepted.
// Derived from the three policies implemented by REJECTED_STATUS_MERGE_TRANSITIONS.

/** P1 — terminal preservation: every terminal→non-terminal pair (15). */
const P1_TERMINAL_PRESERVATION: ReadonlyArray<[TeamTaskStatus, TeamTaskStatus]> = TEAM_TERMINAL_TASK_STATUSES.size
	? ([...TEAM_TERMINAL_TASK_STATUSES] as TeamTaskStatus[]).flatMap((from) =>
			([...NON_TERMINAL] as TeamTaskStatus[]).map((to) => [from, to] as [TeamTaskStatus, TeamTaskStatus]),
		)
	: [];

/** P3 — waiting→running stale-snapshot regression (1). */
const P3_WAITING_RUNNING: ReadonlyArray<[TeamTaskStatus, TeamTaskStatus]> = [["waiting", "running"]];

/** P2 — completed integrity flips (5 bespoke terminal→terminal pairs). */
const P2_COMPLETED_INTEGRITY: ReadonlyArray<[TeamTaskStatus, TeamTaskStatus]> = [
	["completed", "failed"],
	["completed", "needs_attention"],
	["failed", "completed"],
	["cancelled", "completed"],
	["needs_attention", "completed"],
];

function key(from: TeamTaskStatus, to: TeamTaskStatus): string {
	return `${from}->${to}`;
}

const EXPECTED_REJECTED: ReadonlySet<string> = new Set([
	...P1_TERMINAL_PRESERVATION.map(([f, t]) => key(f, t)),
	...P3_WAITING_RUNNING.map(([f, t]) => key(f, t)),
	...P2_COMPLETED_INTEGRITY.map(([f, t]) => key(f, t)),
]);

test("[RT-16] rejected matrix has exactly 21 pairs (15 + 1 + 5) with no overlaps", () => {
	assert.equal(P1_TERMINAL_PRESERVATION.length, 15, "P1 terminal preservation = 5 terminal × 3 non-terminal");
	assert.equal(P3_WAITING_RUNNING.length, 1, "P3 waiting->running = 1");
	assert.equal(P2_COMPLETED_INTEGRITY.length, 5, "P2 completed integrity = 5");
	assert.equal(EXPECTED_REJECTED.size, 21, "union has no duplicates");
});

// ─── Exhaustive 8×8 sweep ──────────────────────────────────────────

test("[RT-16] exhaustive 8×8 old→new status pairs match the table contract", () => {
	const mismatches: string[] = [];
	for (const from of TEAM_TASK_STATUSES) {
		for (const to of TEAM_TASK_STATUSES) {
			const current = currentTask(from);
			const updated = updatedTask(to);
			const actual = __test__shouldMergeTaskUpdate(current, updated);
			const expectedRejected = EXPECTED_REJECTED.has(key(from, to));
			// accepted pair must return true (status gate did not reject);
			// rejected pair must return false.
			if (actual === expectedRejected) {
				mismatches.push(`${key(from, to)}: expected ${expectedRejected ? "REJECT (false)" : "ACCEPT (true)"}, got ${actual}`);
			}
		}
	}
	assert.deepEqual(mismatches, [], `status-gate matrix mismatches:\n${mismatches.join("\n")}`);
});

// ─── P1: terminal preservation ────────────────────────────────────

test("[RT-16] P1 terminal preservation: every terminal→non-terminal pair is rejected", () => {
	for (const [from, to] of P1_TERMINAL_PRESERVATION) {
		const result = __test__shouldMergeTaskUpdate(currentTask(from), updatedTask(to));
		assert.equal(result, false, `${key(from, to)} must be rejected (terminal preserved)`);
	}
});

test("[RT-16] P1: a settled task is never resurrected to queued/running/waiting", () => {
	const terminals = [...TEAM_TERMINAL_TASK_STATUSES] as TeamTaskStatus[];
	for (const terminal of terminals) {
		for (const nt of NON_TERMINAL) {
			assert.equal(
				__test__shouldMergeTaskUpdate(currentTask(terminal), updatedTask(nt)),
				false,
				`${key(terminal, nt)} — terminal task resurrected to non-terminal`,
			);
		}
	}
});

// ─── P2: completed integrity ──────────────────────────────────────

test("[RT-16] P2 completed integrity: the 5 completed-touching flips are rejected", () => {
	for (const [from, to] of P2_COMPLETED_INTEGRITY) {
		assert.equal(
			__test__shouldMergeTaskUpdate(currentTask(from), updatedTask(to)),
			false,
			`${key(from, to)} must be rejected (completed integrity)`,
		);
	}
});

test("[RT-16] P2: cancelled→completed and failed→completed resurrections blocked (CANCEL-3 / F3)", () => {
	// Mirror the historical reverse-audit regression tests in team-runner-merge.
	assert.equal(__test__shouldMergeTaskUpdate(currentTask("cancelled"), updatedTask("completed")), false);
	assert.equal(__test__shouldMergeTaskUpdate(currentTask("failed"), updatedTask("completed")), false);
	assert.equal(__test__shouldMergeTaskUpdate(currentTask("needs_attention"), updatedTask("completed")), false);
	assert.equal(__test__shouldMergeTaskUpdate(currentTask("completed"), updatedTask("failed")), false);
	assert.equal(__test__shouldMergeTaskUpdate(currentTask("completed"), updatedTask("needs_attention")), false);
});

test("[RT-16] P2: completed→cancelled and completed→skipped are ACCEPTED (downgrade allowed)", () => {
	// Documents the asymmetry: completed may move to cancelled/skipped but NOT
	// to failed/needs_attention. These are NOT in the rejected set.
	assert.equal(__test__shouldMergeTaskUpdate(currentTask("completed"), updatedTask("cancelled")), true, "completed->cancelled accepted");
	assert.equal(__test__shouldMergeTaskUpdate(currentTask("completed"), updatedTask("skipped")), true, "completed->skipped accepted");
	// skipped→completed is also accepted (only failed/cancelled/needs_attention→completed blocked).
	assert.equal(__test__shouldMergeTaskUpdate(currentTask("skipped"), updatedTask("completed")), true, "skipped->completed accepted");
});

// ─── P3: waiting→running regression ───────────────────────────────

test("[RT-16] P3: waiting→running is rejected (stale-snapshot regression)", () => {
	assert.equal(__test__shouldMergeTaskUpdate(currentTask("waiting"), updatedTask("running")), false, "waiting->running rejected");
});

test("[RT-16] P3: other waiting→* transitions are accepted (queued/completed/failed/cancelled/skipped/needs_attention)", () => {
	const acceptedFromWaiting: TeamTaskStatus[] = TEAM_TASK_STATUSES.filter((s) => s !== "waiting" && s !== "running");
	for (const to of acceptedFromWaiting) {
		assert.equal(__test__shouldMergeTaskUpdate(currentTask("waiting"), updatedTask(to)), true, `waiting->${to} should be accepted`);
	}
});

// ─── Accepted (non-rejected) transitions ──────────────────────────

test("[RT-16] all non-terminal→* pairs from queued/running are accepted at the status gate", () => {
	// queued and running never hit the status gate (they are the source of truth
	// for freshly-dispatched work); every target is accepted.
	for (const from of ["queued", "running"] as TeamTaskStatus[]) {
		for (const to of TEAM_TASK_STATUSES) {
			assert.equal(__test__shouldMergeTaskUpdate(currentTask(from), updatedTask(to)), true, `${key(from, to)} should be accepted`);
		}
	}
});

test("[RT-16] same-status pairs are NOT rejected by the status gate", () => {
	// X→X is never in the rejected set; the field-level checks decide from there.
	for (const s of TEAM_TASK_STATUSES) {
		// Build updated with a heartbeat change so hasMeaningfulUpdate is true
		// even though status/finishedAt are equal (for non-terminal same-status).
		const updated = {
			...updatedTask(s),
			heartbeat: { ...updatedTask(s).heartbeat, lastSeenAt: "2026-01-02T00:00:00.000Z" },
		} as TeamTaskState;
		assert.equal(__test__shouldMergeTaskUpdate(currentTask(s), updated), true, `${key(s, s)} must not be rejected by the status gate`);
	}
});

// ─── Cross-reference vs lifecycle table (documentation) ────────────

test("[RT-16] the merge gate is STRICTER than the lifecycle table where it matters", () => {
	// Documents that the merge path intentionally diverges from
	// TEAM_TASK_STATUS_TRANSITIONS: the lifecycle table allows completed→queued
	// (retry) and waiting→running, but the MERGE rejects both as stale snapshots.
	// This is why the gate is policy-driven, not a plain canTransitionTaskStatus.
	// (We assert the merge decisions directly; the lifecycle divergence is
	// captured here so a future "simplification" to canTransitionTaskStatus is
	// caught.)
	const rejectedDespiteLifecycle: ReadonlyArray<[TeamTaskStatus, TeamTaskStatus]> = [
		["completed", "queued"], // lifecycle legal (retry), merge rejects
		["failed", "queued"], // lifecycle legal (retry), merge rejects
		["waiting", "running"], // lifecycle legal, merge rejects
	];
	for (const [from, to] of rejectedDespiteLifecycle) {
		assert.equal(
			__test__shouldMergeTaskUpdate(currentTask(from), updatedTask(to)),
			false,
			`${key(from, to)} must be rejected by merge even though lifecycle-legal`,
		);
	}
});

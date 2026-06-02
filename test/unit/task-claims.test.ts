import test from "node:test";
import assert from "node:assert/strict";
import {
	createTaskClaim,
	isTaskClaimExpired,
	canUseTaskClaim,
	claimTask,
	releaseTaskClaim,
	transitionClaimedTaskStatus,
} from "../../src/state/task-claims.ts";
import type { TeamTaskState } from "../../src/state/types.ts";

/**
 * Round 29 (test coverage gaps): `task-claims.ts` provides task claim lifecycle
 * management with owner, token, and lease-based expiration.
 *
 * All exports are pure functions — no file I/O.
 */

const NOW = new Date("2026-06-02T12:00:00Z");

function makeTask(overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id: "task-1",
		runId: "run-1",
		stepId: "step-1",
		role: "executor",
		agent: "executor",
		title: "Test task",
		status: "queued",
		cwd: "/tmp",
		...overrides,
	} as TeamTaskState;
}

// ─── createTaskClaim ───────────────────────────────────────────────────────

test("createTaskClaim: creates claim with owner and token", () => {
	const claim = createTaskClaim("worker-1", 300_000, NOW);
	assert.equal(claim.owner, "worker-1");
	assert.ok(claim.token, "should have a token");
	assert.ok(claim.leasedUntil);
});

test("createTaskClaim: lease expires at correct time", () => {
	const claim = createTaskClaim("worker-1", 60_000, NOW);
	const leasedUntil = new Date(claim.leasedUntil);
	assert.equal(leasedUntil.getTime() - NOW.getTime(), 60_000);
});

test("createTaskClaim: token is a valid UUID", () => {
	const claim = createTaskClaim("worker-1", 300_000, NOW);
	assert.match(claim.token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// ─── isTaskClaimExpired ────────────────────────────────────────────────────

test("isTaskClaimExpired: returns false for undefined claim", () => {
	assert.equal(isTaskClaimExpired(undefined, NOW), false);
});

test("isTaskClaimExpired: returns false for valid unexpired claim", () => {
	const claim = createTaskClaim("worker-1", 300_000, NOW);
	assert.equal(isTaskClaimExpired(claim, NOW), false);
});

test("isTaskClaimExpired: returns true for expired claim", () => {
	const claim = createTaskClaim("worker-1", 60_000, NOW);
	const future = new Date(NOW.getTime() + 120_000);
	assert.equal(isTaskClaimExpired(claim, future), true);
});

test("isTaskClaimExpired: returns true for corrupt date string", () => {
	const claim = { owner: "w", token: "t", leasedUntil: "not-a-date" };
	assert.equal(isTaskClaimExpired(claim, NOW), true);
});

// ─── canUseTaskClaim ───────────────────────────────────────────────────────

test("canUseTaskClaim: true for matching owner, token, unexpired claim", () => {
	const claim = createTaskClaim("worker-1", 300_000, NOW);
	const task = makeTask({ claim });
	assert.equal(canUseTaskClaim(task, "worker-1", claim.token, NOW), true);
});

test("canUseTaskClaim: false for wrong owner", () => {
	const claim = createTaskClaim("worker-1", 300_000, NOW);
	const task = makeTask({ claim });
	assert.equal(canUseTaskClaim(task, "worker-2", claim.token, NOW), false);
});

test("canUseTaskClaim: false for wrong token", () => {
	const claim = createTaskClaim("worker-1", 300_000, NOW);
	const task = makeTask({ claim });
	assert.equal(canUseTaskClaim(task, "worker-1", "wrong-token", NOW), false);
});

test("canUseTaskClaim: false for expired claim", () => {
	const claim = createTaskClaim("worker-1", 60_000, NOW);
	const task = makeTask({ claim });
	const future = new Date(NOW.getTime() + 120_000);
	assert.equal(canUseTaskClaim(task, "worker-1", claim.token, future), false);
});

test("canUseTaskClaim: false for no claim", () => {
	const task = makeTask();
	assert.equal(canUseTaskClaim(task, "worker-1", "token", NOW), false);
});

// ─── claimTask ─────────────────────────────────────────────────────────────

test("claimTask: assigns claim to unclaimed task", () => {
	const task = makeTask();
	const claimed = claimTask(task, "worker-1", 300_000, NOW);
	assert.ok(claimed.claim);
	assert.equal(claimed.claim!.owner, "worker-1");
});

test("claimTask: overwrites expired claim", () => {
	const oldClaim = createTaskClaim("worker-old", 60_000, NOW);
	const task = makeTask({ claim: oldClaim });
	const future = new Date(NOW.getTime() + 120_000);
	const claimed = claimTask(task, "worker-new", 300_000, future);
	assert.equal(claimed.claim!.owner, "worker-new");
});

test("claimTask: throws if task has active claim", () => {
	const activeClaim = createTaskClaim("worker-1", 300_000, NOW);
	const task = makeTask({ claim: activeClaim });
	assert.throws(
		() => claimTask(task, "worker-2", 300_000, NOW),
		/already claimed/,
	);
});

test("claimTask: does not mutate original task", () => {
	const task = makeTask();
	const claimed = claimTask(task, "worker-1", 300_000, NOW);
	assert.equal(task.claim, undefined);
	assert.ok(claimed.claim);
});

// ─── releaseTaskClaim ──────────────────────────────────────────────────────

test("releaseTaskClaim: removes claim from task", () => {
	const claim = createTaskClaim("worker-1", 300_000, NOW);
	const task = makeTask({ claim });
	const released = releaseTaskClaim(task, "worker-1", claim.token, NOW);
	assert.equal(released.claim, undefined);
});

test("releaseTaskClaim: throws for wrong owner", () => {
	const claim = createTaskClaim("worker-1", 300_000, NOW);
	const task = makeTask({ claim });
	assert.throws(
		() => releaseTaskClaim(task, "worker-2", claim.token, NOW),
		/not held/,
	);
});

test("releaseTaskClaim: does not mutate original task", () => {
	const claim = createTaskClaim("worker-1", 300_000, NOW);
	const task = makeTask({ claim });
	releaseTaskClaim(task, "worker-1", claim.token, NOW);
	assert.ok(task.claim);
});

// ─── transitionClaimedTaskStatus ───────────────────────────────────────────

test("transitionClaimedTaskStatus: changes status on valid claim", () => {
	const claim = createTaskClaim("worker-1", 300_000, NOW);
	const task = makeTask({ claim, status: "queued" });
	const updated = transitionClaimedTaskStatus(task, "worker-1", claim.token, "running", NOW);
	assert.equal(updated.status, "running");
});

test("transitionClaimedTaskStatus: throws for invalid claim", () => {
	const task = makeTask();
	assert.throws(
		() => transitionClaimedTaskStatus(task, "worker-1", "bad", "running", NOW),
		/not held/,
	);
});

test("transitionClaimedTaskStatus: does not mutate original task", () => {
	const claim = createTaskClaim("worker-1", 300_000, NOW);
	const task = makeTask({ claim, status: "queued" });
	transitionClaimedTaskStatus(task, "worker-1", claim.token, "running", NOW);
	assert.equal(task.status, "queued");
});

/**
 * Table-driven pin for src/runtime/policy-engine.ts branches NOT already
 * covered by test/unit/runtime/core/crew-contracts.test.ts (W-G/G8, V2b).
 *
 * crew-contracts.test.ts already pins: green_unsatisfied block, the
 * all-completed closeout (via a verification-satisfied task), worker_stale
 * being IGNORED for a terminal task with alive:false, and the three graph
 * limits firing together (maxConcurrentWorkers / maxChildrenPerTask /
 * maxTaskDepth).
 *
 * This suite pins the remaining unpinned surface:
 *  - summarizePolicyDecisions (previously 0 test references anywhere);
 *  - maxTasksPerRun (run-level block) and non-finite limits being ignored;
 *  - the task_failed retry-vs-escalate split (retryCount vs maxRetriesPerTask,
 *    default maxRetries=0, error message formatting);
 *  - worker_stale FIRING (positive path) incl. the default 60s window and a
 *    custom heartbeatStaleMs;
 *  - green_unsatisfied only firing for completed tasks (running is exempt);
 *  - closeout prerequisites (empty tasks / partial completion → no closeout);
 *  - the taskDepth parentId cycle guard (seen-set) via maxTaskDepth.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCrewPolicy, summarizePolicyDecisions } from "../../../../src/runtime/policy-engine.ts";
import type { PolicyDecision, TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";

function manifest(): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "team_policy",
		team: "default",
		workflow: "default",
		goal: "Pin policy-engine branches",
		status: "running",
		workspaceMode: "single",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		cwd: process.cwd(),
		stateRoot: process.cwd(),
		artifactsRoot: process.cwd(),
		tasksPath: "tasks.json",
		eventsPath: "events.jsonl",
		artifacts: [],
	};
}

function task(patch: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id: "t1",
		runId: "team_policy",
		role: "executor",
		agent: "executor",
		title: "t1",
		status: "queued",
		dependsOn: [],
		cwd: process.cwd(),
		...patch,
	};
}

function decide(input: {
	tasks: TeamTaskState[];
	limits?: Parameters<typeof evaluateCrewPolicy>[0]["limits"];
	now?: Date;
}): PolicyDecision[] {
	return evaluateCrewPolicy({
		manifest: manifest(),
		tasks: input.tasks,
		...(input.limits ? { limits: input.limits } : {}),
		...(input.now ? { now: input.now } : {}),
	});
}

// ─── summarizePolicyDecisions (previously unpinned) ────────────────

test("summarizePolicyDecisions: line format with and without taskId", () => {
	const rows: ReadonlyArray<[PolicyDecision, string]> = [
		[
			{
				action: "block",
				reason: "limit_exceeded",
				message: "Run has 3 tasks, exceeding maxTasksPerRun=2.",
				taskId: "run",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			"- block (limit_exceeded) run: Run has 3 tasks, exceeding maxTasksPerRun=2.",
		],
		[
			{ action: "retry", reason: "task_failed", message: "Task failed: boom", createdAt: "2026-01-01T00:00:00.000Z" },
			"- retry (task_failed): Task failed: boom",
		],
	];
	for (const [decision, expected] of rows) {
		assert.deepEqual(summarizePolicyDecisions([decision]), [expected]);
	}
});

test("summarizePolicyDecisions: empty-string taskId is falsy — no task segment", () => {
	const decision: PolicyDecision = {
		action: "closeout",
		reason: "run_complete",
		message: "done",
		taskId: "",
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	assert.deepEqual(summarizePolicyDecisions([decision]), ["- closeout (run_complete): done"]);
});

test("summarizePolicyDecisions: empty input → empty output; order preserved", () => {
	assert.deepEqual(summarizePolicyDecisions([]), []);
	const decisions: PolicyDecision[] = [
		{
			action: "escalate",
			reason: "worker_stale",
			message: "Worker heartbeat is stale.",
			taskId: "a",
			createdAt: "2026-01-01T00:00:00.000Z",
		},
		{
			action: "block",
			reason: "green_unsatisfied",
			message: "Green contract unsatisfied.",
			taskId: "b",
			createdAt: "2026-01-01T00:00:00.000Z",
		},
	];
	assert.deepEqual(summarizePolicyDecisions(decisions), [
		"- escalate (worker_stale) a: Worker heartbeat is stale.",
		"- block (green_unsatisfied) b: Green contract unsatisfied.",
	]);
});

test("summarizePolicyDecisions composes with evaluateCrewPolicy output verbatim", () => {
	const decisions = decide({
		tasks: [task({ id: "t1", status: "failed", error: "flaky" })],
		limits: { maxRetriesPerTask: 2 },
	});
	const lines = summarizePolicyDecisions(decisions);
	assert.deepEqual(lines, ["- retry (task_failed) t1: Task failed: flaky"]);
});

// ─── maxTasksPerRun (run-level limit, previously unpinned) ─────────

test("maxTasksPerRun: exceeding the cap blocks at run level (no taskId)", () => {
	const decisions = decide({
		tasks: [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })],
		limits: { maxTasksPerRun: 2 },
	});
	const limitDecisions = decisions.filter((d) => d.reason === "limit_exceeded");
	assert.equal(limitDecisions.length, 1);
	assert.equal(limitDecisions[0]?.action, "block");
	assert.equal(limitDecisions[0]?.taskId, undefined, "run-level decision carries no taskId");
	assert.match(limitDecisions[0]?.message ?? "", /maxTasksPerRun=2/);
});

test("maxTasksPerRun: non-finite caps (Infinity/NaN) are ignored, not treated as 0", () => {
	for (const maxTasksPerRun of [Number.POSITIVE_INFINITY, Number.NaN]) {
		const decisions = decide({ tasks: [task({ id: "a" }), task({ id: "b" })], limits: { maxTasksPerRun } });
		assert.equal(
			decisions.some((d) => d.reason === "limit_exceeded"),
			false,
			`maxTasksPerRun=${maxTasksPerRun} must be ignored`,
		);
	}
});

test("maxConcurrentWorkers: Infinity cap is ignored", () => {
	const decisions = decide({
		tasks: [task({ id: "a", status: "running" }), task({ id: "b", status: "running" })],
		limits: { maxConcurrentWorkers: Number.POSITIVE_INFINITY },
	});
	assert.equal(
		decisions.some((d) => d.reason === "limit_exceeded"),
		false,
	);
});

// ─── task_failed retry/escalate split (previously unpinned) ────────

test("task_failed decision table: retry below budget, escalate at/above budget", () => {
	const rows: ReadonlyArray<[number | undefined, number, string]> = [
		// [retryCount, maxRetriesPerTask, expectedAction]
		[0, 2, "retry"],
		[1, 2, "retry"],
		[2, 2, "escalate"],
		[3, 2, "escalate"],
		[0, 0, "escalate"], // retryCount(0) < maxRetries(0) is false
		[undefined, 2, "retry"], // missing policy.retryCount defaults to 0
	];
	for (const [retryCount, maxRetriesPerTask, expected] of rows) {
		const decisions = decide({
			tasks: [task({ id: "t1", status: "failed", error: "boom", ...(retryCount === undefined ? {} : { policy: { retryCount } }) })],
			limits: { maxRetriesPerTask },
		});
		const failed = decisions.filter((d) => d.reason === "task_failed");
		assert.equal(failed.length, 1, `retryCount=${retryCount}, maxRetries=${maxRetriesPerTask}`);
		assert.equal(failed[0]?.action, expected, `retryCount=${retryCount}, maxRetries=${maxRetriesPerTask} => ${expected}`);
		assert.equal(failed[0]?.taskId, "t1");
	}
});

test("task_failed: default budget is 0 retries → escalate; message table", () => {
	const rows: ReadonlyArray<[string | undefined, string]> = [
		["boom", "Task failed: boom"],
		[undefined, "Task failed."],
	];
	for (const [error, expectedMessage] of rows) {
		const decisions = decide({
			tasks: [task({ id: "t1", status: "failed", ...(error === undefined ? {} : { error }) })],
		});
		assert.equal(decisions[0]?.action, "escalate", "no limits => maxRetries defaults to 0");
		assert.equal(decisions[0]?.message, expectedMessage);
	}
});

// ─── worker_stale positive path (only the negative path was pinned) ──

test("worker_stale: running task with a stale heartbeat escalates on the default 60s window", () => {
	const decisions = decide({
		tasks: [
			task({
				id: "t1",
				status: "running",
				heartbeat: { workerId: "w1", alive: true, lastSeenAt: "2026-01-01T00:00:00.000Z" },
			}),
		],
		now: new Date("2026-01-01T00:02:00.000Z"), // 120s stale > 60s default
	});
	const stale = decisions.filter((d) => d.reason === "worker_stale");
	assert.equal(stale.length, 1);
	assert.equal(stale[0]?.action, "escalate");
	assert.equal(stale[0]?.taskId, "t1");
});

test("worker_stale: queued tasks are also guarded", () => {
	const decisions = decide({
		tasks: [
			task({
				id: "t1",
				status: "queued",
				heartbeat: { workerId: "w1", alive: true, lastSeenAt: "2026-01-01T00:00:00.000Z" },
			}),
		],
		now: new Date("2026-01-01T00:05:00.000Z"),
	});
	assert.equal(
		decisions.some((d) => d.reason === "worker_stale"),
		true,
	);
});

test("worker_stale: custom heartbeatStaleMs widens the window", () => {
	const decisions = decide({
		tasks: [
			task({
				id: "t1",
				status: "running",
				heartbeat: { workerId: "w1", alive: true, lastSeenAt: "2026-01-01T00:00:00.000Z" },
			}),
		],
		limits: { heartbeatStaleMs: 300_000 },
		now: new Date("2026-01-01T00:02:00.000Z"), // 120s stale < 300s window
	});
	assert.equal(decisions.length, 0, "2-minute-old heartbeat is fresh under a 5-minute window");
});

test("worker_stale: waiting tasks are NOT scanned (running/queued only)", () => {
	const decisions = decide({
		tasks: [
			task({
				id: "t1",
				status: "waiting",
				heartbeat: { workerId: "w1", alive: true, lastSeenAt: "2020-01-01T00:00:00.000Z" },
			}),
		],
		now: new Date("2026-01-01T00:00:00.000Z"),
	});
	assert.equal(
		decisions.some((d) => d.reason === "worker_stale"),
		false,
	);
});

// ─── green contract gate only fires for completed tasks ────────────

test("green_unsatisfied: an unsatisfied contract on a RUNNING task raises no decision", () => {
	const decisions = decide({
		tasks: [
			task({
				id: "t1",
				status: "running",
				// Hand-built packet: only `verification` is consulted before the
				// status check; the full TaskPacket shape is pinned in
				// crew-contracts.test.ts / task-packet suites.
				taskPacket: {
					verification: { requiredGreenLevel: "targeted", commands: [], allowManualEvidence: true },
				} as unknown as TeamTaskState["taskPacket"],
				verification: {
					requiredGreenLevel: "targeted",
					observedGreenLevel: "none",
					satisfied: false,
					commands: [],
				},
			}),
		],
	});
	assert.equal(decisions.length, 0, "running task is exempt from the green-contract block");
});

// ─── closeout prerequisites (previously only the positive pinned) ──

test("closeout decision table: prerequisites", () => {
	const rows: ReadonlyArray<[string, TeamTaskState[], number]> = [
		["empty task list → no decisions", [], 0],
		["partial completion → no closeout", [task({ id: "a", status: "completed" }), task({ id: "b", status: "running" })], 0],
		["all completed → exactly one closeout", [task({ id: "a", status: "completed" }), task({ id: "b", status: "completed" })], 1],
	];
	for (const [label, tasks, expectedCount] of rows) {
		const decisions = decide({ tasks });
		assert.equal(decisions.length, expectedCount, label);
		if (expectedCount > 0) {
			assert.equal(decisions[0]?.action, "closeout");
			assert.equal(decisions[0]?.reason, "run_complete");
		}
	}
});

// ─── taskDepth cycle guard (seen-set) via maxTaskDepth ─────────────

test("maxTaskDepth: parentId cycles do not hang and still measure depth", () => {
	const cycA = task({
		id: "a",
		graph: { taskId: "a", parentId: "b", children: [], dependencies: [], queue: "ready" },
	});
	const cycB = task({
		id: "b",
		graph: { taskId: "b", parentId: "a", children: [], dependencies: [], queue: "ready" },
	});
	// a → b → a (cycle): depth must terminate (seen-set) instead of looping.
	const decisions = decide({ tasks: [cycA, cycB], limits: { maxTaskDepth: 1 } });
	const depthDecisions = decisions.filter((d) => d.reason === "limit_exceeded" && d.action === "block");
	// Both tasks sit at depth 2 in the cycle (a→b→a walk terminates after the
	// second hop) — both must be flagged, and the test must simply return.
	assert.equal(depthDecisions.length, 2, "cycle walk terminates and reports both tasks");
	assert.deepEqual(depthDecisions.map((d) => d.taskId).sort(), ["a", "b"]);
});

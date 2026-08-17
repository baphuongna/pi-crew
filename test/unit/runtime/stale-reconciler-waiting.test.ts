import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { applyRecoveryPlan, detectInterruptedRuns } from "../../../src/runtime/recovery/crash-recovery.ts";
import { isIntentionalWait, isPlanApprovalPending, isWaitAnswerPending, reconcileStaleRun } from "../../../src/runtime/stale-reconciler.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import { createTrackedTempDir } from "../../fixtures/test-tempdir.ts";

/**
 * WP-2/R2 (ADR-0 item 9, docs/decisions/2026-08-17-waiting-producer-ask.md):
 * reconciler protection for runs parked in the ask tool.
 *
 * Contract under test:
 * 1. waitState.askedAt fresh (<24h waiting TTL)  → NOT stale-repaired/cancelled
 *    (verdict "waiting_answer"), even with a dead async PID or frozen heartbeats
 *    (a parked worker does not heartbeat while polling the mailbox).
 * 2. waitState.askedAt older than 24h            → protection lapses; the leaked
 *    park marker does NOT shield the run from normal staleness repair (leak guard).
 * 3. Pre-v2 plan-approval protection             → byte-for-byte unchanged.
 *
 * Plus crash-recovery restore audit: task.waiting and manifest.waitState must
 * survive on-disk load/save round-trips; a crash-recovery requeue drops the
 * stale park marker from the reset task while untouched (parked) tasks keep it.
 */

const WAITING_TTL_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
/** PID the existing stale-reconciler suite uses as guaranteed-dead. */
const DEAD_PID = 99999123;
const iso = (ms: number): string => new Date(ms).toISOString();

function makeManifest(overrides?: Partial<TeamRunManifest>): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run-wait-1",
		cwd: "/tmp",
		team: "impl",
		goal: "test",
		status: "running",
		createdAt: iso(NOW - 3_600_000),
		updatedAt: iso(NOW - 3_600_000),
		stateRoot: "/tmp",
		artifactsRoot: "/tmp",
		tasksPath: "/tmp/tasks.json",
		eventsPath: "/tmp/events.jsonl",
		workspaceMode: "single",
		artifacts: [],
		...overrides,
	};
}

function makeWaitingTask(overrides?: Partial<TeamTaskState>): TeamTaskState {
	return {
		id: "task-1",
		runId: "run-wait-1",
		role: "executor",
		agent: "test-agent",
		title: "Parked task",
		status: "waiting",
		dependsOn: [],
		cwd: "/tmp",
		// Park marker set by the broker wait.request handler (WP-2 step 4).
		waiting: {
			questionId: "q-11111111-2222-3333-4444-555555555555",
			askedAt: iso(NOW - 3_600_000),
			deadline: NOW + 600_000,
		},
		...overrides,
	};
}

describe("stale-reconciler: waiting-producer park protection (WP-2/R2)", () => {
	describe("case 1 — waitState.askedAt fresh (<24h): run is an intentional wait", () => {
		it("is not stale-repaired even with a dead async PID (verdict waiting_answer)", () => {
			const tmp = createTrackedTempDir("pi-crew-wait-fresh-");
			const manifest = makeManifest({
				stateRoot: tmp,
				tasksPath: path.join(tmp, "tasks.json"),
				eventsPath: path.join(tmp, "events.jsonl"),
				async: { pid: DEAD_PID, logPath: path.join(tmp, "log"), spawnedAt: iso(NOW - 3_600_000) },
				waitState: {
					taskId: "task-1",
					questionId: "q-11111111-2222-3333-4444-555555555555",
					askedAt: iso(NOW - 3_600_000),
				},
			});
			const result = reconcileStaleRun(manifest, [makeWaitingTask()], NOW);
			assert.equal(result.verdict, "waiting_answer");
			assert.equal(result.repaired, false);
			assert.equal(result.repairedTasks, undefined);
		});

		it("is not stale-repaired with no PID and heartbeats frozen while parked", () => {
			// Realistic parked shape: the ask poll loop does not beat worker
			// heartbeats, so all running/waiting heartbeats go stale (>5min) —
			// without the run-level guard this is exactly no_pid_heartbeat_stale.
			const tmp = createTrackedTempDir("pi-crew-wait-frozen-");
			const manifest = makeManifest({
				stateRoot: tmp,
				tasksPath: path.join(tmp, "tasks.json"),
				eventsPath: path.join(tmp, "events.jsonl"),
				updatedAt: iso(NOW - 1_800_000),
				waitState: {
					taskId: "task-1",
					questionId: "q-11111111-2222-3333-4444-555555555555",
					askedAt: iso(NOW - 1_800_000),
				},
			});
			const task = makeWaitingTask({
				heartbeat: { workerId: "task-1", lastSeenAt: iso(NOW - 1_800_000), alive: true },
			});
			const result = reconcileStaleRun(manifest, [task], NOW);
			assert.equal(result.verdict, "waiting_answer");
			assert.equal(result.repaired, false);
			assert.equal(result.repairedTasks, undefined);
			// Same manifest predicates agree.
			assert.equal(isWaitAnswerPending(manifest, NOW), true);
			assert.equal(isIntentionalWait(manifest, NOW), true);
		});

		it("boundary: askedAt exactly at the 24h TTL still counts as pending (fail-safe)", () => {
			const manifest = makeManifest({
				waitState: { taskId: "task-1", questionId: "q-1", askedAt: iso(NOW - WAITING_TTL_MS) },
			});
			assert.equal(isWaitAnswerPending(manifest, NOW), true);
			assert.equal(reconcileStaleRun(manifest, [makeWaitingTask()], NOW).verdict, "waiting_answer");
		});

		it("predicate edge cases: missing/garbage waitState is never an intentional wait", () => {
			assert.equal(isWaitAnswerPending(makeManifest(), NOW), false);
			assert.equal(
				isWaitAnswerPending(makeManifest({ waitState: { taskId: "t", questionId: "q", askedAt: "not-a-date" } }), NOW),
				false,
			);
			// No waitState → isIntentionalWait falls back to plan-approval only.
			assert.equal(isIntentionalWait(makeManifest(), NOW), false);
		});
	});

	describe("case 2 — waitState.askedAt older than 24h: leak guard repairs", () => {
		it("dead PID run with TTL-expired waitState is repaired/cancelled", () => {
			const tmp = createTrackedTempDir("pi-crew-wait-ttl-");
			const manifest = makeManifest({
				stateRoot: tmp,
				tasksPath: path.join(tmp, "tasks.json"),
				eventsPath: path.join(tmp, "events.jsonl"),
				async: { pid: DEAD_PID, logPath: path.join(tmp, "log"), spawnedAt: iso(NOW - 90_000_000) },
				waitState: {
					taskId: "task-1",
					questionId: "q-11111111-2222-3333-4444-555555555555",
					askedAt: iso(NOW - 25 * 3_600_000),
				},
			});
			const task = makeWaitingTask({
				waiting: {
					questionId: "q-11111111-2222-3333-4444-555555555555",
					askedAt: iso(NOW - 25 * 3_600_000),
					deadline: NOW - 24 * 3_600_000,
				},
			});
			assert.equal(isWaitAnswerPending(manifest, NOW), false);
			const result = reconcileStaleRun(manifest, [task], NOW);
			assert.equal(result.verdict, "pid_dead");
			assert.equal(result.repaired, true);
			assert.equal(result.repairedTasks?.[0]?.status, "cancelled");
		});

		it("no-PID run with frozen heartbeats and TTL-expired waitState is repaired (realistic leak)", () => {
			const tmp = createTrackedTempDir("pi-crew-wait-leak-");
			const manifest = makeManifest({
				stateRoot: tmp,
				tasksPath: path.join(tmp, "tasks.json"),
				eventsPath: path.join(tmp, "events.jsonl"),
				updatedAt: iso(NOW - 25 * 3_600_000),
				waitState: {
					taskId: "task-1",
					questionId: "q-11111111-2222-3333-4444-555555555555",
					askedAt: iso(NOW - 25 * 3_600_000),
				},
			});
			const task = makeWaitingTask({
				waiting: {
					questionId: "q-11111111-2222-3333-4444-555555555555",
					askedAt: iso(NOW - 25 * 3_600_000),
					deadline: NOW - 24 * 3_600_000,
				},
				heartbeat: { workerId: "task-1", lastSeenAt: iso(NOW - 25 * 3_600_000), alive: true },
			});
			const result = reconcileStaleRun(manifest, [task], NOW);
			assert.equal(result.verdict, "no_status");
			assert.equal(result.repaired, true);
			assert.equal(result.repairedTasks?.[0]?.status, "cancelled");
		});
	});

	describe("case 3 — pre-v2 planApproval protection unchanged (regression pin)", () => {
		const planApprovalManifest = makeManifest({
			status: "blocked",
			async: { pid: DEAD_PID, logPath: "/tmp/log", spawnedAt: iso(NOW) },
			planApproval: {
				required: true,
				status: "pending",
				requestedAt: iso(NOW),
				updatedAt: iso(NOW),
				planTaskId: "01_plan",
			},
		});

		it("blocked+required+pending run with dead PID is still preserved", () => {
			const task = makeWaitingTask({ status: "running", waiting: undefined });
			const result = reconcileStaleRun(planApprovalManifest, [task], NOW);
			assert.equal(result.verdict, "blocked_awaiting_approval");
			assert.equal(result.repaired, false);
			assert.equal(result.repairedTasks, undefined);
			assert.equal(isPlanApprovalPending(planApprovalManifest), true);
			// Generalized predicate still covers the pre-v2 case.
			assert.equal(isIntentionalWait(planApprovalManifest, NOW), true);
		});

		it("isPlanApprovalPending narrow-guard semantics unchanged", () => {
			assert.equal(isPlanApprovalPending({ ...planApprovalManifest, status: "running" }), false);
			assert.equal(
				isPlanApprovalPending({
					...planApprovalManifest,
					planApproval: { ...planApprovalManifest.planApproval!, required: false },
				}),
				false,
			);
			assert.equal(
				isPlanApprovalPending({
					...planApprovalManifest,
					planApproval: { ...planApprovalManifest.planApproval!, status: "approved" },
				}),
				false,
			);
			assert.equal(isPlanApprovalPending(makeManifest()), false);
		});

		it("no over-preservation: plain running run with dead PID and no waitState still repairs", () => {
			const tmp = createTrackedTempDir("pi-crew-wait-plain-");
			const manifest = makeManifest({
				stateRoot: tmp,
				tasksPath: path.join(tmp, "tasks.json"),
				eventsPath: path.join(tmp, "events.jsonl"),
				async: { pid: DEAD_PID, logPath: path.join(tmp, "log"), spawnedAt: iso(NOW) },
			});
			const result = reconcileStaleRun(manifest, [makeWaitingTask({ status: "running", waiting: undefined })], NOW);
			assert.equal(result.verdict, "pid_dead");
			assert.equal(result.repaired, true);
			assert.equal(result.repairedTasks?.[0]?.status, "cancelled");
		});
	});
});

describe("crash-recovery: waiting/waitState survive restore (WP-2/R2 audit)", () => {
	/** Build a real run on disk exactly where loadRunManifestById resolves it. */
	function buildOnDiskRun(cwd: string, runId: string, manifest: TeamRunManifest, tasks: TeamTaskState[]): TeamRunManifest {
		const stateRoot = path.join(cwd, ".crew", "state", "runs", runId);
		fs.mkdirSync(stateRoot, { recursive: true });
		const onDisk: TeamRunManifest = {
			...manifest,
			runId,
			cwd,
			stateRoot,
			artifactsRoot: path.join(cwd, ".crew", "artifacts", runId),
			tasksPath: path.join(stateRoot, "tasks.json"),
			eventsPath: path.join(stateRoot, "events.jsonl"),
		};
		saveRunManifest(onDisk);
		saveRunTasks(
			onDisk,
			tasks.map((t) => ({ ...t, runId })),
		);
		return onDisk;
	}

	it("task.waiting and manifest.waitState survive the save→load round-trip", () => {
		const tmp = createTrackedTempDir("pi-crew-wait-rt-");
		const waitState = { taskId: "task-1", questionId: "q-roundtrip", askedAt: iso(NOW - 60_000) };
		const waiting = { questionId: "q-roundtrip", askedAt: iso(NOW - 60_000), deadline: NOW + 600_000, options: ["yes", "no"] };
		buildOnDiskRun(tmp, "run-wait-rt", makeManifest({ waitState }), [makeWaitingTask({ waiting })]);
		const loaded = loadRunManifestById(tmp, "run-wait-rt");
		assert.ok(loaded, "run must resolve from disk");
		// No sanitize/clone helper in the restore path may drop the new fields.
		assert.deepEqual(loaded.manifest.waitState, waitState);
		assert.deepEqual(loaded.tasks[0]?.waiting, waiting);
	});

	it("applyRecoveryPlan: parked task untouched, requeued task loses the stale marker", async () => {
		const tmp = createTrackedTempDir("pi-crew-wait-rec-");
		const waitState = { taskId: "task-parked", questionId: "q-recovery", askedAt: iso(NOW - 3_600_000) };
		const parkedWaiting = { questionId: "q-recovery", askedAt: iso(NOW - 3_600_000), deadline: NOW + 600_000 };
		// task-stale carries a marker while status is "running" — the corrupted /
		// mid-flip state the defensive reset must not resurrect on requeue.
		const staleWaiting = { questionId: "q-recovery-old", askedAt: iso(NOW - 7_200_000), deadline: NOW - 60_000 };
		const taskStale: TeamTaskState = {
			id: "task-stale",
			runId: "run-wait-rec",
			role: "executor",
			agent: "test-agent",
			title: "Crashed running task",
			status: "running",
			dependsOn: [],
			cwd: tmp,
			waiting: staleWaiting,
		};
		const taskParked = makeWaitingTask({ id: "task-parked", waiting: parkedWaiting });
		const manifest = buildOnDiskRun(tmp, "run-wait-rec", makeManifest({ waitState }), [taskStale, taskParked]);

		// Crash detection: only the crashed RUNNING task is resumable; the parked
		// WAITING task must not be scheduled for a reset.
		const cache = { list: () => [manifest], get: () => manifest } as unknown as Parameters<typeof detectInterruptedRuns>[1];
		const plans = detectInterruptedRuns(tmp, cache, 300_000, "session-live");
		assert.equal(plans.length, 1);
		assert.deepEqual(plans[0]?.resumableTasks, ["task-stale"]);

		await applyRecoveryPlan(plans[0], { cwd: tmp });

		const reloaded = loadRunManifestById(tmp, "run-wait-rec");
		assert.ok(reloaded);
		const byId = new Map(reloaded.tasks.map((t) => [t.id, t]));
		// Requeued task: fresh dispatch state, stale park marker dropped.
		assert.equal(byId.get("task-stale")?.status, "queued");
		assert.equal(byId.get("task-stale")?.waiting, undefined);
		// Parked task: untouched — still waiting, marker intact.
		assert.equal(byId.get("task-parked")?.status, "waiting");
		assert.deepEqual(byId.get("task-parked")?.waiting, parkedWaiting);
		// Manifest-level park pointer survives the recovery write path.
		assert.deepEqual(reloaded.manifest.waitState, waitState);
	});
});

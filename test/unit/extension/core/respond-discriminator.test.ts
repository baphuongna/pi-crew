import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { sweepExpiredWaitingTasks } from "../../../../src/runtime/dispatch-batch.ts";
import type { WorkerHeartbeatState } from "../../../../src/runtime/heartbeat/worker-heartbeat.ts";
import { clearLiveAgentsForTest, registerLiveAgent } from "../../../../src/runtime/live-session/live-agent-manager.ts";
import { readMailbox } from "../../../../src/state/coordination/mailbox.ts";
import { loadRunManifestById, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import { sleepSync } from "../../../../src/utils/sleep.ts";

/**
 * WP-2/R2 STEP 6 + STEP 8 — respond liveness discriminator + scheduler
 * deadline owner (ADR-0 docs/decisions/2026-08-17-waiting-producer-ask.md
 * items 8 and 10).
 *
 * Fixtures modeled on resume-cancel.test.ts: a scaffold run is created in a
 * temp cwd, then a completed task is parked into `status:"waiting"` with a
 * `task.waiting` marker so the discriminator branches can be exercised
 * deterministically (fresh/stale heartbeat, live handle presence).
 */

interface ParkedFixture {
	cwd: string;
	runId: string;
	taskId: string;
	questionId: string;
}

function heartbeatAt(taskId: string, ageMs: number, alive = true): WorkerHeartbeatState {
	// ageMs may be NEGATIVE (future timestamp): fixture setup (scaffold run
	// completion) can take >60s under suite load, which would age a now-fresh
	// heartbeat past the gradient stale window before respond executes.
	// Negative ages pin the heartbeat into the future => classify "healthy"
	// regardless of fixture slowness (duration_ms ~127s observed in-suite).
	return { workerId: taskId, lastSeenAt: new Date(Date.now() - ageMs).toISOString(), alive };
}

/** Create a scaffold run, wait for completion, then park its first task. */
async function createParkedRun(heartbeat: WorkerHeartbeatState, deadlineOffsetMs: number): Promise<ParkedFixture> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-respond-disc-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{
			action: "run",
			config: { runtime: { mode: "scaffold" } },
			team: "fast-fix",
			goal: "Discriminator fixture",
		},
		{ cwd },
	);
	const runId = run.details.runId;
	assert.ok(runId, "scaffold run must produce a runId");
	const loaded = loadRunManifestById(cwd, runId!);
	assert.ok(loaded, "run manifest must load");
	const task = loaded!.tasks[0]!;
	assert.ok(task, "run must have at least one task");
	const questionId = randomUUID();
	const parked: TeamTaskState = {
		...task,
		status: "waiting",
		heartbeat,
		waiting: {
			questionId,
			askedAt: new Date().toISOString(),
			deadline: Date.now() + deadlineOffsetMs,
		},
	};
	saveRunTasks(
		loaded!.manifest,
		loaded!.tasks.map((t) => (t.id === task.id ? parked : t)),
	);
	return { cwd, runId: runId!, taskId: task.id, questionId };
}

/** Remove temp dir with the macOS-CI ENOTEMPTY retry (resume-cancel pattern). */
function teardown(cwd: string): void {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
				console.error(`respond-discriminator teardown: unable to remove ${cwd}: ${String(error)}`);
				break;
			}
			sleepSync(200);
		}
	}
}

/** Poll events.jsonl until it contains the expected text (fire-and-forget events). */
async function waitForEvent(cwd: string, runId: string, needle: string, timeoutMs = 5000): Promise<boolean> {
	const loaded = loadRunManifestById(cwd, runId)!;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const text = fs.existsSync(loaded.manifest.eventsPath) ? fs.readFileSync(loaded.manifest.eventsPath, "utf-8") : "";
		if (text.includes(needle)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

test("respond discriminator: alive (fresh heartbeat) → mailbox response with questionId, task stays waiting", async () => {
	clearLiveAgentsForTest();
	const fixture = await createParkedRun(heartbeatAt("t", -60_000), 60_000);
	try {
		const responded = await handleTeamTool(
			{ action: "respond", runId: fixture.runId, taskId: fixture.taskId, message: "ship it" },
			{ cwd: fixture.cwd },
		);
		assert.equal(responded.isError, false, textFromToolResult(responded));

		const loaded = loadRunManifestById(fixture.cwd, fixture.runId)!;
		const task = loaded.tasks.find((t) => t.id === fixture.taskId)!;
		// ALIVE: the park stays — the parked ask tool flips waiting→running via
		// its terminal report, NOT root-side respond.
		assert.equal(task.status, "waiting");
		assert.equal(task.waiting?.questionId, fixture.questionId);

		// Mailbox response carries the questionId, from leader, to the task.
		const responses = readMailbox(loaded.manifest, "inbox", fixture.taskId, "response");
		assert.equal(responses.length, 1);
		assert.equal(responses[0]!.questionId, fixture.questionId);
		assert.equal(responses[0]!.from, "leader");
		assert.equal(responses[0]!.to, fixture.taskId);
		assert.equal(responses[0]!.body, "ship it");

		assert.ok(await waitForEvent(fixture.cwd, fixture.runId, '"ask.answered"'));
	} finally {
		teardown(fixture.cwd);
	}
});

test("respond discriminator: alive via live in-memory handle despite stale heartbeat", async () => {
	clearLiveAgentsForTest();
	const fixture = await createParkedRun(heartbeatAt("t", 10 * 60_000, false), 60_000); // stale+dead heartbeat: alive via live handle only
	registerLiveAgent({
		agentId: `test-${fixture.taskId}`,
		taskId: fixture.taskId,
		runId: fixture.runId,
		workspaceId: "test-workspace",
		session: {},
		status: "running",
	});
	try {
		const responded = await handleTeamTool(
			{ action: "respond", runId: fixture.runId, taskId: fixture.taskId, message: "handle keeps it alive" },
			{ cwd: fixture.cwd },
		);
		assert.equal(responded.isError, false, textFromToolResult(responded));
		const loaded = loadRunManifestById(fixture.cwd, fixture.runId)!;
		const task = loaded.tasks.find((t) => t.id === fixture.taskId)!;
		assert.equal(task.status, "waiting", "live handle ⇒ ALIVE ⇒ park stays");
		const responses = readMailbox(loaded.manifest, "inbox", fixture.taskId, "response");
		assert.equal(responses.length, 1);
		assert.equal(responses[0]!.questionId, fixture.questionId);
	} finally {
		clearLiveAgentsForTest();
		teardown(fixture.cwd);
	}
});

test("respond discriminator: dead → requeued + fenced answer injected, no mailbox response", async () => {
	clearLiveAgentsForTest();
	const fixture = await createParkedRun(heartbeatAt("t", 10 * 60_000, false), 60_000); // stale+dead heartbeat: alive via live handle only
	try {
		const responded = await handleTeamTool(
			{ action: "respond", runId: fixture.runId, taskId: fixture.taskId, message: "the answer is 42" },
			{ cwd: fixture.cwd },
		);
		assert.equal(responded.isError, false, textFromToolResult(responded));

		const loaded = loadRunManifestById(fixture.cwd, fixture.runId)!;
		const task = loaded.tasks.find((t) => t.id === fixture.taskId)!;
		// DEAD: requeued, park cleared, answer injected on the cross-attempt channel.
		assert.equal(task.status, "queued");
		assert.equal(task.waiting, undefined);
		assert.equal(task.adaptive?.phase, "resumed");
		const injected = task.pendingSteers ?? [];
		assert.equal(injected.length, 1);
		assert.ok(injected[0]!.includes("<dependency-context>"), "injected answer must be fenced as untrusted");
		assert.ok(injected[0]!.includes(`questionId=${fixture.questionId}`));
		assert.ok(injected[0]!.includes("the answer is 42"));

		// Exactly-one-dispatch: NO questionId-tagged mailbox response on the dead path.
		const responses = readMailbox(loaded.manifest, "inbox", fixture.taskId, "response").filter(
			(m) => m.questionId === fixture.questionId,
		);
		assert.equal(responses.length, 0);

		// Terminal run flipped back to running so the scheduler re-dispatches.
		assert.equal(loaded.manifest.status, "running");

		assert.ok(await waitForEvent(fixture.cwd, fixture.runId, '"ask.answered"'));
		assert.ok(await waitForEvent(fixture.cwd, fixture.runId, '"task.resumed"'));
	} finally {
		teardown(fixture.cwd);
	}
});

test("respond discriminator: exactly-once — second respond for the same questionId is a no-op", async () => {
	clearLiveAgentsForTest();
	const fixture = await createParkedRun(heartbeatAt("t", -60_000), 60_000);
	try {
		const first = await handleTeamTool(
			{ action: "respond", runId: fixture.runId, taskId: fixture.taskId, message: "once" },
			{ cwd: fixture.cwd },
		);
		assert.equal(first.isError, false, textFromToolResult(first));
		const second = await handleTeamTool(
			{ action: "respond", runId: fixture.runId, taskId: fixture.taskId, message: "twice" },
			{ cwd: fixture.cwd },
		);
		assert.equal(second.isError, false, textFromToolResult(second));

		const loaded = loadRunManifestById(fixture.cwd, fixture.runId)!;
		const task = loaded.tasks.find((t) => t.id === fixture.taskId)!;
		// Still parked, still exactly one mailbox response — never both paths.
		assert.equal(task.status, "waiting");
		const responses = readMailbox(loaded.manifest, "inbox", fixture.taskId, "response");
		assert.equal(responses.length, 1, "second respond must not append another response");
		assert.equal(responses[0]!.body, "once");
		const noopIds = (second.details.data as { noopIds?: string[] } | undefined)?.noopIds;
		assert.deepEqual(noopIds, [fixture.taskId], "second respond reports a no-op for the questionId");
	} finally {
		teardown(fixture.cwd);
	}
});

test("scheduler deadline owner: expired deadline + dead worker → requeue + ask.timedout event", async () => {
	clearLiveAgentsForTest();
	// Deadline already expired (offset −1s) and the heartbeat is long dead.
	const fixture = await createParkedRun(heartbeatAt("t", 10 * 60_000, false), -1_000);
	try {
		const sweep = await sweepExpiredWaitingTasks(fixture.cwd, fixture.runId);
		assert.ok(sweep, "expired waiting park must produce a sweep result");
		assert.deepEqual(sweep.requeuedTaskIds, [fixture.taskId]);
		assert.deepEqual(sweep.timedOutQuestionIds, [fixture.questionId]);

		const loaded = loadRunManifestById(fixture.cwd, fixture.runId)!;
		const task = loaded.tasks.find((t) => t.id === fixture.taskId)!;
		assert.equal(task.status, "queued");
		assert.equal(task.waiting, undefined);
		const injected = task.pendingSteers ?? [];
		assert.equal(injected.length, 1);
		assert.ok(injected[0]!.includes("[ask timed out]"));
		assert.ok(injected[0]!.includes(`questionId=${fixture.questionId}`));
		assert.ok(injected[0]!.includes("<dependency-context>"));

		// Events are awaited by the sweep — durable immediately.
		const eventsText = fs.readFileSync(loaded.manifest.eventsPath, "utf-8");
		assert.ok(eventsText.includes('"ask.timedout"'));
		assert.ok(eventsText.includes(fixture.questionId));

		// Exactly-once: a second sweep is a no-op (task requeued, guard armed).
		const again = await sweepExpiredWaitingTasks(fixture.cwd, fixture.runId);
		assert.equal(again, undefined);
	} finally {
		teardown(fixture.cwd);
	}
});

test("scheduler deadline owner: expired deadline + alive worker → task stays waiting, event only", async () => {
	clearLiveAgentsForTest();
	const fixture = await createParkedRun(heartbeatAt("t", 0), -1_000);
	try {
		const sweep = await sweepExpiredWaitingTasks(fixture.cwd, fixture.runId);
		assert.ok(sweep, "expired waiting park must produce a sweep result");
		assert.deepEqual(sweep.requeuedTaskIds, [], "alive worker ⇒ no root-side requeue (in-tool timeout surfaces it)");
		assert.deepEqual(sweep.timedOutQuestionIds, [fixture.questionId]);

		const loaded = loadRunManifestById(fixture.cwd, fixture.runId)!;
		const task = loaded.tasks.find((t) => t.id === fixture.taskId)!;
		assert.equal(task.status, "waiting", "alive park must be left in place");
		assert.equal(task.waiting?.questionId, fixture.questionId);
		assert.equal(task.pendingSteers, undefined);

		const eventsText = fs.readFileSync(loaded.manifest.eventsPath, "utf-8");
		assert.ok(eventsText.includes('"ask.timedout"'));
		assert.ok(eventsText.includes('"workerAlive":true'));
	} finally {
		teardown(fixture.cwd);
	}
});

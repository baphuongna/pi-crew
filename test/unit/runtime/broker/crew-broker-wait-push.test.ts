/**
 * crew-broker-wait-push.test.ts — Unit tests for the F1 waiting-push helper
 * (src/runtime/broker/wait-push.ts).
 *
 * F1 (2026-09-12 live battery, team_20260912014448): when a worker parks on
 * ask, the broker MUST release the sync foreground waiter with the parked
 * question — otherwise the only entity that can answer stays suspended until
 * the response watchdog kills the worker. Contract:
 *  - a registered foreground waiter for a loadable run is resolved with the
 *    exact `waiting` payload (taskId, questionId, question, deadline, options);
 *  - options are omitted from the payload when not supplied;
 *  - with no loadable run the push is a silent no-op (async/detached runs
 *    poll) and NEVER throws — a failure here must not fail the park itself.
 *
 * Best-effort by design: verified through the real run-tracker promise map
 * against a real scaffold run.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { pushWaitingToForegroundWaiter } from "../../../../src/runtime/broker/wait-push.ts";
import { registerRunPromise, rejectRunPromise } from "../../../../src/runtime/run-tracker.ts";
import { loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import { teardownCwd } from "../../../fixtures/teardown-cwd.ts";

async function scaffoldRun(prefix: string): Promise<{ cwd: string; runId: string; taskId: string }> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "wait-push" },
		{ cwd },
	);
	const runId = run.details.runId as string;
	const loaded = loadRunManifestById(cwd, runId)!;
	return { cwd, runId, taskId: loaded.tasks[0]!.id };
}

/** Race the waiter promise against a timer: "resolved" or "pending". */
async function waiterState(entry: { promise: Promise<unknown> }, ms = 150): Promise<"resolved" | "pending"> {
	return (await Promise.race([
		entry.promise.then(() => "resolved" as const),
		new Promise<"pending">((r) => setTimeout(() => r("pending"), ms)),
	])) as "resolved" | "pending";
}

test("wait-push: resolves the registered foreground waiter with the parked question", async () => {
	const fx = await scaffoldRun("pi-crew-wp-resolve-");
	const entry = registerRunPromise(fx.runId);
	try {
		await pushWaitingToForegroundWaiter({
			cwd: fx.cwd,
			runId: fx.runId,
			taskId: fx.taskId,
			questionId: "q-1",
			question: "Continue with the risky deploy?",
			deadline: 1770000000000,
			options: ["yes", "no"],
		});
		const result = (await entry.promise) as { waiting?: Record<string, unknown> };
		assert.ok(result.waiting, "waiter released with a waiting payload");
		assert.equal(result.waiting?.taskId, fx.taskId);
		assert.equal(result.waiting?.questionId, "q-1");
		assert.equal(result.waiting?.question, "Continue with the risky deploy?");
		assert.equal(result.waiting?.deadline, 1770000000000);
		assert.deepEqual(result.waiting?.options, ["yes", "no"]);
	} finally {
		rejectRunPromise(fx.runId, new Error("test cleanup"));
		teardownCwd(fx.cwd);
	}
});

test("wait-push: options omitted → payload carries no options key", async () => {
	const fx = await scaffoldRun("pi-crew-wp-noopts-");
	const entry = registerRunPromise(fx.runId);
	try {
		await pushWaitingToForegroundWaiter({
			cwd: fx.cwd,
			runId: fx.runId,
			taskId: fx.taskId,
			questionId: "q-2",
			question: "Proceed?",
			deadline: 1770000000001,
		});
		const result = (await entry.promise) as { waiting?: { options?: string[] } };
		assert.equal(result.waiting?.options, undefined, "no options key when none supplied");
	} finally {
		rejectRunPromise(fx.runId, new Error("test cleanup"));
		teardownCwd(fx.cwd);
	}
});

test("wait-push: unloadable run → no-op, waiter stays parked, never throws", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wp-ghost-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const entry = registerRunPromise("ghost-run-for-wait-push");
	try {
		await assert.doesNotReject(
			pushWaitingToForegroundWaiter({
				cwd,
				runId: "ghost-run-for-wait-push",
				taskId: "task-x",
				questionId: "q-3",
				question: "anyone?",
				deadline: 0,
			}),
		);
		assert.equal(await waiterState(entry), "pending", "no manifest → no resolution (async/detached runs poll)");
	} finally {
		rejectRunPromise("ghost-run-for-wait-push", new Error("test cleanup"));
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("wait-push: a second push after the waiter was released is a no-op", async () => {
	const fx = await scaffoldRun("pi-crew-wp-second-");
	const first = registerRunPromise(fx.runId);
	try {
		await pushWaitingToForegroundWaiter({
			cwd: fx.cwd,
			runId: fx.runId,
			taskId: fx.taskId,
			questionId: "q-4",
			question: "first",
			deadline: 1,
		});
		await first.promise;
		// resolveRunPromise deleted the entry: a late duplicate push must not
		// throw and must not resurrect anything.
		await assert.doesNotReject(
			pushWaitingToForegroundWaiter({
				cwd: fx.cwd,
				runId: fx.runId,
				taskId: fx.taskId,
				questionId: "q-4",
				question: "duplicate",
				deadline: 2,
			}),
		);
	} finally {
		rejectRunPromise(fx.runId, new Error("test cleanup"));
		teardownCwd(fx.cwd);
	}
});

/**
 * ASK-PARK CLOBBER FIX (2026-10-31) — respond defense-in-depth self-heal.
 *
 * Fix 1 (atomic-write flush-time CAS) closes the root cause, but a tasks.json
 * park lost to the cross-process coalesce race before that fix (or through the
 * documented coarse-mtime residual window) must still be answerable: the
 * broker's manifest.waitState pointer survives (manifest.json is never
 * coalesced), so when it is still live while tasks.json shows the parked task
 * `running` with no/foreign waiting marker, handleRespond restores the park
 * from waitState inside the same run-lock section, emits
 * `task.waiting_repaired`, and runs the normal answer machinery verbatim.
 *
 * Fixture shape = the incident's post-clobber state: task `running`, no
 * waiting marker, manifest.waitState live with the original questionId.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleRespond } from "../../../../src/extension/team-tool/respond.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { clearLiveAgentsForTest } from "../../../../src/runtime/live-session/live-agent-manager.ts";
import { readMailbox } from "../../../../src/state/coordination/mailbox.ts";
import type { TeamEvent } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

interface ClobberFixture {
	cwd: string;
	runId: string;
	tasksPath: string;
	eventsPath: string;
}

function createClobberedRun(
	waitState: { taskId: string; questionId: string; askedAt: string; deadline: number } | undefined,
): ClobberFixture {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-respond-clobber-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "clobber",
		description: "",
		roles: [{ name: "worker", agent: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "wf",
		description: "",
		steps: [{ id: "one", role: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "clobbered park" });
	// Post-clobber incident state: the parked task reads `running` with NO
	// waiting marker (the host's coalesced flush clobbered the broker park),
	// while the manifest still points at the live question.
	const clobbered: TeamTaskState = {
		id: "asker",
		runId: created.manifest.runId,
		role: "worker",
		agent: "worker",
		title: "asker",
		status: "running",
		dependsOn: [],
		cwd,
		heartbeat: { workerId: "asker", lastSeenAt: new Date(Date.now() + 60_000).toISOString(), alive: true },
	};
	saveRunTasks(created.manifest, [clobbered]);
	if (waitState) {
		saveRunManifest({ ...created.manifest, waitState, updatedAt: new Date().toISOString() });
	}
	return {
		cwd,
		runId: created.manifest.runId,
		tasksPath: created.manifest.tasksPath,
		eventsPath: created.manifest.eventsPath,
	};
}

/** Poll events.jsonl until it contains the expected text (fire-and-forget events). */
async function waitForEvent(eventsPath: string, needle: string, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const text = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "";
		if (text.includes(needle)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

/** Parse events.jsonl and return only the entries of `type`. */
function readEventsOfType(eventsPath: string, type: string): TeamEvent[] {
	if (!fs.existsSync(eventsPath)) return [];
	return fs
		.readFileSync(eventsPath, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as TeamEvent)
		.filter((event) => event.type === type);
}

test("clobbered park: live waitState + running task → respond repairs waiting and answers via mailbox", async (t) => {
	clearLiveAgentsForTest();
	const questionId = "q-clobber-1";
	const run = createClobberedRun({
		taskId: "asker",
		questionId,
		askedAt: new Date().toISOString(),
		deadline: Date.now() + 60_000,
	});
	t.after(async () => {
		await removeDirWithRetry(run.cwd);
	});

	const out = handleRespond({ action: "respond", runId: run.runId, taskId: "asker", message: "proceed with option A" }, { cwd: run.cwd });
	assert.equal(out.isError, false, `respond must succeed on a repaired park: ${textFromToolResult(out)}`);

	// Repair persisted: waiting + marker restored from waitState (the ALIVE
	// answer path leaves the park in place — the parked tool's terminal report
	// flips it back to running, exactly like an unclobbered park).
	const loaded = loadRunManifestById(run.cwd, run.runId);
	const task = loaded?.tasks.find((tk) => tk.id === "asker");
	assert.equal(task?.status, "waiting", "tasks.json repaired to waiting");
	assert.equal(task?.waiting?.questionId, questionId, "questionId marker restored from waitState");

	// Answer delivered through the mailbox on the waitState questionId.
	const responses = readMailbox(loaded!.manifest, "inbox", "asker").filter((m) => m.kind === "response");
	assert.equal(responses.length, 1, "one questionId-tagged mailbox response");
	assert.equal(responses[0]?.questionId, questionId);
	assert.equal(responses[0]?.body, "proceed with option A");

	// Self-heal trace event.
	assert.ok(await waitForEvent(run.eventsPath, "task.waiting_repaired"), "task.waiting_repaired event must land");
	const repairedEvents = readEventsOfType(run.eventsPath, "task.waiting_repaired");
	assert.equal(repairedEvents.length, 1);
	assert.equal(repairedEvents[0]?.taskId, "asker");
	assert.equal(repairedEvents[0]?.data?.questionId, questionId);
	assert.equal(repairedEvents[0]?.data?.reason, "coalesce-clobber");
});

test("negative: expired waitState deadline → repair refused, hint reject as before", async (t) => {
	clearLiveAgentsForTest();
	const run = createClobberedRun({
		taskId: "asker",
		questionId: "q-expired",
		askedAt: new Date(Date.now() - 120_000).toISOString(),
		deadline: Date.now() - 1_000,
	});
	t.after(async () => {
		await removeDirWithRetry(run.cwd);
	});

	const out = handleRespond({ action: "respond", runId: run.runId, taskId: "asker", message: "too late" }, { cwd: run.cwd });
	assert.equal(out.isError, true);
	assert.match(textFromToolResult(out), /is running, not waiting/);

	// No repair, no mailbox write.
	const loaded = loadRunManifestById(run.cwd, run.runId);
	assert.equal(loaded?.tasks.find((tk) => tk.id === "asker")?.status, "running", "task untouched");
	assert.equal(
		fs.existsSync(path.join(run.cwd, ".crew", "state", "runs", run.runId, "mailbox", "tasks", "asker", "inbox.jsonl")),
		false,
		"no mailbox response for an expired park",
	);
});

test("negative: no waitState at all → reject unchanged (real non-waiting task)", async (t) => {
	clearLiveAgentsForTest();
	const run = createClobberedRun(undefined);
	t.after(async () => {
		await removeDirWithRetry(run.cwd);
	});

	const out = handleRespond({ action: "respond", runId: run.runId, taskId: "asker", message: "hello" }, { cwd: run.cwd });
	assert.equal(out.isError, true);
	assert.match(textFromToolResult(out), /is running, not waiting/);
	const loaded = loadRunManifestById(run.cwd, run.runId);
	assert.equal(loaded?.tasks.find((tk) => tk.id === "asker")?.status, "running");
});

/**
 * Regression tests for the W9-R1 residual wave (SEC-2026-11):
 * read_only role gates on the MUTATING api group handlers left deferred by
 * w1b-binding (its Deferred item 4) — write-heartbeat, the live-agent control
 * cluster in agent-control.ts (steer/follow-up/stop/resume/interrupt — the
 * interrupt-agent op is the "foreground-interrupt" class named there),
 * mailbox send-message / ack-message / validate-mailbox(repair=true) — plus
 * PIN tests proving the pre-existing plan-approval gate (canApprovePlan)
 * still refuses read_only roles.
 *
 * Pattern mirrors test/unit/extension/core/api-claim-caller-binding.test.ts:
 * the handlers read caller identity from process.env at call time, so each
 * assertion body runs under a scoped PI_CREW_* env. Pure reads stay open
 * (read-mailbox, read-delivery, validate-mailbox without repair,
 * list-live-agents) — that half is pinned too.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { handleListLiveAgents, handleLiveAgentControl } from "../../../../src/extension/team-tool/api/agent-control.ts";
import type { ApiHandlerContext, ApiLoadedRun } from "../../../../src/extension/team-tool/api/handler-context.ts";
import { handleWriteHeartbeat } from "../../../../src/extension/team-tool/api/heartbeat.ts";
import { handleAckMessage, handleSendMessage, handleValidateMailbox } from "../../../../src/extension/team-tool/api/mailbox.ts";
import { handleApprovePlan, handleCancelPlan } from "../../../../src/extension/team-tool/api/plan-approval.ts";
import { handleForegroundInterrupt } from "../../../../src/extension/team-tool/api/read.ts";
import { result, type TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { paramRequired } from "../../../../src/extension/team-tool/param-error.ts";
import { readMailbox } from "../../../../src/state/coordination/mailbox.ts";
import { flushEventLogBuffer } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";
import { firstText } from "../../../fixtures/tool-result-helpers.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

/** Run an assertion body under a scoped PI_CREW_* env (restored afterwards).
 *  The handlers read caller identity from process.env at call time. */
async function withCallerEnv(values: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(values)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await body();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** One queued task (task-1) in a seeded run — heartbeat write target. */
function seedRun(cwd: string): { runId: string } {
	const team = {
		name: "role-gate-w9-test",
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
	const created = createRunManifest({ cwd, team, workflow, goal: "w9 role gate test" });
	const tasks: TeamTaskState[] = [
		{
			id: "task-1",
			runId: created.manifest.runId,
			role: "worker",
			agent: "worker",
			title: "task 1",
			status: "queued",
			dependsOn: [],
			cwd,
		},
	];
	saveRunTasks(created.manifest, tasks);
	return { runId: created.manifest.runId };
}

function apiCtx(cwd: string, loaded: ApiLoadedRun, cfg: Record<string, unknown>): ApiHandlerContext {
	return {
		cfg,
		loaded,
		result,
		paramRequired,
		params: {} as never,
		ctx: { cwd } as TeamContext,
	};
}

function loadTask(cwd: string, runId: string): TeamTaskState {
	const fresh = loadRunManifestById(cwd, runId)!;
	return fresh.tasks[0]!;
}

async function readEvents(cwd: string, runId: string): Promise<Array<Record<string, unknown>>> {
	await flushEventLogBuffer();
	const fresh = loadRunManifestById(cwd, runId)!;
	const raw = fs.readFileSync(fresh.manifest.eventsPath, "utf-8");
	return raw
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("W9 fixture hygiene: caller env is unset at module scope", (t: TestContext) => {
	assert.equal(process.env.PI_CREW_ROLE, undefined, "PI_CREW_ROLE must be unset (scrub before running)");
	assert.equal(process.env.PI_CREW_TASK_ID, undefined, "PI_CREW_TASK_ID must be unset (scrub before running)");
});

test("W9 role gate: write-heartbeat is denied for a read_only-tier role (explorer), disk unchanged", async () => {
	const cwd = createTrackedTempDir("pi-crew-w9-heartbeat-explorer-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: "explorer" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleWriteHeartbeat(apiCtx(cwd, loaded, { operation: "write-heartbeat", taskId: "task-1", alive: true }));
			assert.equal(res.isError, true, "read_only role must be denied");
			assert.match(firstText(res), /read-only and cannot write worker heartbeats/);
			assert.match(firstText(res), /explorer/);
		});
		const task = loadTask(cwd, runId);
		assert.equal(task.heartbeat, undefined, "no heartbeat may be written by a denied caller");
		const events = await readEvents(cwd, runId);
		assert.equal(events.filter((event) => event.type === "worker.heartbeat").length, 0, "no worker.heartbeat event");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W9 role gate: interrupt-agent (live control cluster) is denied for a read_only role", async () => {
	const cwd = createTrackedTempDir("pi-crew-w9-interrupt-explorer-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: "explorer" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleLiveAgentControl(apiCtx(cwd, loaded, { operation: "interrupt-agent", agentId: "task-1" }));
			assert.equal(res.isError, true, "read_only role must be denied");
			assert.match(firstText(res), /read-only and cannot steer, stop, resume, or interrupt agents/);
		});
		const events = await readEvents(cwd, runId);
		assert.equal(events.filter((event) => event.type === "agent.control.queued").length, 0, "no control request queued");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W9 role gate: steer-agent shares the live-control cluster gate", async () => {
	const cwd = createTrackedTempDir("pi-crew-w9-steer-analyst-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: "analyst" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleLiveAgentControl(
				apiCtx(cwd, loaded, { operation: "steer-agent", agentId: "task-1", message: "hello" }),
			);
			assert.equal(res.isError, true, "read_only role must be denied on the shared handler");
			assert.match(firstText(res), /read-only and cannot steer, stop, resume, or interrupt agents/);
		});
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W9 read stays open: list-live-agents works for a read_only role", async () => {
	const cwd = createTrackedTempDir("pi-crew-w9-list-agents-explorer-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: "explorer" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleListLiveAgents(apiCtx(cwd, loaded, { operation: "list-live-agents" }));
			assert.equal(res.isError, false, "pure reads must stay open for read_only roles");
		});
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W9 role gate: validate-mailbox repair=true is denied for a read_only role; plain validate stays open", async () => {
	const cwd = createTrackedTempDir("pi-crew-w9-mailbox-repair-explorer-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: "explorer" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const denied = await handleValidateMailbox(apiCtx(cwd, loaded, { operation: "validate-mailbox", repair: true }));
			assert.equal(denied.isError, true, "repair pass must be denied for read_only roles");
			assert.match(firstText(denied), /read-only and cannot repair the mailbox/);

			const report = await handleValidateMailbox(apiCtx(cwd, loaded, { operation: "validate-mailbox" }));
			assert.equal(report.isError, false, "plain validation (diagnostic read) must stay open");
		});
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W9 role gate: send-message is denied for a read_only role, mailbox unchanged", async () => {
	const cwd = createTrackedTempDir("pi-crew-w9-send-explorer-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: "reviewer" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleSendMessage(apiCtx(cwd, loaded, { operation: "send-message", to: "task-1", body: "inject" }));
			assert.equal(res.isError, true, "read_only role must be denied");
			assert.match(firstText(res), /read-only and cannot send mailbox messages/);
		});
		const fresh = loadRunManifestById(cwd, runId)!;
		assert.equal(readMailbox(fresh.manifest, "inbox").length, 0, "no message appended to inbox");
		assert.equal(readMailbox(fresh.manifest, "outbox").length, 0, "no message appended to outbox");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W9 role gate: ack-message is denied for a read_only role (gate fires before param validation)", async () => {
	const cwd = createTrackedTempDir("pi-crew-w9-ack-critic-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: "critic" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			// No messageId on purpose: the role gate must fire BEFORE paramRequired.
			const res = await handleAckMessage(apiCtx(cwd, loaded, { operation: "ack-message" }));
			assert.equal(res.isError, true, "read_only role must be denied");
			assert.match(firstText(res), /read-only and cannot acknowledge mailbox messages/);
		});
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W9 PIN (pre-existing w1b pattern): approve-plan stays refused for a read_only role", async () => {
	const cwd = createTrackedTempDir("pi-crew-w9-approve-explorer-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: "explorer" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleApprovePlan(apiCtx(cwd, loaded, { operation: "approve-plan" }));
			assert.equal(res.isError, true, "plan-approval gate (canApprovePlan) must keep refusing read_only roles");
			assert.match(firstText(res), /read-only and cannot approve or cancel plan gates/);
		});
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W9 PIN (pre-existing w1b pattern): cancel-plan stays refused for a read_only role", async () => {
	const cwd = createTrackedTempDir("pi-crew-w9-cancel-explorer-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: "explorer" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleCancelPlan(apiCtx(cwd, loaded, { operation: "cancel-plan" }));
			assert.equal(res.isError, true, "plan-approval gate (canApprovePlan) must keep refusing read_only roles");
			assert.match(firstText(res), /read-only and cannot approve or cancel plan gates/);
		});
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W9 write tier unaffected: executor send-message works and audit fields land on the event", async () => {
	const cwd = createTrackedTempDir("pi-crew-w9-send-executor-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: "executor", PI_CREW_TASK_ID: "task-1" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleSendMessage(apiCtx(cwd, loaded, { operation: "send-message", to: "task-1", body: "status update" }));
			assert.equal(res.isError, false, "write-tier roles remain allowed");
			const message = JSON.parse(firstText(res) || "{}") as { id: string };
			assert.ok(message.id);
		});
		const events = await readEvents(cwd, runId);
		const mailboxEvent = events.find((event) => event.type === "mailbox.message") as { data?: Record<string, unknown> } | undefined;
		assert.ok(mailboxEvent, "mailbox.message event emitted");
		assert.equal(mailboxEvent.data?.callerRole, "executor", "audit trail records callerRole");
		assert.equal(mailboxEvent.data?.callerTaskId, "task-1", "audit trail records callerTaskId");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W9 write tier unaffected: executor write-heartbeat works, audit fields land, task heartbeat written", async () => {
	const cwd = createTrackedTempDir("pi-crew-w9-heartbeat-executor-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: "executor", PI_CREW_TASK_ID: "task-1" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleWriteHeartbeat(apiCtx(cwd, loaded, { operation: "write-heartbeat", taskId: "task-1", alive: true }));
			assert.equal(res.isError, false, "write-tier roles remain allowed");
		});
		const task = loadTask(cwd, runId);
		assert.ok(task.heartbeat, "heartbeat written to disk for the allowed caller");
		const events = await readEvents(cwd, runId);
		const heartbeatEvent = events.find((event) => event.type === "worker.heartbeat") as { data?: Record<string, unknown> } | undefined;
		assert.ok(heartbeatEvent, "worker.heartbeat event emitted");
		assert.equal(heartbeatEvent.data?.callerRole, "executor", "audit trail records callerRole");
		assert.equal(heartbeatEvent.data?.callerTaskId, "task-1", "audit trail records callerTaskId");
		assert.equal(heartbeatEvent.data?.alive, true, "heartbeat payload intact");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W9 root session unaffected: role-less caller may repair the mailbox", async () => {
	const cwd = createTrackedTempDir("pi-crew-w9-repair-root-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: undefined, PI_CREW_TASK_ID: undefined }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleValidateMailbox(apiCtx(cwd, loaded, { operation: "validate-mailbox", repair: true }));
			assert.equal(res.isError, false, "role-less root-session callers keep repair access");
		});
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W9 role gate: foreground-interrupt is denied for a read_only role (leader follow-up)", async () => {
	const cwd = createTrackedTempDir("pi-crew-w9-fgi-explorer-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: "explorer" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleForegroundInterrupt(apiCtx(cwd, loaded, { operation: "foreground-interrupt", reason: "x" }));
			assert.equal(res.isError, true, "read_only role must be denied");
			assert.match(firstText(res), /read-only and cannot request a foreground interrupt/);
		});
		// Control: write-tier role is unaffected (request file written).
		await withCallerEnv({ PI_CREW_ROLE: "executor" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleForegroundInterrupt(apiCtx(cwd, loaded, { operation: "foreground-interrupt", reason: "y" }));
			assert.equal(res.isError, false, "write-tier role must be allowed");
		});
	} finally {
		await removeDirWithRetry(cwd);
	}
});

/**
 * crew-broker-msg-inbox.test.ts — Table-driven unit tests for the msg.inbox
 * read handler (src/runtime/broker/protocol/msg-inbox.ts).
 *
 * Invariants: read-only durable-mailbox pagination for the connection's OWN
 * task lane (conn.taskId); the run-level "inbox" lane (no taskId) is
 * readable ONLY with compound auth — the orchestrator key is compound by
 * construction, legacy bare-runId ("runId-fallback") worker connections are
 * rejected (S-2); acknowledged messages are never re-delivered; the cursor is
 * a monotonic offset (garbage degrades to 0, never throws); structured
 * errors for unauthed / bad-params / no-manifest / run-level-lane gate, in
 * that precedence order.
 *
 * Fixture: real scaffold run + durable appends via appendMailboxMessageAsync
 * (same discipline as crew-broker-mailbox-observer.test.ts).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import type { ServerConnection } from "../../../../src/runtime/broker/protocol/connection-state.ts";
import { handleMsgInbox, type MsgInboxHelpers } from "../../../../src/runtime/broker/protocol/msg-inbox.ts";
import { appendMailboxMessageAsync, type MailboxMessage } from "../../../../src/state/coordination/mailbox.ts";
import { loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import { teardownCwd } from "../../../fixtures/teardown-cwd.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

interface Recorded {
	errors: Array<{ id: string; code: string; message: string }>;
	results: Array<{ id: string; result: InboxPage }>;
}

interface InboxPage {
	messages: MailboxMessage[];
	nextCursor: string | undefined;
	hasMore: boolean;
	total: number;
}

function recordingHelpers(): { helpers: MsgInboxHelpers; seen: Recorded } {
	const seen: Recorded = { errors: [], results: [] };
	return {
		seen,
		helpers: {
			sendError: (_conn, id, code, message) => {
				seen.errors.push({ id, code, message });
			},
			sendResult: (_conn, id, result) => {
				seen.results.push({ id, result: result as InboxPage });
			},
		},
	};
}

function conn(
	runId?: string,
	taskId?: string,
	authMatchKind?: "compound" | "runId-fallback",
	role?: "orchestrator" | "worker",
): ServerConnection {
	return { runId, taskId, authMatchKind, role } as unknown as ServerConnection;
}

interface InboxFixture {
	cwd: string;
	runId: string;
	taskId: string;
	manifest: TeamRunManifest;
	/** bodies of the 4 non-acknowledged task messages, insertion order */
	pendingBodies: string[];
}

/** Scaffold run; task lane gets m1..m4 (queued/delivered) + m5 acknowledged. */
async function inboxFixture(prefix: string): Promise<InboxFixture> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "msg-inbox" },
		{ cwd },
	);
	const runId = run.details.runId as string;
	const manifest = loadRunManifestById(cwd, runId)!.manifest;
	const taskId = loadRunManifestById(cwd, runId)!.tasks[0]!.id;
	const pendingBodies = ["m1", "m2", "m3", "m4"];
	for (const [i, body] of pendingBodies.entries()) {
		await appendMailboxMessageAsync(manifest, {
			direction: "inbox",
			from: "leader",
			to: taskId,
			taskId,
			body,
			kind: "message",
			priority: "normal",
			deliveryMode: "next_turn",
			status: i === 0 ? "delivered" : "queued",
		});
	}
	await appendMailboxMessageAsync(manifest, {
		direction: "inbox",
		from: "leader",
		to: taskId,
		taskId,
		body: "m5-acked",
		kind: "message",
		deliveryMode: "next_turn",
		status: "acknowledged",
	});
	return { cwd, runId, taskId, manifest, pendingBodies };
}

test("msg.inbox: unauthed connection → structured auth error", async () => {
	const { helpers, seen } = recordingHelpers();
	await handleMsgInbox(conn(undefined), "r1", {}, helpers, "/any");
	assert.deepEqual(
		seen.errors.map((e) => e.code),
		["auth"],
	);
	assert.equal(seen.results.length, 0);
});

test("msg.inbox: bad params beat the cwd check (precedence)", async () => {
	const { helpers, seen } = recordingHelpers();
	// limit=0 is malformed AND cwd is absent — params validate first.
	await handleMsgInbox(conn("run-1"), "r2", { limit: 0 }, helpers, undefined);
	assert.deepEqual(
		seen.errors.map((e) => e.code),
		["bad-params"],
	);
	assert.match(seen.errors[0].message, /invalid params/);
});

test("msg.inbox: absent cwd → no-manifest even with valid params", async () => {
	const { helpers, seen } = recordingHelpers();
	await handleMsgInbox(conn("run-1"), "r3", { limit: 5 }, helpers, undefined);
	assert.deepEqual(
		seen.errors.map((e) => e.code),
		["no-manifest"],
	);
	assert.match(seen.errors[0].message, /no cwd configured/);
});

test("msg.inbox: unknown run → no-manifest naming the run", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-inbox-unknown-"));
	try {
		const { helpers, seen } = recordingHelpers();
		await handleMsgInbox(conn("ghost-run"), "r4", {}, helpers, dir);
		assert.deepEqual(
			seen.errors.map((e) => e.code),
			["no-manifest"],
		);
		assert.match(seen.errors[0].message, /ghost-run/);
	} finally {
		await removeDirWithRetry(dir);
	}
});

test("msg.inbox: task lane returns non-acknowledged messages, stable createdAt order", async () => {
	const fx = await inboxFixture("pi-crew-inbox-task-");
	try {
		const { helpers, seen } = recordingHelpers();
		await handleMsgInbox(conn(fx.runId, fx.taskId), "r5", {}, helpers, fx.cwd);
		assert.equal(seen.errors.length, 0);
		const page = seen.results[0].result;
		assert.equal(page.total, 4, "acknowledged message is excluded from total");
		assert.deepEqual(
			page.messages.map((m) => m.body),
			fx.pendingBodies,
		);
		for (let i = 1; i < page.messages.length; i++) {
			assert.ok(page.messages[i].createdAt >= page.messages[i - 1].createdAt, "messages sorted by createdAt");
		}
		assert.equal(page.hasMore, false, "default limit 100 covers all 4");
		assert.equal(page.nextCursor, undefined);
	} finally {
		teardownCwd(fx.cwd);
	}
});

test("msg.inbox: cursor/limit pagination walks the filtered list (monotonic, terminal undefined)", async () => {
	const fx = await inboxFixture("pi-crew-inbox-page-");
	try {
		const p1 = recordingHelpers();
		await handleMsgInbox(conn(fx.runId, fx.taskId), "r6a", { limit: 2, cursor: "1" }, p1.helpers, fx.cwd);
		assert.deepEqual(
			p1.seen.results[0].result.messages.map((m) => m.body),
			["m2", "m3"],
		);
		assert.equal(p1.seen.results[0].result.hasMore, true);
		assert.equal(p1.seen.results[0].result.nextCursor, "3");
		assert.equal(p1.seen.results[0].result.total, 4, "total is the full filtered count, not the page");

		const p2 = recordingHelpers();
		await handleMsgInbox(conn(fx.runId, fx.taskId), "r6b", { limit: 2, cursor: "3" }, p2.helpers, fx.cwd);
		assert.deepEqual(
			p2.seen.results[0].result.messages.map((m) => m.body),
			["m4"],
		);
		assert.equal(p2.seen.results[0].result.hasMore, false);
		assert.equal(p2.seen.results[0].result.nextCursor, undefined, "terminal page has no continuation");
	} finally {
		teardownCwd(fx.cwd);
	}
});

test("msg.inbox: cursor past the end → empty page, hasMore false, total preserved", async () => {
	const fx = await inboxFixture("pi-crew-inbox-past-");
	try {
		const { helpers, seen } = recordingHelpers();
		await handleMsgInbox(conn(fx.runId, fx.taskId), "r7", { cursor: "99" }, helpers, fx.cwd);
		const page = seen.results[0].result;
		assert.deepEqual(page.messages, []);
		assert.equal(page.hasMore, false);
		assert.equal(page.nextCursor, undefined);
		assert.equal(page.total, 4);
	} finally {
		teardownCwd(fx.cwd);
	}
});

test("msg.inbox: garbage cursor degrades to offset 0 (never throws)", async () => {
	const fx = await inboxFixture("pi-crew-inbox-garbage-");
	try {
		const { helpers, seen } = recordingHelpers();
		await handleMsgInbox(conn(fx.runId, fx.taskId), "r8", { cursor: "not-a-number" }, helpers, fx.cwd);
		assert.equal(seen.errors.length, 0);
		assert.deepEqual(
			seen.results[0].result.messages.map((m) => m.body),
			fx.pendingBodies,
			"parseInt('not-a-number') → NaN → 0 → first page",
		);
	} finally {
		teardownCwd(fx.cwd);
	}
});

test("msg.inbox: run-level lane requires compound auth — runId-fallback worker rejected (S-2)", async () => {
	const fx = await inboxFixture("pi-crew-inbox-fallback-");
	try {
		await appendMailboxMessageAsync(fx.manifest, {
			direction: "inbox",
			from: "worker-1",
			to: "parent",
			body: "run-level-only",
			kind: "message",
			deliveryMode: "next_turn",
		});
		// Legacy bare-runId token match (hello presented no taskId) — the exact
		// S-2 actor: before the gate this connection read the orchestrator's
		// run-level lane (cross-lane read with an unscoped identity).
		const fallback = recordingHelpers();
		await handleMsgInbox(conn(fx.runId, undefined, "runId-fallback", "worker"), "r9a", {}, fallback.helpers, fx.cwd);
		assert.deepEqual(
			fallback.seen.errors.map((e) => e.code),
			["forbidden"],
		);
		assert.match(fallback.seen.errors[0].message, /PI_CREW_BROKER_TASK_ID/, "migrate hint for the legacy worker");
		assert.equal(fallback.seen.results.length, 0, "no mailbox content is returned");

		// Fail-closed default: authMatchKind undefined (pre-hello shape) must not
		// fall through to a run-level read either.
		const undetermined = recordingHelpers();
		await handleMsgInbox(conn(fx.runId, undefined), "r9b", {}, undetermined.helpers, fx.cwd);
		assert.deepEqual(
			undetermined.seen.errors.map((e) => e.code),
			["forbidden"],
		);
		assert.equal(undetermined.seen.results.length, 0);
	} finally {
		teardownCwd(fx.cwd);
	}
});

test("msg.inbox: compound orchestrator connection (no taskId) reads the run-level lane only", async () => {
	const fx = await inboxFixture("pi-crew-inbox-runlane-");
	try {
		await appendMailboxMessageAsync(fx.manifest, {
			direction: "inbox",
			from: "worker-1",
			to: "parent",
			body: "run-level-only",
			kind: "message",
			deliveryMode: "next_turn",
		});
		// S-2 decision: gate on compound auth, NOT on "taskId absent" — the
		// orchestrator key is compound by construction (crew-broker-tokens.ts
		// tokenRoleWithMatchKind), so the legitimate run-level reader keeps
		// access (the only production hello shape that reaches this branch).
		const orchestrator = recordingHelpers();
		await handleMsgInbox(conn(fx.runId, undefined, "compound", "orchestrator"), "r10a", {}, orchestrator.helpers, fx.cwd);
		assert.equal(orchestrator.seen.errors.length, 0);
		const lane = orchestrator.seen.results[0].result;
		assert.deepEqual(
			lane.messages.map((m) => m.body),
			["run-level-only"],
			"run-level lane must NOT leak task-lane messages",
		);
		assert.equal(lane.total, 1);

		// And the task lane must not leak the run-level message back.
		const withTask = recordingHelpers();
		await handleMsgInbox(conn(fx.runId, fx.taskId, "compound", "worker"), "r10b", {}, withTask.helpers, fx.cwd);
		const taskLane = withTask.seen.results[0].result;
		assert.equal(
			taskLane.messages.some((m) => m.body === "run-level-only"),
			false,
		);
		assert.equal(taskLane.total, 4);
	} finally {
		teardownCwd(fx.cwd);
	}
});

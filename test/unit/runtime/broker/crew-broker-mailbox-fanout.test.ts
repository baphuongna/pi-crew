/**
 * crew-broker-mailbox-fanout.test.ts — Table-driven unit tests for the
 * mailbox live-fanout helper (src/runtime/broker/mailbox-observer/mailbox-fanout.ts).
 *
 * Invariants (Phase 1.3, best-effort push):
 *  - delivery goes ONLY to authed, open connections of the message's run;
 *  - recipient filter: exact taskId match, or "all"/empty `to` broadcast,
 *    and "parent" reaches the run's orchestrator connection (Task 5b wake —
 *    the orchestrator's taskId never equals "parent", so it needs the role
 *    branch) — never an unrelated worker;
 *  - offline recipients are silently skipped (they recover via msg.inbox);
 *  - a throwing/slow writer for one recipient must not break fanout to others;
 *  - the wire frame is one NDJSON `mailbox.message` event, seq 0 (dedup by
 *    msg.id lives downstream in prompt-runtime.ts).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { type FanoutWriters, fanoutMailboxMessage } from "../../../../src/runtime/broker/mailbox-observer/mailbox-fanout.ts";
import type { ServerConnection } from "../../../../src/runtime/broker/protocol/connection-state.ts";
import type { MailboxMessage } from "../../../../src/state/coordination/mailbox.ts";

interface FakeConn {
	conn: ServerConnection;
	tag: string;
}

function fakeConn(tag: string, meta: { closed?: boolean; authed?: boolean; taskId?: string; role?: "orchestrator" | "worker" }): FakeConn {
	return {
		tag,
		conn: {
			closed: meta.closed ?? false,
			authed: meta.authed ?? true,
			taskId: meta.taskId,
			role: meta.role ?? "worker",
		} as unknown as ServerConnection,
	};
}

function makeMessage(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
	return {
		id: "msg_fix1",
		runId: "run-1",
		direction: "inbox",
		from: "leader",
		to: "task-1",
		body: "hello",
		createdAt: new Date().toISOString(),
		status: "queued",
		kind: "message",
		priority: "normal",
		...overrides,
	} as MailboxMessage;
}

function recordingWriters(): { writers: FanoutWriters; calls: Array<{ tag: string; frame: unknown; force: boolean }> } {
	const calls: Array<{ tag: string; frame: unknown; force: boolean }> = [];
	return {
		calls,
		writers: {
			writeOrQueue: (conn, buf, force) => {
				const tag = (conn as { __tag?: string }).__tag ?? "unknown";
				calls.push({ tag, frame: JSON.parse(buf.subarray(0, buf.length - 1).toString("utf8")), force });
			},
		},
	};
}

/** Tag conns so the recording writer can identify them. */
function tagged(conns: FakeConn[]): Map<string, Set<ServerConnection>> {
	const byRun = new Map<string, Set<ServerConnection>>();
	const set = new Set<ServerConnection>();
	for (const c of conns) {
		Object.defineProperty(c.conn, "__tag", { value: c.tag, enumerable: false });
		set.add(c.conn);
	}
	byRun.set("run-1", set);
	return byRun;
}

test("fanout: no connections registered for the run → no-op", () => {
	const { writers, calls } = recordingWriters();
	fanoutMailboxMessage(new Map(), writers, makeMessage());
	assert.equal(calls.length, 0);
	const empty = new Map<string, Set<ServerConnection>>([["run-1", new Set()]]);
	fanoutMailboxMessage(empty, writers, makeMessage());
	assert.equal(calls.length, 0, "empty set is a no-op too");
});

test("fanout: recipient filter table (exact taskId / all / empty to / parent)", () => {
	const cases: Array<{
		name: string;
		to: string;
		conns: FakeConn[];
		expect: string[];
	}> = [
		{
			name: "exact taskId: only the addressed task receives",
			to: "task-1",
			conns: [fakeConn("t1", { taskId: "task-1" }), fakeConn("t2", { taskId: "task-2" })],
			expect: ["t1"],
		},
		{
			name: "'all' broadcast: every authed connection receives",
			to: "all",
			conns: [fakeConn("t1", { taskId: "task-1" }), fakeConn("t2", { taskId: "task-2" }), fakeConn("orch", { role: "orchestrator" })],
			expect: ["t1", "t2", "orch"],
		},
		{
			name: "empty to: falsy broadcast reaches everyone",
			to: "",
			conns: [fakeConn("t1", { taskId: "task-1" }), fakeConn("t2", { taskId: "task-2" })],
			expect: ["t1", "t2"],
		},
		{
			name: "'parent': the orchestrator connection receives (role branch), workers do not",
			to: "parent",
			conns: [fakeConn("orch", { role: "orchestrator" }), fakeConn("w9", { taskId: "task-9" })],
			expect: ["orch"],
		},
	];
	for (const c of cases) {
		const { writers, calls } = recordingWriters();
		fanoutMailboxMessage(tagged(c.conns), writers, makeMessage({ to: c.to }));
		assert.deepEqual(calls.map((x) => x.tag).sort(), [...c.expect].sort(), c.name);
	}
});

test("fanout: closed or unauthenticated recipients are skipped (offline recovery via msg.inbox)", () => {
	const conns = [
		fakeConn("open", { taskId: "task-1" }),
		fakeConn("closed", { taskId: "task-1", closed: true }),
		fakeConn("unauthed", { taskId: "task-1", authed: false }),
	];
	const { writers, calls } = recordingWriters();
	fanoutMailboxMessage(tagged(conns), writers, makeMessage({ to: "task-1" }));
	assert.deepEqual(
		calls.map((x) => x.tag),
		["open"],
	);
});

test("fanout: a throwing writer for one recipient is isolated — others still receive", () => {
	const victim = fakeConn("victim", { taskId: "task-1" });
	const survivor = fakeConn("survivor", { taskId: "task-1" });
	const delivered: string[] = [];
	const writers: FanoutWriters = {
		writeOrQueue: (conn, _buf, _force) => {
			if (conn === victim.conn) throw new Error("slow/dead recipient");
			delivered.push(conn === survivor.conn ? "survivor" : "other");
		},
	};
	assert.doesNotThrow(() => fanoutMailboxMessage(tagged([victim, survivor]), writers, makeMessage({ to: "task-1" })));
	assert.deepEqual(delivered, ["survivor"], "fanout to the survivor must survive the victim's throw");
});

test("fanout: frame shape is one NDJSON mailbox.message event with seq 0", () => {
	const conn = fakeConn("t1", { taskId: "task-1" });
	const frames: Array<{ buf: Buffer; force: boolean }> = [];
	const writers: FanoutWriters = {
		writeOrQueue: (_conn, buf, force) => {
			frames.push({ buf, force });
		},
	};
	fanoutMailboxMessage(tagged([conn]), writers, makeMessage());
	assert.equal(frames.length, 1);
	const { buf, force } = frames[0];
	assert.equal(force, false, "mailbox fanout is best-effort (never force-flushed)");
	assert.equal(buf[buf.length - 1], 0x0a, "exactly one trailing newline");
	const frame = JSON.parse(buf.subarray(0, buf.length - 1).toString("utf8")) as {
		event: string;
		data: Record<string, unknown>;
		seq: number;
	};
	assert.equal(frame.event, "mailbox.message");
	assert.equal(frame.seq, 0, "mailbox messages carry no TeamEvent seq — dedup by msg.id downstream");
	assert.deepEqual(frame.data, { id: "msg_fix1", from: "leader", to: "task-1", body: "hello", kind: "message", priority: "normal" });
});

test("fanout: connections of a DIFFERENT run never receive (run isolation)", () => {
	const otherRunConn = fakeConn("other-run", { taskId: "task-1" });
	const { writers, calls } = recordingWriters();
	const byRun = new Map<string, Set<ServerConnection>>([["run-other", new Set([otherRunConn.conn])]]);
	fanoutMailboxMessage(byRun, writers, makeMessage({ runId: "run-1", to: "task-1" }));
	assert.equal(calls.length, 0);
});

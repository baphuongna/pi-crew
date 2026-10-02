/**
 * crew-broker-wait-auth.test.ts — Table-driven unit tests for the wait.*
 * auth gate + policy-rejection trace (src/runtime/broker/protocol/wait-auth.ts).
 *
 * §7/ADR-0 item 6 (auth): wait.* methods admit ONLY a worker role carrying a
 * task-scoped (compound) token. Everything else — orchestrator tokens, legacy
 * bare-runId fallback matches, unauthenticated metadata — must be rejected
 * `forbidden`, and the legacy match carries the migration hint.
 *
 * §7/ADR-0 item 7 (fail-closed, never silent): a disabled-gate rejection MUST
 * leave a durable `policy.action` trace in events.jsonl; the recorder itself
 * must never throw (an append failure is logged, not raised).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ServerConnection } from "../../../../src/runtime/broker/protocol/connection-state.ts";
import { recordWaitPolicyRejection, waitAuthError } from "../../../../src/runtime/broker/protocol/wait-auth.ts";
import type { TeamEvent } from "../../../../src/state/event-log/event-log.ts";
import { appendEventAsync } from "../../../../src/state/event-log/event-log.ts";

/** Minimal conn metadata stub — waitAuthError only reads role/authMatchKind. */
function conn(meta: { role?: "orchestrator" | "worker"; authMatchKind?: "compound" | "runId-fallback" }): ServerConnection {
	return meta as unknown as ServerConnection;
}

// ---------------------------------------------------------------------------
// waitAuthError — role + token-kind gate (ADR-0 item 6)
// ---------------------------------------------------------------------------

test("waitAuthError: only worker + compound token passes (table)", () => {
	const cases: Array<{
		name: string;
		role?: "orchestrator" | "worker";
		authMatchKind?: "compound" | "runId-fallback";
		rejected: boolean;
	}> = [
		{ name: "worker + compound (the only admitted shape)", role: "worker", authMatchKind: "compound", rejected: false },
		{ name: "worker + legacy bare-runId fallback", role: "worker", authMatchKind: "runId-fallback", rejected: true },
		{ name: "worker + no authMatchKind (unauthenticated metadata)", role: "worker", rejected: true },
		{ name: "orchestrator + compound (rejected BY ROLE)", role: "orchestrator", authMatchKind: "compound", rejected: true },
		{ name: "orchestrator + fallback", role: "orchestrator", authMatchKind: "runId-fallback", rejected: true },
		{ name: "no role at all", rejected: true },
	];
	for (const c of cases) {
		const err = waitAuthError(conn({ role: c.role, authMatchKind: c.authMatchKind }));
		if (!c.rejected) {
			assert.equal(err, null, `${c.name}: must pass`);
			continue;
		}
		assert.ok(err, `${c.name}: must be rejected`);
		assert.equal(err.code, "forbidden", `${c.name}: code=forbidden`);
		assert.ok(err.message.length > 0);
	}
});

test("waitAuthError: legacy fallback rejection carries the migrate hint", () => {
	const err = waitAuthError(conn({ role: "worker", authMatchKind: "runId-fallback" }));
	assert.ok(err);
	assert.match(err.message, /PI_CREW_BROKER_TASK_ID/, "legacy match must point at the compound-token re-dispatch");
});

test("waitAuthError: non-worker rejection names the worker task-scoped requirement", () => {
	for (const meta of [{ role: "orchestrator" as const }, {}]) {
		const err = waitAuthError(conn(meta));
		assert.ok(err);
		assert.match(err.message, /worker task-scoped token/);
	}
});

// ---------------------------------------------------------------------------
// recordWaitPolicyRejection — durable, never-silent, never-throwing (item 7)
// ---------------------------------------------------------------------------

test("recordWaitPolicyRejection appends a policy.action trace to events.jsonl", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wait-auth-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		// Initialize the log the same way production does (async durable append).
		await appendEventAsync(eventsPath, { type: "task.created", runId: "run-1", taskId: "task-1", message: "seed" });
		const before = fs.readFileSync(eventsPath, "utf-8").trim().split("\n").length;

		recordWaitPolicyRejection({ eventsPath, runId: "run-1" }, "task-1", "wait.request");

		// Fire-and-forget append: drain the event loop until the line lands.
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		const lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
		assert.equal(lines.length, before + 1, "exactly one durable trace line appended");
		const trace = JSON.parse(lines[lines.length - 1]) as TeamEvent;
		assert.equal(trace.type, "policy.action");
		assert.equal(trace.runId, "run-1");
		assert.equal(trace.taskId, "task-1");
		assert.match(trace.message ?? "", /wait\.request rejected: waitMethodsEnabled=false/);
		const data = trace.data as Record<string, unknown> | undefined;
		assert.equal(data?.action, "wait.request");
		assert.equal(data?.reason, "wait-methods-disabled");
		assert.equal(data?.policy, "broker.waitMethodsEnabled=false");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("recordWaitPolicyRejection never throws when the events path is unwritable", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wait-auth-err-"));
	try {
		const impossible = path.join(dir, "no-such-dir", "events.jsonl");
		// Must return synchronously without raising despite the doomed append.
		assert.doesNotThrow(() => recordWaitPolicyRejection({ eventsPath: impossible, runId: "run-x" }, "task-x", "wait.resolve"));
		// Give the rejected fire-and-forget promise its catch turn.
		await new Promise<void>((resolve) => setImmediate(resolve));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

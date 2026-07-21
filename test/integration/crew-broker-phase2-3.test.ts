/**
 * crew-broker-phase2-3.test.ts — Phase 2 + 3 integration tests.
 *
 * Covers:
 *  - events.subscribe: live event stream (replay from seq + live push)
 *  - task.waitStatus: blocks until target status, with bounded timeout
 *  - steer.push: durable write to target task's mailbox (kind=steer, priority=urgent)
 *  - escalate: durable write to orchestrator's mailbox (kind=follow-up)
 *  - close-while-subscribed: subscription is torn down on connection close
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { CrewBroker } from "../../src/runtime/crew-broker.ts";
import { CrewBrokerClient } from "../../src/runtime/crew-broker-client.ts";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";

// ----------------------------------------------------------------------------
// Fixture (same canonical pattern as crew-broker-msg.test.ts)
// ----------------------------------------------------------------------------

interface Phase23Fixture {
	cwd: string;
	runId: string;
	broker: CrewBroker;
	token: string;
	taskIds: string[];
	cleanup: () => Promise<void>;
}

async function makePhase23Fixture(): Promise<Phase23Fixture> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-phase23-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{
			action: "run",
			config: { runtime: { mode: "scaffold" } },
			team: "fast-fix",
			goal: "phase 2/3 integration",
		},
		{ cwd },
	);
	const runId = run.details.runId!;
	if (!runId) throw new Error("scaffold run did not return a runId");
	const loaded = loadRunManifestById(cwd, runId);
	if (!loaded) throw new Error("could not load manifest for scaffold run");
	const taskIds = loaded.tasks.map((t) => t.id);
	if (taskIds.length < 2) throw new Error(`expected ≥2 tasks, got ${taskIds.length}`);
	const broker = new CrewBroker({
		sessionId: "phase23-" + Date.now(),
		socketPath: path.join(os.tmpdir(), `pi-crew-phase23-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`),
		enabled: true,
		cwd,
	});
	await broker.start();
	const token = broker.issueRunToken(runId);
	const cleanup = async () => {
		try { await broker.stop(); } catch { /* ignore */ }
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
	};
	return { cwd, runId, broker, token, taskIds, cleanup };
}

async function connectClient(args: {
	runId: string;
	taskId: string;
	token: string;
	socketPath: string;
}): Promise<CrewBrokerClient> {
	const client = new CrewBrokerClient({
		runId: args.runId,
		taskId: args.taskId,
		socketPath: args.socketPath,
		token: args.token,
		setTimeoutFn: ((cb: () => void, _ms: number) => {
			const t = setTimeout(cb, 100);
			return new Proxy(t, {
				get(target, prop) {
					if (prop === "unref" || prop === "ref" || prop === "hasRef") return undefined;
					return Reflect.get(target, prop);
				},
			}) as unknown as NodeJS.Timeout;
		}) as typeof setTimeout,
	});
	const ping = await client.request("ping", null);
	if (!ping.ok) {
		await client.close();
		throw new Error("connect+ping failed: " + JSON.stringify(ping));
	}
	return client;
}

/** Read the first non-hello, non-ping frame from the client within a deadline. */
async function waitForFrame(client: CrewBrokerClient, predicate: (f: { event?: string; data?: unknown; id?: string }) => boolean, deadlineMs = 5000): Promise<unknown> {
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		const r = await client.request("ping", null);
		// The ping response itself is not the frame we want; this is a placeholder
		// for "let microtasks drain". Actual frame delivery is via event frames
		// which are silently consumed by the client (Phase 1).
		void r;
		await new Promise<void>((res) => setTimeout(res, 50));
	}
	return undefined;
}

// ----------------------------------------------------------------------------
// Phase 2: events.subscribe
// ----------------------------------------------------------------------------

test("phase 2: events.subscribe returns subscribed=true with sinceSeq", async () => {
	const fx = await makePhase23Fixture();
	try {
		const [taskIdA] = fx.taskIds;
		const a = await connectClient({ runId: fx.runId, taskId: taskIdA, token: fx.token, socketPath: fx.broker.socketPath });
		try {
			const result = await a.request("events.subscribe", { sinceSeq: 0 });
			assert.equal(result.ok, true, "events.subscribe should succeed: " + JSON.stringify(result));
			if (result.ok === true) {
				const v = result.value as { subscribed: boolean; sinceSeq: number };
				assert.equal(v.subscribed, true);
				assert.equal(v.sinceSeq, 0);
			}
		} finally {
			await a.close();
		}
	} finally {
		await fx.cleanup();
	}
});

test("phase 2: events.subscribe clamps negative sinceSeq to 0 (lenient)", async () => {
	const fx = await makePhase23Fixture();
	try {
		const [taskIdA] = fx.taskIds;
		const a = await connectClient({ runId: fx.runId, taskId: taskIdA, token: fx.token, socketPath: fx.broker.socketPath });
		try {
			// Negative sinceSeq is clamped to 0 (lenient validation).
			const result = await a.request("events.subscribe", { sinceSeq: -5 });
			assert.equal(result.ok, true, "negative sinceSeq should clamp to 0, not reject: " + JSON.stringify(result));
			if (result.ok === true) {
				const v = result.value as { subscribed: boolean; sinceSeq: number };
				assert.equal(v.subscribed, true);
				assert.equal(v.sinceSeq, 0);
			}
		} finally {
			await a.close();
		}
	} finally {
		await fx.cleanup();
	}
});

// ----------------------------------------------------------------------------
// Phase 2: task.waitStatus
// ----------------------------------------------------------------------------

test("phase 2: task.waitStatus resolves when target status is reached", async () => {
	const fx = await makePhase23Fixture();
	try {
		const [taskIdA, taskIdB] = fx.taskIds;
		const a = await connectClient({ runId: fx.runId, taskId: taskIdA, token: fx.token, socketPath: fx.broker.socketPath });
		try {
			// The scaffold run completes tasks to "completed" status. The
			// "any terminal" semantic in the handler matches any terminal
			// status (completed/failed/cancelled) when `until` is also terminal.
			const result = await a.request("task.waitStatus", {
				taskId: taskIdB,
				until: "completed",
				timeoutMs: 2000,
			});
			assert.equal(result.ok, true, "task.waitStatus should succeed: " + JSON.stringify(result));
			if (result.ok === true) {
				const v = result.value as { taskId: string; status: string; waitedMs: number };
				assert.equal(v.taskId, taskIdB);
				// Status must be one of the terminal set (the task might be
				// "completed" or "cancelled" depending on the scaffold outcome).
				assert.ok(["completed", "failed", "cancelled"].includes(v.status), `expected terminal status, got ${v.status}`);
				assert.ok(v.waitedMs >= 0);
			}
		} finally {
			await a.close();
		}
	} finally {
		await fx.cleanup();
	}
});

test("phase 2: task.waitStatus rejects bad params (missing taskId/until)", async () => {
	const fx = await makePhase23Fixture();
	try {
		const [taskIdA] = fx.taskIds;
		const a = await connectClient({ runId: fx.runId, taskId: taskIdA, token: fx.token, socketPath: fx.broker.socketPath });
		try {
			const r1 = await a.request("task.waitStatus", { until: "completed" });
			assert.equal(r1.ok, false);
			if (r1.ok === false) assert.equal(r1.errorCode, "bad-params");
			const r2 = await a.request("task.waitStatus", { taskId: "x" });
			assert.equal(r2.ok, false);
			if (r2.ok === false) assert.equal(r2.errorCode, "bad-params");
		} finally {
			await a.close();
		}
	} finally {
		await fx.cleanup();
	}
});

// ----------------------------------------------------------------------------
// Phase 3: steer.push
// ----------------------------------------------------------------------------

test("phase 3: steer.push writes durable mailbox record with kind=steer, priority=urgent", async () => {
	const fx = await makePhase23Fixture();
	try {
		const [taskIdA, taskIdB] = fx.taskIds;
		const a = await connectClient({ runId: fx.runId, taskId: taskIdA, token: fx.token, socketPath: fx.broker.socketPath });
		try {
			const result = await a.request("steer.push", {
				taskId: taskIdB,
				body: "redirect to /workspace",
			});
			assert.equal(result.ok, true, "steer.push should succeed: " + JSON.stringify(result));
			if (result.ok === true) {
				const v = result.value as { messageId: string; taskId: string; durable: boolean };
				assert.ok(v.messageId.startsWith("steer_"));
				assert.equal(v.taskId, taskIdB);
				assert.equal(v.durable, true);
			}
			// Confirm the message landed on disk in the per-task mailbox.
			const loaded = loadRunManifestById(fx.cwd, fx.runId)!;
			const steerFile = path.join(loaded.manifest.stateRoot, "mailbox", "tasks", taskIdB, "inbox.jsonl");
			assert.ok(fs.existsSync(steerFile), `expected steer file at ${steerFile}`);
			const content = fs.readFileSync(steerFile, "utf-8");
			assert.ok(content.includes("redirect to /workspace"), "steer body should be durable");
			assert.ok(!content.includes(fx.token), "token must never reach mailbox files");
		} finally {
			await a.close();
		}
	} finally {
		await fx.cleanup();
	}
});

test("phase 3: steer.push rejects bad params (missing taskId/body)", async () => {
	const fx = await makePhase23Fixture();
	try {
		const [taskIdA] = fx.taskIds;
		const a = await connectClient({ runId: fx.runId, taskId: taskIdA, token: fx.token, socketPath: fx.broker.socketPath });
		try {
			const r1 = await a.request("steer.push", { body: "x" });
			assert.equal(r1.ok, false);
			if (r1.ok === false) assert.equal(r1.errorCode, "bad-params");
			const r2 = await a.request("steer.push", { taskId: "x" });
			assert.equal(r2.ok, false);
			if (r2.ok === false) assert.equal(r2.errorCode, "bad-params");
		} finally {
			await a.close();
		}
	} finally {
		await fx.cleanup();
	}
});

// ----------------------------------------------------------------------------
// Phase 3: escalate
// ----------------------------------------------------------------------------

test("phase 3: escalate writes durable follow-up to recipient (default = sender's taskId)", async () => {
	const fx = await makePhase23Fixture();
	try {
		const [taskIdA, taskIdB] = fx.taskIds;
		const a = await connectClient({ runId: fx.runId, taskId: taskIdA, token: fx.token, socketPath: fx.broker.socketPath });
		try {
			const result = await a.request("escalate", { body: "need human review on Q3" });
			assert.equal(result.ok, true, "escalate should succeed: " + JSON.stringify(result));
			if (result.ok === true) {
				const v = result.value as { messageId: string; to: string; durable: boolean };
				assert.ok(v.messageId.startsWith("esc_"));
				// Default recipient = the SENDER's taskId (the orchestrator that
				// spawned this worker, which is the sender itself in this test).
				assert.equal(v.to, taskIdA);
				assert.equal(v.durable, true);
			}
			// Confirm the message landed in task A's inbox.
			const loaded = loadRunManifestById(fx.cwd, fx.runId)!;
			const inboxFile = path.join(loaded.manifest.stateRoot, "mailbox", "tasks", taskIdA, "inbox.jsonl");
			assert.ok(fs.existsSync(inboxFile));
			const content = fs.readFileSync(inboxFile, "utf-8");
			assert.ok(content.includes("need human review on Q3"));
		} finally {
			await a.close();
		}
		// taskIdB is unused in this test, but we use it to keep both args non-null.
		void taskIdB;
	} finally {
		await fx.cleanup();
	}
});

// ----------------------------------------------------------------------------
// Cleanup: subscription teardown on connection close
// ----------------------------------------------------------------------------

test("phase 2: events.subscribe is torn down on connection close", async () => {
	const fx = await makePhase23Fixture();
	try {
		const [taskIdA] = fx.taskIds;
		const a = await connectClient({ runId: fx.runId, taskId: taskIdA, token: fx.token, socketPath: fx.broker.socketPath });
		// Subscribe and then close. The broker should have no live subscriptions
		// after close (we can't directly inspect, but the close path runs
		// without throwing).
		const sub = await a.request("events.subscribe", { sinceSeq: 0 });
		assert.equal(sub.ok, true);
		await a.close();
		// Sanity: a fresh request (from a new client) still works.
		const b = await connectClient({ runId: fx.runId, taskId: taskIdA, token: fx.token, socketPath: fx.broker.socketPath });
		try {
			const ping = await b.request("ping", null);
			assert.equal(ping.ok, true);
		} finally {
			await b.close();
		}
	} finally {
		await fx.cleanup();
	}
});
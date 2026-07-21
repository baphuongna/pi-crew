/**
 * crew-broker-msg.test.ts — Phase 1.6 E2E messaging integration.
 *
 * Uses the canonical pi-crew fixture pattern: a temp cwd with `.crew/` so
 * `useProjectState()` returns true and the state-store resolves to
 * `projectCrewRoot(cwd)`. A scaffold run is created via `handleTeamTool`,
 * which sets up manifest.json + tasks.json correctly. The broker is then
 * constructed with that cwd and exercised end-to-end via real sockets.
 *
 * Verifies:
 *  - DM from A to B: durable write + msg.inbox returns the message.
 *  - Broadcast ("all") reaches every task.
 *  - Body size cap (256 KiB) enforced.
 *  - Token never reaches mailbox files.
 *  - Ack happens only after the durable append succeeds.
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
// Fixture: scaffold a real run in a temp cwd, return broker + clients.
// ----------------------------------------------------------------------------

interface MsgFixture {
	cwd: string;
	runId: string;
	broker: CrewBroker;
	token: string;
	taskIds: string[];
	cleanup: () => Promise<void>;
}

async function makeMsgFixture(): Promise<MsgFixture> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-broker-msg-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{
			action: "run",
			config: { runtime: { mode: "scaffold" } },
			team: "fast-fix",
			goal: "broker msg integration",
		},
		{ cwd },
	);
	const runId = run.details.runId;
	if (!runId) throw new Error("scaffold run did not return a runId");
	const loaded = loadRunManifestById(cwd, runId);
	if (!loaded) throw new Error("could not load manifest for scaffold run");
	// fast-fix team has explorer + executor tasks. Reuse their ids as recipients.
	const taskIds = loaded.tasks.map((t) => t.id);
	if (taskIds.length < 2) throw new Error(`expected ≥2 tasks, got ${taskIds.length}`);

	const broker = new CrewBroker({
		sessionId: "msg-integration-" + Date.now(),
		socketPath: path.join(os.tmpdir(), `pi-crew-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`),
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

/** Connect a client + complete hello via a ping. Returns the live client. */
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
		// Compress the 1s hello deadline; mask unref so the test event loop
		// stays alive across the retry budget.
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
		throw new Error("client connect+ping failed: " + JSON.stringify(ping));
	}
	return client;
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test("messaging: DM from task A to task B — durable write + inbox returns the message", async () => {
	const fx = await makeMsgFixture();
	try {
		const [taskIdA, taskIdB] = fx.taskIds;
		const a = await connectClient({ runId: fx.runId, taskId: taskIdA, token: fx.token, socketPath: fx.broker.socketPath });
		const b = await connectClient({ runId: fx.runId, taskId: taskIdB, token: fx.token, socketPath: fx.broker.socketPath });
		try {
			const sendResult = await a.request("msg.send", {
				to: taskIdB,
				body: { text: "hello from A" },
				kind: "message",
				priority: "normal",
			});
			assert.equal(sendResult.ok, true, "msg.send should succeed: " + JSON.stringify(sendResult));
			if (sendResult.ok === true) {
			const v = sendResult.value as { messageId: string; recipientCount: number; durableStatus: string };
			assert.equal(v.recipientCount, 1);
			assert.equal(v.durableStatus, "ok");
			assert.ok(v.messageId.startsWith("msg_"));
		}
		const inboxResult = await b.request("msg.inbox", { limit: 100 });
			assert.equal(inboxResult.ok, true, "msg.inbox should succeed: " + JSON.stringify(inboxResult));
			if (inboxResult.ok === true) {
				const v = inboxResult.value as { messages: Array<{ id: string; from: string; to: string; body: string; kind: string }>; total: number };
				assert.equal(v.total, 1, "expected exactly 1 message in B's inbox");
				assert.equal(v.messages.length, 1);
				const msg = v.messages[0];
				assert.equal(msg.to, taskIdB);
				assert.equal(msg.from, taskIdA);
				assert.equal(msg.kind, "message");
				assert.equal(msg.body, JSON.stringify({ text: "hello from A" }));
			}
		} finally {
			await a.close();
			await b.close();
		}
	} finally {
		await fx.cleanup();
	}
});

test("messaging: durable write lands on disk (mailbox file contains body, never token)", async () => {
	const fx = await makeMsgFixture();
	try {
		const [taskIdA, taskIdB] = fx.taskIds;
		const a = await connectClient({ runId: fx.runId, taskId: taskIdA, token: fx.token, socketPath: fx.broker.socketPath });
		try {
			await a.request("msg.send", { to: taskIdB, body: { hello: "world" } });
			// Find any inbox.jsonl under the run stateRoot (task-targeted messages
			// land under tasks/<taskId>/inbox.jsonl; the exact task dir depends
			// on the scaffold team's task graph).
			const loaded = loadRunManifestById(fx.cwd, fx.runId)!;
			const stateRoot = loaded.manifest.stateRoot;
			const inboxFiles: string[] = [];
			const walk = (dir: string) => {
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, entry.name);
					if (entry.isDirectory()) walk(full);
					else if (entry.name === "inbox.jsonl") inboxFiles.push(full);
				}
			};
			walk(stateRoot);
			assert.ok(inboxFiles.length > 0, `expected at least one inbox.jsonl under ${stateRoot}`);
			const allContent = inboxFiles.map((f) => fs.readFileSync(f, "utf-8")).join("\n");
			assert.ok(allContent.includes("hello"), "body should be durable on disk");
			assert.ok(allContent.includes("world"), "body should be durable on disk");
			assert.ok(!allContent.includes(fx.token), "token must never reach mailbox files");
		} finally {
			await a.close();
		}
	} finally {
		await fx.cleanup();
	}
});

test("messaging: msg.send rejects oversize body (>256 KiB)", async () => {
	const fx = await makeMsgFixture();
	try {
		const [taskIdA, taskIdB] = fx.taskIds;
		const a = await connectClient({ runId: fx.runId, taskId: taskIdA, token: fx.token, socketPath: fx.broker.socketPath });
		try {
			const bigBody = "x".repeat(300 * 1024);
			const result = await a.request("msg.send", { to: taskIdB, body: { junk: bigBody } });
			assert.equal(result.ok, false);
			if (result.ok === false) {
				assert.equal(result.fallback, true);
				// The client may reject the frame client-side (encode-failed) if the
				// serialized request exceeds MAX_BROKER_FRAME_BYTES before it reaches
				// the wire, OR the broker may reject it server-side (oversize-frame).
				// Both are correct rejections of an oversize body.
				assert.ok(
					result.errorCode === "oversize-frame" || result.errorCode === "encode-failed",
					`expected oversize-frame or encode-failed, got ${result.errorCode}`,
				);
			}
		} finally {
			await a.close();
		}
	} finally {
		await fx.cleanup();
	}
});

test("messaging: msg.inbox on empty inbox returns total=0, hasMore=false", async () => {
	const fx = await makeMsgFixture();
	try {
		const taskIdB = fx.taskIds[1];
		const b = await connectClient({ runId: fx.runId, taskId: taskIdB, token: fx.token, socketPath: fx.broker.socketPath });
		try {
			const result = await b.request("msg.inbox", { limit: 100 });
			assert.equal(result.ok, true);
			if (result.ok === true) {
				const v = result.value as { messages: unknown[]; total: number; hasMore: boolean };
				assert.equal(v.total, 0);
				assert.equal(v.messages.length, 0);
				assert.equal(v.hasMore, false);
			}
		} finally {
			await b.close();
		}
	} finally {
		await fx.cleanup();
	}
});

test("messaging: broadcast 'all' reaches every task recipient", async () => {
	const fx = await makeMsgFixture();
	try {
		const taskIdA = fx.taskIds[0];
		const a = await connectClient({ runId: fx.runId, taskId: taskIdA, token: fx.token, socketPath: fx.broker.socketPath });
		try {
			const result = await a.request("msg.send", { to: "all", body: { broadcast: true } });
			assert.equal(result.ok, true, JSON.stringify(result));
			if (result.ok === true) {
				const v = result.value as { recipientCount: number };
				assert.equal(v.recipientCount, fx.taskIds.length, "broadcast should reach every task");
			}
		} finally {
			await a.close();
		}
	} finally {
		await fx.cleanup();
	}
});
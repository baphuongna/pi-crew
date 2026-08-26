/**
 * crew-broker-msg-worker.test.ts — D9 / §15.2 worker message role gate.
 *
 * Step 0 of Task 4 (loadout/nesting/messaging): workers may now call
 * `msg.send` (previously orchestrator-only) with exactly three constraints:
 *   1. `from` is ALWAYS overridden to `conn.taskId` (never a client-supplied
 *      value — no worker forgery).
 *   2. `to` is limited to `"parent"` (run-level orchestrator inbox), a valid
 *      sibling taskId from the manifest, or `"group"` (broadcast). Anything
 *      else → `forbidden`.
 *   3. `kind` is limited to `notify` | `message`.
 * Orchestrator role keeps its full prior privileges (including `"all"` /
 * arrays / steer kinds).
 *
 * Real socket + temp run dir (scaffold run, same fixture discipline as
 * delegate-broker.test.ts).
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { CrewBroker } from "../../../../src/runtime/broker/crew-broker.ts";
import { readMailbox } from "../../../../src/state/coordination/mailbox.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../../../src/utils/ndjson.ts";

function tempSocketPath(suffix: string): string {
	const tok = randomBytes(3).toString("hex");
	if (process.platform === "win32") return `\\\\.\\pipe\\pi-crew-msg-${tok}-${suffix}`;
	return path.join(os.tmpdir(), `pcw-${tok}-${suffix}.sock`);
}

interface RawClient {
	socket: net.Socket;
	decoder: NdjsonDecoder;
	closed: boolean;
	waitForFrame: (predicate: (frame: unknown) => boolean, timeoutMs?: number) => Promise<unknown>;
	close: () => void;
}

function rawConnect(socketPath: string): Promise<RawClient> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection(socketPath);
		const client: RawClient = {
			socket: sock,
			decoder: new NdjsonDecoder(),
			closed: false,
			waitForFrame: () => Promise.reject(new Error("not initialized")),
			close: () => {
				try {
					sock.destroy();
				} catch {
					/* ignore */
				}
			},
		};
		const pending: Array<{ resolve: (v: unknown) => void; predicate: (f: unknown) => boolean }> = [];
		client.waitForFrame = (predicate, timeoutMs = 2000) =>
			new Promise((res, rej) => {
				pending.push({ resolve: res, predicate });
				setTimeout(() => rej(new Error("waitForFrame: timeout")), timeoutMs).unref();
			});
		sock.on("data", (chunk: Buffer) => {
			let frames: unknown[];
			try {
				frames = client.decoder.push(chunk);
			} catch {
				return;
			}
			for (const f of frames) {
				const idx = pending.findIndex((p) => p.predicate(f));
				if (idx !== -1) pending.splice(idx, 1)[0].resolve(f);
			}
		});
		sock.on("error", () => {
			/* noop — close handler decides */
		});
		sock.on("close", () => {
			client.closed = true;
			for (const p of pending) p.resolve(undefined);
		});
		sock.once("connect", () => resolve(client));
		sock.once("error", (err) => reject(err));
	});
}

interface ScaffoldRun {
	cwd: string;
	runId: string;
	taskId: string;
	siblingTaskId: string;
}

async function scaffoldRunningTask(prefix: string): Promise<ScaffoldRun> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-msgw-${prefix}-`));
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: `msg-worker-${prefix}` },
		{ cwd },
	);
	const runId = run.details.runId!;
	const loaded = loadRunManifestById(cwd, runId)!;
	const task = loaded.tasks.find((t) => t.role === "executor") ?? loaded.tasks[0];
	const sibling = loaded.tasks.find((t) => t.id !== task.id) ?? loaded.tasks[0];
	const now = new Date().toISOString();
	const updatedTasks = loaded.tasks.map((t) => (t.id === task.id ? { ...t, status: "running" as const, startedAt: now, depth: 1 } : t));
	saveRunTasks(loaded.manifest, updatedTasks);
	saveRunManifest({ ...loaded.manifest, status: "running", updatedAt: now });
	return {
		cwd,
		runId,
		taskId: task.id,
		siblingTaskId: sibling.id === task.id ? `${task.id}_g2` : sibling.id,
	};
}

async function startBroker(opts: { cwd: string }): Promise<{ broker: CrewBroker; socketPath: string }> {
	const socketPath = tempSocketPath("msgw");
	const broker = new CrewBroker({
		sessionId: "session-msg-worker-test",
		socketPath,
		enabled: true,
		cwd: opts.cwd,
	});
	await broker.start();
	return { broker, socketPath };
}

async function hello(client: RawClient, runId: string, taskId: string, token: string): Promise<void> {
	client.socket.write(encodeBrokerFrame({ id: `hello-${taskId}`, method: "hello", params: { protocol: 1, runId, taskId, token } }));
	const ack = (await client.waitForFrame((f) => (f as { result?: { ok?: boolean } })?.result?.ok === true)) as unknown;
	assert.ok(ack, "hello must succeed");
}

interface SendResult {
	ok: boolean;
	result?: Record<string, unknown>;
	error?: { code: string; message: string };
}

function sendMsg(client: RawClient, params: Record<string, unknown>, id = "msg-1"): Promise<SendResult> {
	client.socket.write(encodeBrokerFrame({ id, method: "msg.send", params }));
	return client.waitForFrame((f) => {
		const frame = f as { id?: unknown; result?: unknown; error?: unknown };
		return frame.id === id && (frame.result !== undefined || frame.error !== undefined);
	}) as Promise<SendResult>;
}

test("worker msg.send to parent → ok (durable run-level inbox write)", async () => {
	const s = await scaffoldRunningTask("parent");
	const { broker, socketPath } = await startBroker({ cwd: s.cwd });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendMsg(client, { to: "parent", body: "milestone: parser done", kind: "notify" });
			assert.ok(res.result, `worker to:parent must succeed: ${JSON.stringify(res)}`);
			assert.equal(res.result!.recipientCount, 1);
			assert.equal(res.result!.durableStatus, "ok");
			// The message must land in the run-level inbox (taskId undefined),
			// which the orchestrator reads.
			const loaded = loadRunManifestById(s.cwd, s.runId)!;
			const inbox = readMailbox(loaded.manifest, "inbox");
			const sent = inbox.find((m) => m.from === s.taskId);
			assert.ok(sent, "run-level inbox must contain the worker message");
			assert.equal(sent!.kind, "notify");
			assert.equal(sent!.to, "parent");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("worker msg.send to invalid target → forbidden", async () => {
	const s = await scaffoldRunningTask("invalid");
	const { broker, socketPath } = await startBroker({ cwd: s.cwd });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendMsg(client, { to: "not-a-real-task", body: "nope" });
			assert.ok(res.error, `worker to:invalid must be rejected: ${JSON.stringify(res)}`);
			assert.equal(res.error!.code, "forbidden");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("worker msg.send honors from-override — from in params is ignored, from=taskId stored", async () => {
	const s = await scaffoldRunningTask("from");
	const { broker, socketPath } = await startBroker({ cwd: s.cwd });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			// Worker tries to forge `from` as another task — broker must override.
			const res = await sendMsg(client, { to: "parent", body: "forged?", from: "evil-task" });
			assert.ok(res.result, `worker msg.send must succeed: ${JSON.stringify(res)}`);
			const loaded = loadRunManifestById(s.cwd, s.runId)!;
			const inbox = readMailbox(loaded.manifest, "inbox");
			const sent = inbox.find((m) => m.from === s.taskId);
			assert.ok(sent, "run-level inbox must contain the worker message with real taskId");
			// The forged value must never appear as `from`.
			assert.ok(!inbox.some((m) => m.from === "evil-task"), "forged from must be ignored");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("worker msg.send to sibling taskId → ok (DM delivers to that task's inbox)", async () => {
	const s = await scaffoldRunningTask("dm");
	const { broker, socketPath } = await startBroker({ cwd: s.cwd });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendMsg(client, { to: s.siblingTaskId, body: "api shape: parseArgs(cmd)", kind: "message" });
			assert.ok(res.result, `worker DM must succeed: ${JSON.stringify(res)}`);
			assert.equal(res.result!.recipientCount, 1);
			const loaded = loadRunManifestById(s.cwd, s.runId)!;
			const siblingInbox = readMailbox(loaded.manifest, "inbox", s.siblingTaskId);
			const sent = siblingInbox.find((m) => m.from === s.taskId);
			assert.ok(sent, `sibling inbox must contain the DM (sibling=${s.siblingTaskId}, worker=${s.taskId})`);
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("worker msg.send to parent → appends worker.message run event (kind/subject only, never body)", async () => {
	const s = await scaffoldRunningTask("wakev");
	const { broker, socketPath } = await startBroker({ cwd: s.cwd });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendMsg(client, {
				to: "parent",
				body: "secret-body-milestone-parser-done",
				kind: "notify",
				subject: "parser milestone",
			});
			assert.ok(res.result, `worker to:parent must succeed: ${JSON.stringify(res)}`);
			const loaded = loadRunManifestById(s.cwd, s.runId)!;
			const lines = fs.readFileSync(loaded.manifest.eventsPath, "utf-8").trim().split("\n").filter(Boolean);
			const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
			const wake = events.filter((e) => e.type === "worker.message");
			assert.equal(wake.length, 1, "exactly one worker.message event must be appended");
			assert.equal(wake[0]!.runId, s.runId);
			assert.equal(wake[0]!.taskId, s.taskId, "taskId must be the sender");
			const data = wake[0]!.data as Record<string, unknown>;
			assert.equal(data.to, "parent");
			assert.equal(data.kind, "notify");
			assert.equal(data.subject, "parser milestone");
			assert.ok(!("body" in data), "event data must not carry the body");
			assert.ok(
				!lines.some((l) => l.includes("secret-body-milestone-parser-done")),
				"message body must never leak into the run event log",
			);
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("worker msg.send to parent → live orchestrator connection receives mailbox.message frame", async () => {
	const s = await scaffoldRunningTask("wakel");
	const { broker, socketPath } = await startBroker({ cwd: s.cwd });
	try {
		// Orchestrator-side connection: role comes from the orchestrator token.
		const orchToken = broker.issueOrchestratorToken(s.runId);
		const orch = await rawConnect(socketPath);
		const worker = await rawConnect(socketPath);
		try {
			await hello(orch, s.runId, "leader", orchToken);
			await hello(worker, s.runId, s.taskId, broker.issueRunToken(s.runId, s.taskId));
			// Arm the frame wait BEFORE sending: the broker's mailbox-append
			// observer fans out on a microtask, so the orchestrator frame can
			// hit the socket before the sender's ack does.
			const framePromise = orch.waitForFrame((f) => (f as { event?: string })?.event === "mailbox.message") as Promise<{
				data?: Record<string, unknown>;
			}>;
			const res = await sendMsg(worker, { to: "parent", body: "need decision on API shape", kind: "message" });
			assert.ok(res.result, `worker to:parent must succeed: ${JSON.stringify(res)}`);
			const frame = await framePromise;
			assert.ok(frame, "orchestrator conn must receive the live mailbox.message frame");
			assert.equal(frame.data!.to, "parent");
			assert.equal(frame.data!.from, s.taskId);
			assert.equal(frame.data!.kind, "message");
		} finally {
			orch.close();
			worker.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("worker DM to sibling does NOT append a worker.message event", async () => {
	const s = await scaffoldRunningTask("wakedm");
	const { broker, socketPath } = await startBroker({ cwd: s.cwd });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendMsg(client, { to: s.siblingTaskId, body: "dm body", kind: "message" });
			assert.ok(res.result, `worker DM must succeed: ${JSON.stringify(res)}`);
			const loaded = loadRunManifestById(s.cwd, s.runId)!;
			const lines = fs.readFileSync(loaded.manifest.eventsPath, "utf-8").trim().split("\n").filter(Boolean);
			const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
			assert.ok(
				!events.some((e) => e.type === "worker.message"),
				"worker.message event is reserved for to:'parent' wake — DMs must not emit it",
			);
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("worker msg.send with non-notify/message kind → bad-params", async () => {
	const s = await scaffoldRunningTask("kind");
	const { broker, socketPath } = await startBroker({ cwd: s.cwd });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendMsg(client, { to: "parent", body: "steer attempt", kind: "steer" });
			assert.ok(res.error, "worker steer kind must be rejected");
			assert.equal(res.error!.code, "bad-params");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

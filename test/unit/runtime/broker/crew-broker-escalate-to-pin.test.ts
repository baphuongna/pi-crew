/**
 * crew-broker-escalate-to-pin.test.ts — R2-L-A6 PIN (wave 8).
 *
 * Records the wave-2b fix: escalate's `to` is SENDER-CHOSEN and lands in a
 * mailbox record — an arbitrary value would let a worker address any task in
 * the run (spoofed follow-up routing). The handler must reject any `to`
 * outside the two identities the sender legitimately owns (its run, its own
 * taskId) with `bad-params` BEFORE the manifest load.
 *
 * Mutation check (2026-10-20): reverting the handler to accept `to`
 * unvalidated flips the foreign-`to` case from `bad-params` to the
 * manifest/mailbox path (error code `no-manifest`/`escalate-failed`) — these
 * tests fail. Restoring the check turns them green again.
 *
 * Harness mirrors crew-broker-handshake.test.ts: a REAL net server + raw
 * socket client; the run manifest is seeded on disk (createRunManifest +
 * saveRunManifest) so hello authenticates and a VALID `to` can proceed all
 * the way to the mailbox append (result frame `messageId`).
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { CrewBroker } from "../../../../src/runtime/broker/crew-broker.ts";
import { createRunManifest, saveRunManifest } from "../../../../src/state/stores/state-store.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../../../src/utils/ndjson.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

// ── harness (mirrors crew-broker-handshake.test.ts) ─────────────────────

function tempSocketPath(suffix: string): string {
	const tok = randomBytes(3).toString("hex");
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-crew-test-${tok}-${suffix}`;
	}
	return path.join(os.tmpdir(), `pch-${tok}-${suffix}.sock`);
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
		const pending: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void; predicate: (f: unknown) => boolean }> = [];
		client.waitForFrame = (predicate, timeoutMs = 2000) => {
			return new Promise((res, rej) => {
				pending.push({ resolve: res, reject: rej, predicate });
				const t = setTimeout(() => rej(new Error("waitForFrame: timeout")), timeoutMs);
				t.unref();
			});
		};
		sock.on("data", (chunk) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, "utf8");
			let frames: unknown[];
			try {
				frames = client.decoder.push(buf);
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

const team = {
	name: "default",
	description: "",
	roles: [{ name: "worker", agent: "worker" }],
	source: "test",
	filePath: "builtin",
} as never;

const workflow = {
	name: "default",
	description: "",
	steps: [{ id: "one", role: "worker" }],
	source: "test",
	filePath: "builtin",
} as never;

interface BrokerFixture {
	broker: CrewBroker;
	socketPath: string;
	runId: string;
	taskId: string;
	cleanup: () => Promise<void>;
}

async function startBrokerWithRun(): Promise<BrokerFixture> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-a6-"));
	const taskId = `task-a6-${randomBytes(3).toString("hex")}`;
	// Keep the factory's own runId/stateRoot — saveRunManifest honors
	// manifest.stateRoot while loadRunManifestById derives the path from
	// (cwd, runId); overriding either desyncs the two.
	const created = createRunManifest({ cwd: tmp, team, workflow, goal: "A6 escalate to-validation pin" });
	saveRunManifest(created.manifest);
	const runId = created.manifest.runId;
	const socketPath = tempSocketPath("a6");
	const broker = new CrewBroker({ sessionId: "session-a6", socketPath, enabled: true, cwd: tmp });
	await broker.start();
	return {
		broker,
		socketPath,
		runId,
		taskId,
		cleanup: async () => {
			await broker.stop();
			try {
				await removeDirWithRetry(tmp);
			} catch {
				/* best-effort */
			}
		},
	};
}

// ── tests ────────────────────────────────────────────────────────────────

test("A6 PIN: escalate with a foreign 'to' → bad-params (sender-chosen target rejected)", async () => {
	const fx = await startBrokerWithRun();
	try {
		const token = fx.broker.issueRunToken(fx.runId, fx.taskId);
		const client = await rawConnect(fx.socketPath);
		client.socket.write(
			encodeBrokerFrame({
				id: "hello-1",
				method: "hello",
				params: { protocol: 1, runId: fx.runId, taskId: fx.taskId, token },
			}),
		);
		await client.waitForFrame((f) => (f as { id?: string })?.id === "hello-1");
		client.socket.write(
			encodeBrokerFrame({ id: "esc-foreign", method: "escalate", params: { body: "question", to: "some-other-task-spoofed" } }),
		);
		const err = (await client.waitForFrame((f) => (f as { id?: string })?.id === "esc-foreign")) as {
			error?: { code?: string; message?: string };
		};
		assert.equal(err?.error?.code, "bad-params", `expected bad-params, got ${JSON.stringify(err)}`);
		assert.match(err?.error?.message ?? "", /must be this connection's run or task/);
		client.close();
	} finally {
		await fx.cleanup();
	}
});

test("A6 PIN: escalate with 'to' = own taskId → accepted (durable mailbox append)", async () => {
	const fx = await startBrokerWithRun();
	try {
		const token = fx.broker.issueRunToken(fx.runId, fx.taskId);
		const client = await rawConnect(fx.socketPath);
		client.socket.write(
			encodeBrokerFrame({
				id: "hello-2",
				method: "hello",
				params: { protocol: 1, runId: fx.runId, taskId: fx.taskId, token },
			}),
		);
		await client.waitForFrame((f) => (f as { id?: string })?.id === "hello-2");
		client.socket.write(encodeBrokerFrame({ id: "esc-own", method: "escalate", params: { body: "question", to: fx.taskId } }));
		const res = (await client.waitForFrame((f) => (f as { id?: string })?.id === "esc-own")) as {
			result?: { messageId?: string; to?: string; durable?: boolean };
			error?: { code?: string };
		};
		assert.equal(res?.error, undefined, `valid to=${fx.taskId} must pass validation, got ${JSON.stringify(res)}`);
		assert.equal(res?.result?.durable, true);
		assert.equal(res?.result?.to, fx.taskId);
		assert.ok(res?.result?.messageId, "mailbox append must return a messageId");
		client.close();
	} finally {
		await fx.cleanup();
	}
});

test("A6 PIN: escalate with 'to' = runId → accepted (default routing identity)", async () => {
	const fx = await startBrokerWithRun();
	try {
		const token = fx.broker.issueRunToken(fx.runId, fx.taskId);
		const client = await rawConnect(fx.socketPath);
		client.socket.write(
			encodeBrokerFrame({
				id: "hello-3",
				method: "hello",
				params: { protocol: 1, runId: fx.runId, taskId: fx.taskId, token },
			}),
		);
		await client.waitForFrame((f) => (f as { id?: string })?.id === "hello-3");
		client.socket.write(encodeBrokerFrame({ id: "esc-run", method: "escalate", params: { body: "question", to: fx.runId } }));
		const res = (await client.waitForFrame((f) => (f as { id?: string })?.id === "esc-run")) as {
			result?: { messageId?: string; to?: string; durable?: boolean };
			error?: { code?: string };
		};
		assert.equal(res?.error, undefined, `valid to=${fx.runId} must pass validation, got ${JSON.stringify(res)}`);
		assert.equal(res?.result?.to, fx.runId);
		client.close();
	} finally {
		await fx.cleanup();
	}
});

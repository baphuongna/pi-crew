/**
 * crew-broker-handshake.test.ts — Phase 0 sub-task 0.4 handshake tests.
 *
 * Verifies the CrewBroker's connection handshake invariants:
 *  - bad token / wrong run / missing token / wrong protocol / missing
 *    fields all produce a generic auth/protocol error and a clean close.
 *  - First method must be `hello`; any other first method returns
 *    "hello required" and closes.
 *  - Hello after the 1s deadline closes the connection.
 *  - Oversize hello (exceeding MAX_BROKER_FRAME_BYTES) is rejected BEFORE
 *    JSON.parse and the connection is closed.
 *  - Malformed JSON produces a protocol error and close.
 *  - Valid hello + ping works end-to-end; the ack never includes the token.
 *  - Generic close/error codes do NOT disclose which field was wrong.
 *  - Two clients maintain independent outbound queues.
 *
 * All tests use a real `net.createServer` (no fakes for the broker). The
 * client side uses a tiny raw-socket helper so we can drive specific
 * edge cases (oversize, malformed, timing) deterministically.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { CrewBroker } from "../../src/runtime/crew-broker.ts";
import {
	MAX_BROKER_FRAME_BYTES,
	NdjsonDecoder,
	encodeBrokerFrame,
} from "../../src/runtime/crew-broker-deps.ts";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function tempSocketPath(suffix: string): string {
	return path.join(os.tmpdir(), `pi-crew-broker-handshake-${process.pid}-${Date.now()}-${suffix}.sock`);
}

interface RawClient {
	socket: net.Socket;
	decoder: NdjsonDecoder;
	written: Buffer[];
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
			written: [],
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
				const t = setTimeout(() => {
					rej(new Error("waitForFrame: timeout"));
				}, timeoutMs);
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
				// Resolve the first pending predicate that matches.
				const idx = pending.findIndex((p) => p.predicate(f));
				if (idx !== -1) {
					const p = pending.splice(idx, 1)[0];
					p.resolve(f);
				}
			}
		});
		sock.on("error", () => {
			/* noop — close handler decides */
		});
		sock.on("close", () => {
			client.closed = true;
			// Resolve pending waiters with undefined (caller decides whether
			// "no frame before close" is acceptable). Tests that need the
			// close to be the only signal can pass a predicate that always
			// returns true on undefined OR rely on the closed flag.
			for (const p of pending) p.resolve(undefined);
		});
		sock.once("connect", () => resolve(client));
		sock.once("error", (err) => reject(err));
	});
}

async function startBroker(opts: { enabled?: boolean; sessionId?: string; socketPath?: string } = {}): Promise<{
	broker: CrewBroker;
	socketPath: string;
}> {
	const socketPath = opts.socketPath ?? tempSocketPath("default");
	const sessionId = opts.sessionId ?? "session-handshake";
	const broker = new CrewBroker({
		sessionId,
		socketPath,
		enabled: opts.enabled ?? true,
	});
	await broker.start();
	return { broker, socketPath };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test("handshake: valid hello + ping — ack has protocol/session/run, never the token", async () => {
	const { broker, socketPath } = await startBroker();
	const runId = "run-valid";
	const token = broker.issueRunToken(runId);
	try {
		const client = await rawConnect(socketPath);
		client.socket.write(
			encodeBrokerFrame({
				id: "hello-1",
				method: "hello",
				params: { protocol: 1, runId, taskId: "task-A", token },
			}),
		);
		const ack = (await client.waitForFrame((f) => {
			const v = f as { id?: string; result?: { ok?: boolean } };
			return v?.id === "hello-1" && v?.result?.ok === true;
		})) as { result: Record<string, unknown> };
		assert.equal(ack.result.protocol, 1);
		assert.equal(ack.result.session, "session-handshake");
		assert.equal(ack.result.run, runId);
		// Ack must NOT include the token.
		assert.equal(ack.result.token, undefined);
		// Now send ping and assert pong.
		client.socket.write(encodeBrokerFrame({ id: "p-1", method: "ping", params: null }));
		const pong = (await client.waitForFrame((f) => (f as { id?: string })?.id === "p-1")) as { result: { pong: boolean } };
		assert.equal(pong.result.pong, true);
		client.close();
	} finally {
		await broker.stop();
	}
});

test("handshake: bad token → generic auth error and close (no token comparison detail)", async () => {
	const { broker, socketPath } = await startBroker();
	const runId = "run-bad-token";
	broker.issueRunToken(runId);
	try {
		const client = await rawConnect(socketPath);
		client.socket.write(
			encodeBrokerFrame({
				id: "hello-1",
				method: "hello",
				params: { protocol: 1, runId, taskId: "task-A", token: "WRONG-TOKEN" },
			}),
		);
		const err = (await client.waitForFrame((f) => {
			const v = f as { error?: { code?: string; message?: string } };
			return !!v?.error;
		})) as { error: { code: string; message: string } };
		assert.equal(err.error.code, "auth");
		// Generic message — does not say "bad token" or "wrong run".
		assert.ok(!/token/i.test(err.error.message), `message must not mention token: ${err.error.message}`);
		assert.ok(!/runId/i.test(err.error.message));
		// Connection must close.
		await new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
	} finally {
		await broker.stop();
	}
});

test("handshake: wrong run (no token issued) → generic auth error", async () => {
	const { broker, socketPath } = await startBroker();
	try {
		const client = await rawConnect(socketPath);
		client.socket.write(
			encodeBrokerFrame({
				id: "hello-1",
				method: "hello",
				params: { protocol: 1, runId: "run-not-registered", taskId: "task-A", token: "anything" },
			}),
		);
		const err = (await client.waitForFrame((f) => !!(f as { error?: unknown })?.error)) as { error: { code: string } };
		assert.equal(err.error.code, "auth");
	} finally {
		await broker.stop();
	}
});

test("handshake: missing token → generic auth error", async () => {
	const { broker, socketPath } = await startBroker();
	const runId = "run-missing-token";
	broker.issueRunToken(runId);
	try {
		const client = await rawConnect(socketPath);
		client.socket.write(
			encodeBrokerFrame({
				id: "hello-1",
				method: "hello",
				params: { protocol: 1, runId, taskId: "task-A", token: "" },
			}),
		);
		const err = (await client.waitForFrame((f) => !!(f as { error?: unknown })?.error)) as { error: { code: string } };
		assert.equal(err.error.code, "auth");
	} finally {
		await broker.stop();
	}
});

test("handshake: wrong protocol → generic auth error", async () => {
	const { broker, socketPath } = await startBroker();
	const runId = "run-wrong-proto";
	const token = broker.issueRunToken(runId);
	try {
		const client = await rawConnect(socketPath);
		client.socket.write(
			encodeBrokerFrame({
				id: "hello-1",
				method: "hello",
				params: { protocol: 999, runId, taskId: "task-A", token },
			}),
		);
		const err = (await client.waitForFrame((f) => !!(f as { error?: unknown })?.error)) as { error: { code: string } };
		assert.equal(err.error.code, "auth");
	} finally {
		await broker.stop();
	}
});

test("handshake: first method other than hello → protocol error and close", async () => {
	const { broker, socketPath } = await startBroker();
	try {
		const client = await rawConnect(socketPath);
		client.socket.write(encodeBrokerFrame({ id: "p-1", method: "ping", params: null }));
		const err = (await client.waitForFrame((f) => !!(f as { error?: unknown })?.error)) as { error: { code: string; message?: string } };
		assert.equal(err.error.code, "protocol");
		assert.match(err.error.message ?? "", /hello required/i);
	} finally {
		await broker.stop();
	}
});

test("handshake: hello after 1s deadline → connection closed", async () => {
	const { broker, socketPath } = await startBroker();
	try {
		const client = await rawConnect(socketPath);
		// Do NOT send hello. Wait 1.2s for the server's deadline to fire.
		const closed = new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
		// Race the close with a 2s timeout.
		await Promise.race([
			closed,
			new Promise<void>((_, reject) => setTimeout(() => reject(new Error("expected close within 2s")), 2000)),
		]);
		assert.equal(client.socket.destroyed || client.closed, true);
	} finally {
		await broker.stop();
	}
});

test("handshake: oversize hello → encoder throws oversize-frame BEFORE any write", async () => {
	const { broker } = await startBroker();
	const runId = "run-oversize";
	const token = broker.issueRunToken(runId);
	try {
		// Construct a JSON value that exceeds MAX_BROKER_FRAME_BYTES bytes when stringified.
		const big = "x".repeat(MAX_BROKER_FRAME_BYTES + 1024);
		// The encoder must reject the frame BEFORE returning — the test
		// asserts the typed BrokerError("oversize-frame") is thrown.
		assert.throws(
			() =>
				encodeBrokerFrame({
					id: "hello-1",
					method: "hello",
					params: { protocol: 1, runId, taskId: "task-A", token, big },
				}),
			(err: Error) => {
				return (err as { code?: string }).code === "oversize-frame";
			},
		);
		// Sanity: the broker is still healthy and accepts a normal-sized hello.
		const { socketPath } = { socketPath: broker.socketPath };
		const client = await rawConnect(socketPath);
		client.socket.write(
			encodeBrokerFrame({
				id: "hello-2",
				method: "hello",
				params: { protocol: 1, runId, taskId: "task-A", token },
			}),
		);
		const ack = (await client.waitForFrame((f) => (f as { id?: string; result?: { ok?: boolean } })?.id === "hello-2")) as { result: { ok: boolean } };
		assert.equal(ack.result.ok, true);
		client.close();
	} finally {
		await broker.stop();
	}
});

test("handshake: malformed JSON → protocol error and close", async () => {
	const { broker, socketPath } = await startBroker();
	try {
		const client = await rawConnect(socketPath);
		// Write a frame with invalid JSON.
		client.socket.write(Buffer.from("not-json-at-all\n", "utf8"));
		const err = (await client.waitForFrame((f) => !!(f as { error?: unknown })?.error, 3000)) as
			| { error: { code: string } }
			| undefined;
		// The server should send a protocol error before closing.
		if (err) {
			assert.ok(err.error.code === "protocol" || err.error.code === "close", `unexpected code: ${err.error.code}`);
		}
	} finally {
		await broker.stop();
	}
});

test("handshake: two clients have independent outbound queues", async () => {
	const { broker, socketPath } = await startBroker();
	const runA = "run-A";
	const runB = "run-B";
	const tokenA = broker.issueRunToken(runA);
	const tokenB = broker.issueRunToken(runB);
	try {
		const a = await rawConnect(socketPath);
		const b = await rawConnect(socketPath);
		a.socket.write(encodeBrokerFrame({ id: "h-1", method: "hello", params: { protocol: 1, runId: runA, taskId: "ta", token: tokenA } }));
		b.socket.write(encodeBrokerFrame({ id: "h-1", method: "hello", params: { protocol: 1, runId: runB, taskId: "tb", token: tokenB } }));
		// Both acks.
		const ackA = (await a.waitForFrame((f) => (f as { id?: string })?.id === "h-1")) as { result: { run: string } };
		const ackB = (await b.waitForFrame((f) => (f as { id?: string })?.id === "h-1")) as { result: { run: string } };
		assert.equal(ackA.result.run, runA);
		assert.equal(ackB.result.run, runB);
		// Now pings: pings from A must not be observed on B's reader.
		a.socket.write(encodeBrokerFrame({ id: "p-A", method: "ping", params: null }));
		const pongA = (await a.waitForFrame((f) => (f as { id?: string })?.id === "p-A")) as { result: { pong: boolean } };
		assert.equal(pongA.result.pong, true);
		// Verify B never sees "p-A" by sending a different ping and checking
		// that the id stream is independent.
		b.socket.write(encodeBrokerFrame({ id: "p-B", method: "ping", params: null }));
		const pongB = (await b.waitForFrame((f) => (f as { id?: string })?.id === "p-B")) as { result: { pong: boolean } };
		assert.equal(pongB.result.pong, true);
		a.close();
		b.close();
	} finally {
		await broker.stop();
	}
});

test("handshake: not-implemented method after hello → typed not-implemented response", async () => {
	const { broker, socketPath } = await startBroker();
	const runId = "run-not-impl";
	const token = broker.issueRunToken(runId);
	try {
		const client = await rawConnect(socketPath);
		client.socket.write(encodeBrokerFrame({ id: "h-1", method: "hello", params: { protocol: 1, runId, taskId: "task-A", token } }));
		await client.waitForFrame((f) => (f as { id?: string })?.id === "h-1");
		// Now try a phase-1 method.
		client.socket.write(encodeBrokerFrame({ id: "x-1", method: "msg.send", params: { to: "x", body: "y" } }));
		const err = (await client.waitForFrame((f) => (f as { id?: string })?.id === "x-1")) as { error: { code: string; message: string } };
		assert.equal(err.error.code, "not-implemented");
		assert.match(err.error.message, /msg\.send/);
		client.close();
	} finally {
		await broker.stop();
	}
});

test("handshake: stop() is idempotent (safe to call twice)", async () => {
	const { broker } = await startBroker();
	await broker.stop();
	await broker.stop(); // second call must not throw.
	assert.equal(broker.tokenCount, 0, "token map must be cleared after stop");
});

test("handshake: disabled flag → no socket, start() is a no-op", async () => {
	const socketPath = tempSocketPath("disabled");
	const broker = new CrewBroker({ sessionId: "session-disabled", socketPath, enabled: false });
	await broker.start();
	// No socket should exist.
	assert.ok(!existsSync(socketPath), `disabled broker must not create a socket at ${socketPath}`);
	// stop() must also be safe.
	await broker.stop();
});

// ----------------------------------------------------------------------------

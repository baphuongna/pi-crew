/**
 * crew-broker-wait-status-cache.test.ts — R10-3 unit tests.
 *
 * Covers the mtime+size-gated parse cache behind task.waitStatus:
 *  (a) N concurrent waiters polling a NEVER-changing manifest do not cause
 *      N×polls parses — the loader (loadRunManifestById) runs at most twice
 *      (initial + final), instrumented via an injected loader spy.
 *  (b) A status change on disk wakes all waiters within ~1 poll and they
 *      observe the new status (identical observable behavior vs uncached).
 *  (c) The per-run cache entry is evicted when the run's last connection
 *      closes (bounded Map across runs).
 *
 * Uses a real net server (same harness style as crew-broker-handshake.test.ts)
 * and a real run dir created via the state-store public API.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { CrewBroker } from "../../../../src/runtime/broker/crew-broker.ts";
import { WaitStatusCache } from "../../../../src/runtime/broker/wait-status-cache.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../../../src/utils/ndjson.ts";

// ----------------------------------------------------------------------------
// Fixture literals (same `as never` pattern as heartbeat-watcher.test.ts)
// ----------------------------------------------------------------------------

const team = {
	name: "t",
	description: "",
	source: "test",
	filePath: "t",
	roles: [{ name: "r", agent: "a" }],
} as never;

const workflow = {
	name: "w",
	description: "",
	source: "test",
	filePath: "w",
	steps: [{ id: "s", role: "r", task: "x" }],
} as never;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function tempSocketPath(suffix: string): string {
	// Short path: macOS sun_path budget is 104 bytes; Windows needs a named
	// pipe (see crew-broker-handshake.test.ts).
	const tok = randomBytes(3).toString("hex");
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-crew-test-wsc-${tok}-${suffix}`;
	}
	return path.join(os.tmpdir(), `pc-wsc-${tok}-${suffix}.sock`);
}

interface RawClient {
	socket: net.Socket;
	decoder: NdjsonDecoder;
	closed: boolean;
	write: (frame: unknown) => void;
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
			write: (frame) => sock.write(encodeBrokerFrame(frame)),
			waitForFrame: () => Promise.reject(new Error("not initialized")),
			close: () => {
				try {
					sock.destroy();
				} catch {
					/* ignore */
				}
			},
		};
		const pending: Array<{ resolve: (v: unknown) => void; predicate: (f: unknown) => boolean; timer: NodeJS.Timeout }> = [];
		client.waitForFrame = (predicate, timeoutMs = 5000) =>
			new Promise((res, rej) => {
				const timer = setTimeout(() => rej(new Error("waitForFrame: timeout")), timeoutMs);
				timer.unref();
				pending.push({ resolve: res, predicate, timer });
			});
		const drain = (frames: unknown[]) => {
			for (const f of frames) {
				const idx = pending.findIndex((p) => p.predicate(f));
				if (idx !== -1) {
					const p = pending.splice(idx, 1)[0];
					clearTimeout(p.timer);
					p.resolve(f);
				}
			}
		};
		sock.on("data", (chunk) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, "utf8");
			try {
				drain(client.decoder.push(buf));
			} catch {
				/* ignore malformed */
			}
		});
		sock.on("error", () => {
			/* close handler decides */
		});
		sock.on("close", () => {
			client.closed = true;
			for (const p of pending) {
				clearTimeout(p.timer);
				p.resolve(undefined);
			}
		});
		sock.once("connect", () => resolve(client));
		sock.once("error", (err) => reject(err));
	});
}

interface WaitFixture {
	cwd: string;
	runId: string;
	taskId: string;
	manifest: ReturnType<typeof createRunManifest>["manifest"];
	tasks: ReturnType<typeof createRunManifest>["tasks"];
	cache: WaitStatusCache;
	loaderCalls: () => number;
	broker: CrewBroker;
	socketPath: string;
	cleanup: () => Promise<void>;
}

async function makeWaitFixture(): Promise<WaitFixture> {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wsc-"));
	// Canonicalize to long-name form (Windows 8.3) matching production code.
	try {
		const r = fs.realpathSync.native(cwd);
		cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		/* keep as-is */
	}
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	const created = createRunManifest({ cwd, team, workflow, goal: "wait-status cache test" });
	// Park the task in "running" so waiters for "completed" keep polling.
	const tasks = created.tasks.map((t) => ({ ...t, status: "running" as const }));
	saveRunTasks(created.manifest, tasks);

	let calls = 0;
	const cache = new WaitStatusCache({
		loader: (c: string, runId: string) => {
			calls += 1;
			return loadRunManifestById(c, runId);
		},
	});
	const socketPath = tempSocketPath("fx");
	const broker = new CrewBroker({
		sessionId: "wsc-" + Date.now(),
		socketPath,
		enabled: true,
		cwd,
		waitStatusCache: cache,
	});
	await broker.start();
	const cleanup = async () => {
		try {
			await broker.stop();
		} catch {
			/* ignore */
		}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	};
	return {
		cwd,
		runId: created.manifest.runId,
		taskId: created.tasks[0].id,
		manifest: created.manifest,
		tasks,
		cache,
		loaderCalls: () => calls,
		broker,
		socketPath,
		cleanup,
	};
}

interface WaitOutcome {
	taskId: string;
	status: string;
	waitedMs: number;
}

async function connectAndWait(
	fx: WaitFixture,
	reqId: string,
	timeoutMs: number,
): Promise<{ client: RawClient; outcome: Promise<WaitOutcome | { error: { code: string; message: string } }> }> {
	const client = await rawConnect(fx.socketPath);
	const token = fx.broker.issueRunToken(fx.runId);
	client.write({ id: `${reqId}-hello`, method: "hello", params: { protocol: 1, runId: fx.runId, taskId: fx.taskId, token } });
	const ack = (await client.waitForFrame((f) => (f as { id?: string })?.id === `${reqId}-hello`)) as {
		result?: { ok?: boolean };
	};
	assert.equal(ack?.result?.ok, true, "hello must succeed");
	client.write({ id: reqId, method: "task.waitStatus", params: { taskId: fx.taskId, until: "completed", timeoutMs } });
	const outcome = client
		.waitForFrame((f) => (f as { id?: string })?.id === reqId)
		.then((frame) => {
			const v = frame as { id?: string; result?: WaitOutcome; error?: { code: string; message: string } };
			assert.ok(v && (v.result || v.error), `expected result or error frame, got ${JSON.stringify(frame)}`);
			return v.result ? v.result : { error: v.error! };
		});
	return { client, outcome };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test("R10-3 (a): N waiters polling a never-changing manifest → loader runs ≤2, not N×polls", async () => {
	const fx = await makeWaitFixture();
	try {
		const N = 5;
		const waiters: Array<{ client: RawClient; outcome: Promise<WaitOutcome | { error: { code: string } }> }> = [];
		for (let i = 0; i < N; i++) {
			waiters.push(await connectAndWait(fx, `w-${i}`, 1000));
		}
		// Every waiter must hit the bounded timeout — this proves each poll
		// loop actually ran its ticks (~5 per waiter at 200ms over 1000ms),
		// i.e. ~25+ cache.load calls happened behind a single parse.
		const outcomes = await Promise.all(waiters.map((w) => w.outcome));
		for (const o of outcomes) {
			assert.ok("error" in o, `expected wait-timeout, got ${JSON.stringify(o)}`);
			assert.equal((o as { error: { code: string } }).error.code, "wait-timeout");
		}
		// The core assertion: stat-gating collapsed N×ticks into ≤2 loads
		// (initial + at most one final) instead of one parse per tick.
		const calls = fx.loaderCalls();
		assert.ok(calls <= 2, `expected ≤2 loader calls for a never-changing manifest, got ${calls}`);
		assert.ok(calls >= 1, "expected at least the initial load");
		// One shared entry per run on the broker instance.
		assert.equal(fx.cache.size, 1, "all waiters must share one cache entry per runId");
		for (const w of waiters) w.client.close();
	} finally {
		await fx.cleanup();
	}
});

test("R10-3 (b): status change on disk wakes waiters within ~1 poll with the new status", async () => {
	const fx = await makeWaitFixture();
	try {
		const N = 3;
		const waiters = [];
		for (let i = 0; i < N; i++) {
			waiters.push(await connectAndWait(fx, `w-${i}`, 5000));
		}
		// Let at least one poll tick pass with the old status, then flip the
		// task to "completed" on disk (atomic write → mtime bump).
		await new Promise<void>((res) => setTimeout(res, 500));
		const before = fx.loaderCalls();
		saveRunTasks(
			fx.manifest,
			fx.tasks.map((t) => (t.id === fx.taskId ? { ...t, status: "completed" as const } : t)),
		);
		const results = await Promise.all(waiters.map((w) => w.outcome));
		for (const r of results) {
			assert.ok(!("error" in r), `waiter should have resolved, got ${JSON.stringify(r)}`);
			const o = r as WaitOutcome;
			assert.equal(o.taskId, fx.taskId);
			assert.equal(o.status, "completed", "waiter must observe the NEW status from disk");
			// Wake happened well before the 5000ms timeout, i.e. within ~1-2
			// polls of the 500ms flip, not via timeout.
			assert.ok(o.waitedMs >= 400 && o.waitedMs <= 2500, `waitedMs out of the ~1-poll band: ${o.waitedMs}`);
		}
		// Exactly one extra reload served the change to all N waiters.
		const after = fx.loaderCalls();
		assert.ok(after - before >= 1 && after - before <= 3, `expected 1-3 reloads around the change, got ${after - before}`);
		// A post-resolution load is a pure cache hit (no further parses).
		const settled = fx.loaderCalls();
		const loaded = fx.cache.load(fx.cwd, fx.runId);
		assert.ok(loaded, "post-resolution load must succeed");
		assert.equal(loaded!.tasks.find((t) => t.id === fx.taskId)?.status, "completed");
		assert.equal(fx.loaderCalls(), settled, "unchanged stamp must NOT trigger another load");
		for (const w of waiters) w.client.close();
	} finally {
		await fx.cleanup();
	}
});

test("R10-3 (c): run's cache entry is evicted when its last connection closes", async () => {
	const fx = await makeWaitFixture();
	try {
		const w = await connectAndWait(fx, "w-evict", 400);
		await w.outcome; // wait-timeout
		assert.equal(fx.cache.size, 1, "entry present while a connection exists");
		w.client.close();
		// Connection teardown is async — poll briefly for the eviction.
		const deadline = Date.now() + 2000;
		while (fx.cache.size > 0 && Date.now() < deadline) {
			await new Promise<void>((res) => setTimeout(res, 25));
		}
		assert.equal(fx.cache.size, 0, "entry must be evicted after the run's last connection closes");
	} finally {
		await fx.cleanup();
	}
});

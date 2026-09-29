/**
 * crew-broker-lock-contention.test.ts — RR-023 F4 (2026-09-29 full battery).
 *
 * Binding evidence: direct-agent ASYNC runs (team_20260929041005_f562184daea6f660
 * ask-probe, team_20260929041020_f0240ba3c047f4e6 delegate-probe) failed with
 * code=close within ~5ms while the detached runner (a SEPARATE process) held
 * run.lock persisting task state. The broker's wait/delegate handlers ran their
 * state RMW inside withRunLockSync; acquireLockWithRetry throws IMMEDIATELY on a
 * live holder (locks.ts:439-469, canSteal=false → throw), the throw escaped
 * handleData → closeConnection → the worker's ask/delegate surface died with
 * the untyped socket close. The SYNC foreground run (team_20260929041427…) was
 * the control: in-process serialization, zero contention.
 *
 * Contract pinned here:
 *  1. wait.request under a live run.lock holder → typed `busy` error frame
 *     (NOT a connection close) + the connection survives (ping still answers).
 *  2. wait.request while the holder releases within the retry budget → the
 *     park SUCCEEDS (retry absorbs the transient hold; no worker-visible error).
 *  3. delegate.request under a live holder → typed `busy` error frame + a
 *     delegate.rejected(reason=run-lock-busy) event (never silent) + the
 *     connection survives.
 *
 * The live cross-process holder is simulated exactly the way production sees
 * it: a FRESH run.lock file carrying an ALIVE pid. The sync acquire path uses
 * treatOwnPidAsStealable=false (locks.ts), so an alive holder is never stolen —
 * acquireLockWithRetry reproduces the production throw verbatim.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { CrewBroker } from "../../../../src/runtime/broker/crew-broker.ts";
import type { TeamEvent } from "../../../../src/state/event-log/event-log.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../../../src/utils/ndjson.ts";
import { teardownCwd } from "../../../fixtures/teardown-cwd.ts";

// ----------------------------------------------------------------------------
// Helpers (discipline of wait-request-broker.test.ts / delegate-broker.test.ts)
// ----------------------------------------------------------------------------

function tempSocketPath(suffix: string): string {
	const tok = randomBytes(3).toString("hex");
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-crew-test-${tok}-${suffix}`;
	}
	return path.join(os.tmpdir(), `lbc-${tok}-${suffix}.sock`);
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
		client.waitForFrame = (predicate, timeoutMs = 3000) =>
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
	stateRoot: string;
	eventsPath: string;
}

/** Scaffold run with the executor task flipped to running (same fixture
 *  discipline as wait-request-broker.test.ts; depth:1 like delegate-broker). */
async function scaffoldRunningTask(prefix: string): Promise<ScaffoldRun> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-lbc-${prefix}-`));
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: `lock-contention-${prefix}` },
		{ cwd },
	);
	const runId = run.details.runId!;
	const loaded = loadRunManifestById(cwd, runId)!;
	const executor = loaded.tasks.find((t) => t.role === "executor") ?? loaded.tasks[0];
	const now = new Date().toISOString();
	const updatedTasks = loaded.tasks.map((t) =>
		t.id === executor.id ? { ...t, status: "running" as const, startedAt: now, depth: 1 } : t,
	);
	saveRunTasks(loaded.manifest, updatedTasks);
	saveRunManifest({ ...loaded.manifest, status: "running", updatedAt: now }, { allowTerminalExit: true });
	return { cwd, runId, taskId: executor.id, stateRoot: loaded.manifest.stateRoot, eventsPath: loaded.manifest.eventsPath };
}

/** Simulate the production failure precondition: a run.lock held by a LIVE
 *  process (fresh createdAt + alive pid). acquireLockWithRetry's sync path
 *  (treatOwnPidAsStealable=false) never steals this — it throws
 *  `Run 'run.lock' is locked by another operation.` exactly like a live
 *  detached runner persisting task state. */
function holdRunLock(stateRoot: string): string {
	const lockPath = path.join(stateRoot, "run.lock");
	fs.mkdirSync(stateRoot, { recursive: true });
	fs.writeFileSync(lockPath, JSON.stringify({ kind: "run", pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() }));
	return lockPath;
}

async function startBroker(opts: {
	cwd: string;
	waitMethodsEnabled?: boolean;
	nestingEnabled?: boolean;
	lockBusyRetryDelaysMs?: readonly number[];
}): Promise<{ broker: CrewBroker; socketPath: string }> {
	const socketPath = tempSocketPath("lbc");
	const broker = new CrewBroker({
		sessionId: "session-lock-contention-test",
		socketPath,
		enabled: true,
		cwd: opts.cwd,
		...(opts.waitMethodsEnabled === undefined ? {} : { waitMethodsEnabled: opts.waitMethodsEnabled }),
		...(opts.nestingEnabled === undefined ? {} : { nestingEnabled: opts.nestingEnabled }),
		...(opts.nestingEnabled === undefined ? {} : { nestingTrustedEscalation: opts.nestingEnabled === true }),
		...(opts.lockBusyRetryDelaysMs ? { lockBusyRetryDelaysMs: opts.lockBusyRetryDelaysMs } : {}),
	});
	await broker.start();
	return { broker, socketPath };
}

async function hello(client: RawClient, runId: string, taskId: string, token: string): Promise<void> {
	client.socket.write(encodeBrokerFrame({ id: "hello-1", method: "hello", params: { protocol: 1, runId, taskId, token } }));
	const ack = (await client.waitForFrame((f) => (f as { id?: string })?.id === "hello-1")) as {
		result?: { ok?: boolean };
		error?: { code: string };
	};
	assert.ok(ack?.result?.ok === true, `hello must succeed: ${JSON.stringify(ack)}`);
}

interface ResponseFrame {
	id?: string;
	result?: Record<string, unknown>;
	error?: { code: string; message: string };
}

async function request(client: RawClient, method: string, params: Record<string, unknown>, id: string): Promise<ResponseFrame | undefined> {
	client.socket.write(encodeBrokerFrame({ id, method, params }));
	return (await client.waitForFrame((f) => (f as { id?: string })?.id === id)) as ResponseFrame | undefined;
}

/** Prove the connection SURVIVED the contention (the pre-fix failure killed
 *  the socket — a follow-up ping must still answer). */
async function assertConnectionAlive(client: RawClient, label: string): Promise<void> {
	assert.equal(client.closed, false, `${label}: socket must not be closed`);
	const pong = await request(client, "ping", {}, `ping-${randomUUID().slice(0, 8)}`);
	assert.ok(pong?.result?.pong === true, `${label}: ping must answer after contention (${JSON.stringify(pong)})`);
}

function parseEvents(eventsPath: string): TeamEvent[] {
	return fs
		.readFileSync(eventsPath, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as TeamEvent);
}

async function readEventsUntil(eventsPath: string, until: (events: TeamEvent[]) => boolean): Promise<TeamEvent[]> {
	const deadline = Date.now() + 2500;
	for (;;) {
		const events = parseEvents(eventsPath);
		if (until(events)) return events;
		if (Date.now() > deadline) return events;
		await new Promise((r) => setTimeout(r, 25));
	}
}

// ----------------------------------------------------------------------------

test("wait.request under a live run.lock holder: typed busy error, connection survives", async () => {
	const s = await scaffoldRunningTask("waitbusy");
	const { broker, socketPath } = await startBroker({
		cwd: s.cwd,
		waitMethodsEnabled: true,
		// Fast budget: one quick retry, then busy — keeps the test fast while
		// pinning the CONTRACT (typed busy, never a connection kill).
		lockBusyRetryDelaysMs: [10],
	});
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			holdRunLock(s.stateRoot);
			const res = await request(client, "wait.request", { to: s.taskId, question: "blocked?", timeoutSec: 30 }, "wr-1");
			// Pre-fix: the contention throw killed the connection — res is
			// undefined (waitForFrame resolves undefined on close). Post-fix: a
			// typed busy frame must arrive.
			assert.ok(res, "wait.request must answer with an error frame, not a connection close");
			assert.ok(res.error, "contended wait.request must fail");
			assert.equal(res.error!.code, "busy");
			assert.match(res.error!.message, /run\.lock|busy/i);
			await assertConnectionAlive(client, "waitbusy");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		teardownCwd(s.cwd);
	}
});

test("wait.request succeeds when the run.lock holder releases within the retry budget", async () => {
	const s = await scaffoldRunningTask("waitlate");
	// DEFAULT retry schedule (50/100/200/400/800ms) — no override.
	const { broker, socketPath } = await startBroker({ cwd: s.cwd, waitMethodsEnabled: true });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const lockPath = holdRunLock(s.stateRoot);
			// Release after 120ms — inside the default retry budget. The park
			// must SUCCEED (the retry absorbs the transient hold).
			const release = setTimeout(() => {
				try {
					fs.rmSync(lockPath, { force: true });
				} catch {
					/* ignore */
				}
			}, 120);
			release.unref?.();
			const res = await request(client, "wait.request", { to: s.taskId, question: "late?", timeoutSec: 30 }, "wr-2");
			assert.ok(res, "wait.request must answer, not close the connection");
			assert.ok(res!.result?.ok === true, `wait.request must park after the holder releases: ${JSON.stringify(res)}`);
			assert.equal(typeof res!.result!.questionId, "string");
			await assertConnectionAlive(client, "waitlate");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		teardownCwd(s.cwd);
	}
});

test("delegate.request under a live run.lock holder: typed busy error + rejected event, connection survives", async () => {
	const s = await scaffoldRunningTask("dlgbusy");
	const { broker, socketPath } = await startBroker({
		cwd: s.cwd,
		nestingEnabled: true,
		lockBusyRetryDelaysMs: [10],
	});
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			holdRunLock(s.stateRoot);
			const res = await request(client, "delegate.request", { prompt: "do work", role: "explorer" }, "dlg-1");
			assert.ok(res, "delegate.request must answer with an error frame, not a connection close");
			assert.ok(res.error, "contended delegate.request must fail");
			assert.equal(res.error!.code, "busy");
			assert.match(res.error!.message, /run\.lock|busy/i);
			await assertConnectionAlive(client, "dlgbusy");
			// Never silent: the busy degradation must be recorded in events.jsonl
			// (same discipline as every other delegate.rejected path).
			const events = await readEventsUntil(s.eventsPath, (evts) =>
				evts.some((e) => e.type === "delegate.rejected" && e.data?.reason === "run-lock-busy"),
			);
			const rej = events.find((e) => e.type === "delegate.rejected" && e.data?.reason === "run-lock-busy");
			assert.ok(rej, "delegate.rejected(reason=run-lock-busy) must be recorded in events.jsonl");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		teardownCwd(s.cwd);
	}
});

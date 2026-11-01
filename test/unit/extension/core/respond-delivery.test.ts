/**
 * respond-delivery.test.ts — HƯỚNG A (ADR Option 3, run
 * team_20261101000805_8fe294ff11954460, 2026-11-01): the respond-side
 * `deliverResponseRow` seam (src/extension/team-tool/respond-delivery.ts).
 *
 * Contract under test (broker-first, local fallback — hướng C preserved):
 *  - Broker path: the responder IS the dispatcher (manifest.dispatcherVerifyKey
 *    === this process's public key) and the broker socket is derivable from
 *    manifest.sessionId → respond.challenge → respond.append on ONE
 *    connection → the BROKER-SIGNED row is used (no local append).
 *  - Precheck skip: a responder whose keypair is NOT the manifest dispatcher
 *    (restarted leader / foreign session — hướng C gap 1) skips the broker
 *    CR entirely (its signature could never verify against the binding) and
 *    appends locally signed (C behavior).
 *  - Any broker failure (socket absent, CR reject) → warn log scope
 *    `respond.broker-delivery-fallback` + local signed idempotent append.
 *  - Lock safety: the broker's respond.force park gate runs under
 *    withRunLockBusyRetry — a LIVE cross-process run.lock holder yields a
 *    typed `busy` error frame in bounded time (never a hang/close), and the
 *    append succeeds once the lock is released.
 *
 * INERT-READER LESSON (mandated): every delivery-side read runs with
 * PI_CREW_MAILBOX_VERIFY_KEY (singular) set to the broker host's public key.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { deliverResponseRow, type RespondDeliveryRow } from "../../../../src/extension/team-tool/respond-delivery.ts";
import { CrewBroker } from "../../../../src/runtime/broker/crew-broker.ts";
import {
	COORDINATION_VERIFY_KEY_ENV,
	COORDINATION_VERIFY_KEYS_ENV,
	getMailboxVerifyKeyPublic,
	readMailbox,
	verifyMailboxRowSig,
} from "../../../../src/state/coordination/mailbox.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../../../src/utils/ndjson.ts";
import { getBrokerSocketPath } from "../../../../src/utils/socket-path.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { restoreEnv, snapshotEnv } from "../../../fixtures/test-env-helpers.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const TEAM: TeamConfig = {
	name: "respond-delivery",
	description: "hướng A respond-delivery tests",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "executor", description: "worker role" }],
};

const WORKFLOW: WorkflowConfig = {
	name: "respond-delivery-flow",
	description: "single step",
	source: "builtin",
	filePath: "builtin",
	steps: [{ id: "one", role: "worker", task: "exercise deliverResponseRow" }],
};

interface DeliveryFixture {
	cwd: string;
	manifest: TeamRunManifest;
	taskId: string;
	taskInbox: string;
	socketPath: string;
	broker: CrewBroker | null;
	brokerPub: string;
	park: (questionId: string) => void;
	stop: () => Promise<void>;
}

async function scaffold(opts: { dispatcherVerifyKey?: string; startBroker?: boolean; brokerBoundKey?: string }): Promise<DeliveryFixture> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-respond-delivery-"));
	const created = createRunManifest({
		cwd,
		team: TEAM,
		workflow: WORKFLOW,
		goal: "hướng A deliverResponseRow",
		dispatcherVerifyKey: opts.dispatcherVerifyKey,
	});
	saveRunManifest(created.manifest);
	const manifest = created.manifest;
	const taskId = created.tasks[0]!.id;
	saveRunTasks(manifest, created.tasks);
	const park = (questionId: string): void => {
		const now = new Date().toISOString();
		saveRunTasks(
			manifest,
			created.tasks.map((t) =>
				t.id === taskId
					? {
							...t,
							status: "waiting" as const,
							waiting: { questionId, askedAt: now, deadline: Date.now() + 600_000 },
						}
					: t,
			),
		);
	};
	const socketPath = getBrokerSocketPath(manifest.sessionId ?? `rd-${randomUUID()}`);
	let broker: CrewBroker | null = null;
	if (opts.startBroker !== false) {
		broker = new CrewBroker({
			sessionId: manifest.sessionId ?? "session-respond-delivery",
			socketPath,
			enabled: true,
			cwd,
			...(opts.brokerBoundKey !== undefined ? { dispatcherVerifyKey: opts.brokerBoundKey } : {}),
		});
		await broker.start();
	}
	return {
		cwd,
		manifest,
		taskId,
		taskInbox: path.join(manifest.stateRoot, "mailbox", "tasks", taskId, "inbox.jsonl"),
		socketPath,
		broker,
		brokerPub: getMailboxVerifyKeyPublic(),
		park,
		stop: async () => {
			if (broker !== null) await broker.stop();
			await removeDirWithRetry(cwd);
		},
	};
}

function responseRow(fx: DeliveryFixture, questionId: string, body: string): RespondDeliveryRow {
	return {
		direction: "inbox",
		from: "leader",
		to: fx.taskId,
		taskId: fx.taskId,
		body,
		kind: "response",
		priority: "normal",
		deliveryMode: "next_turn",
		questionId,
		requestId: questionId,
		replyTo: `ask-${questionId}`,
	};
}

/** INERT-READER LESSON: worker-context env (singular verify key = the
 *  spawner/broker key) — required to exercise the delivery gate at all. */
function installWorkerVerifyEnv(singular: string): () => void {
	const snap = snapshotEnv([COORDINATION_VERIFY_KEY_ENV, COORDINATION_VERIFY_KEYS_ENV]);
	process.env[COORDINATION_VERIFY_KEY_ENV] = singular;
	delete process.env[COORDINATION_VERIFY_KEYS_ENV];
	return () => restoreEnv(snap);
}

function rawRows(file: string): Array<Record<string, unknown>> {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Capture console.error lines emitted during `fn` (logInternalError writes
 *  warn scopes there). Returns the collected lines; always restores. */
async function captureConsoleError(fn: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map((a) => String(a)).join(" "));
	};
	try {
		await fn();
	} finally {
		console.error = original;
	}
	return lines;
}

function foreignPublicKeyB64(): string {
	const { publicKey } = generateKeyPairSync("ed25519");
	return Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64");
}

// ----------------------------------------------------------------------------
// deliverResponseRow — broker CR path
// ----------------------------------------------------------------------------

test("deliverResponseRow: broker CR success — via 'broker', exactly one broker-signed row, idempotent re-call dedupes, DELIVERS in worker env", async () => {
	const pub = getMailboxVerifyKeyPublic();
	const fx = await scaffold({ dispatcherVerifyKey: pub, brokerBoundKey: pub });
	try {
		assert.equal(fx.manifest.dispatcherVerifyKey, pub, "fixture sanity: manifest stamps this process as the dispatcher");
		const questionId = `q-deliver-${randomBytes(3).toString("hex")}`;
		const row = responseRow(fx, questionId, "answer via broker CR path");

		const outcome = await deliverResponseRow(fx.manifest, row);
		assert.equal(outcome.via, "broker");
		assert.ok(outcome.messageId.startsWith("resp_"), `broker row id shape: ${outcome.messageId}`);
		assert.equal(outcome.deduped, false);

		// Exactly one durable row — the BROKER's (no local append happened).
		const rows = rawRows(fx.taskInbox);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.id, outcome.messageId);
		assert.equal(rows[0]?.from, "leader");
		assert.equal(rows[0]?.kind, "response");
		assert.equal(rows[0]?.questionId, questionId);
		assert.equal(rows[0]?.replyTo, row.replyTo);
		assert.ok(verifyMailboxRowSig(rows[0]!, [fx.brokerPub]), "row is signed by the broker host keypair (w1a-verifiable)");

		// Re-delivery of the SAME row (requestId=questionId) is exactly-once.
		const again = await deliverResponseRow(fx.manifest, responseRow(fx, questionId, "answer via broker CR path"));
		assert.equal(again.via, "broker");
		assert.equal(again.deduped, true, "second delivery reuses the existing (direction, requestId) row");
		assert.equal(again.messageId, outcome.messageId);
		assert.equal(rawRows(fx.taskInbox).length, 1, "still exactly one row");

		// Worker-context reader (singular env key) DELIVERS it.
		const restore = installWorkerVerifyEnv(fx.brokerPub);
		try {
			const delivered = readMailbox(fx.manifest, "inbox", fx.taskId, "response");
			assert.deepEqual(
				delivered.map((m) => m.id),
				[outcome.messageId],
			);
		} finally {
			restore();
		}
	} finally {
		await fx.stop();
	}
});

test("deliverResponseRow: responder whose keypair is NOT the manifest dispatcher skips the broker → local signed row (gap-1 C behavior)", async () => {
	// A LIVE broker that WOULD accept this process's signature (bound to our
	// key). If deliverResponseRow ignored the precheck it would return
	// via:"broker" — proving the skip by returning via:"local" instead.
	const pub = getMailboxVerifyKeyPublic();
	const fx = await scaffold({ dispatcherVerifyKey: foreignPublicKeyB64(), brokerBoundKey: pub });
	try {
		const questionId = `q-foreign-${randomBytes(3).toString("hex")}`;
		const lines = await captureConsoleError(async () => {
			const outcome = await deliverResponseRow(fx.manifest, responseRow(fx, questionId, "restarted leader answers locally"));
			assert.equal(outcome.via, "local", "foreign/restarted responder must NOT attempt the CR path");
			assert.equal(outcome.deduped, false);
		});
		assert.equal(
			lines.filter((l) => l.includes("respond.broker-delivery-fallback")).length,
			0,
			"precheck skip is not a broker failure — no fallback warn",
		);
		// The local row is signed by THIS process (the dispatcher-of-record for
		// its own rows — hướng C semantics) and DELIVERS in the worker env.
		const rows = rawRows(fx.taskInbox);
		assert.equal(rows.length, 1);
		assert.ok(verifyMailboxRowSig(rows[0]!, [pub]));
		const restore = installWorkerVerifyEnv(pub);
		try {
			assert.equal(readMailbox(fx.manifest, "inbox", fx.taskId, "response").length, 1);
		} finally {
			restore();
		}
	} finally {
		await fx.stop();
	}
});

// ----------------------------------------------------------------------------
// deliverResponseRow — local fallbacks
// ----------------------------------------------------------------------------

test("deliverResponseRow: broker socket absent → local fallback + warn scope 'respond.broker-delivery-fallback' + still DELIVERS", async () => {
	const pub = getMailboxVerifyKeyPublic();
	// No broker started — getBrokerSocketPath(sessionId) has no listener.
	const fx = await scaffold({ dispatcherVerifyKey: pub, startBroker: false });
	try {
		const questionId = `q-nosock-${randomBytes(3).toString("hex")}`;
		const lines = await captureConsoleError(async () => {
			const outcome = await deliverResponseRow(fx.manifest, responseRow(fx, questionId, "answer despite dead broker"));
			assert.equal(outcome.via, "local", "dead socket falls back to the local signed append");
			assert.ok(outcome.messageId.length > 0);
		});
		assert.ok(
			lines.some((l) => l.startsWith("[pi-crew:respond.broker-delivery-fallback]")),
			`fallback warn logged: ${JSON.stringify(lines)}`,
		);
		const rows = rawRows(fx.taskInbox);
		assert.equal(rows.length, 1);
		assert.ok(verifyMailboxRowSig(rows[0]!, [pub]), "fallback row is locally signed");
		const restore = installWorkerVerifyEnv(pub);
		try {
			assert.equal(readMailbox(fx.manifest, "inbox", fx.taskId, "response").length, 1, "fallback row still DELIVERS");
		} finally {
			restore();
		}
	} finally {
		await fx.stop();
	}
});

test("deliverResponseRow: broker CR reject (bound key ≠ signer) → local fallback + warn + still DELIVERS", async () => {
	const pub = getMailboxVerifyKeyPublic();
	// Manifest says WE are the dispatcher (precheck passes) but the broker
	// bound a FOREIGN key — our signature can never verify → typed auth error
	// frame → fallback.
	const fx = await scaffold({ dispatcherVerifyKey: pub, brokerBoundKey: foreignPublicKeyB64() });
	try {
		const questionId = `q-reject-${randomBytes(3).toString("hex")}`;
		const lines = await captureConsoleError(async () => {
			const outcome = await deliverResponseRow(fx.manifest, responseRow(fx, questionId, "broker refuses, answer locally"));
			assert.equal(outcome.via, "local", "auth-reject falls back to the local signed append");
		});
		assert.ok(
			lines.some((l) => l.startsWith("[pi-crew:respond.broker-delivery-fallback]")),
			"fallback warn logged on broker rejection",
		);
		assert.equal(rawRows(fx.taskInbox).length, 1);
		const restore = installWorkerVerifyEnv(pub);
		try {
			assert.equal(readMailbox(fx.manifest, "inbox", fx.taskId, "response").length, 1, "row DELIVERS after the fallback");
		} finally {
			restore();
		}
	} finally {
		await fx.stop();
	}
});

// ----------------------------------------------------------------------------
// Lock safety (respond caller holds run.lock — busy-retry, never a hang)
// ----------------------------------------------------------------------------

interface RawClient {
	socket: net.Socket;
	closed: boolean;
	waitForFrame: (predicate: (frame: unknown) => boolean, timeoutMs?: number) => Promise<unknown>;
	close: () => void;
}

function rawConnect(socketPath: string): Promise<RawClient> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection(socketPath);
		const client: RawClient = {
			socket: sock,
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
		client.waitForFrame = (predicate, timeoutMs = 5000) =>
			new Promise((res, rej) => {
				pending.push({ resolve: res, predicate });
				setTimeout(() => rej(new Error("waitForFrame: timeout")), timeoutMs).unref();
			});
		const decoder = new NdjsonDecoder();
		sock.on("data", (chunk: Buffer) => {
			let frames: unknown[];
			try {
				frames = decoder.push(chunk);
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

interface ResponseFrame {
	id?: string;
	result?: Record<string, unknown>;
	error?: { code: string; message: string };
}

test("lock-safety: respond.force under a LIVE run.lock holder → typed busy frame, bounded time, connection survives, succeeds after release", async () => {
	const pub = getMailboxVerifyKeyPublic();
	const questionId = `q-lock-${randomBytes(3).toString("hex")}`;
	const fx = await scaffold({ dispatcherVerifyKey: pub, brokerBoundKey: pub });
	fx.park(questionId);
	const client = await rawConnect(fx.socketPath);
	try {
		// Hello with an ORCHESTRATOR token (per-run): the connection is authed
		// (no 1s hello deadline) and NOT worker-role — the position a leader
		// re-attached to the run holds when it forces a stuck park. (A PRE-hello
		// force connection would be killed by the 1s hello deadline mid-backoff
		// — see the observation report in this task's result.)
		assert.ok(fx.broker, "fixture sanity: broker started");
		const orchestratorToken = fx.broker.issueOrchestratorToken(fx.manifest.runId);
		client.socket.write(
			encodeBrokerFrame({
				id: "hello-ls",
				method: "hello",
				params: { protocol: 1, runId: fx.manifest.runId, taskId: fx.taskId, token: orchestratorToken },
			}),
		);
		const hello = (await client.waitForFrame((f) => (f as { id?: string })?.id === "hello-ls")) as ResponseFrame | undefined;
		assert.ok((hello?.result as { ok?: boolean } | undefined)?.ok === true, `orchestrator hello: ${JSON.stringify(hello)}`);

		// The production contention shape (RR-023 F4): a LIVE foreign holder of
		// run.lock — the detached runner persisting task state while the
		// respond caller (or this broker force gate) wants the lock.
		const lockPath = path.join(fx.manifest.stateRoot, "run.lock");
		fs.mkdirSync(fx.manifest.stateRoot, { recursive: true });
		fs.writeFileSync(
			lockPath,
			JSON.stringify({ kind: "run", pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() }),
		);

		const t0 = Date.now();
		client.socket.write(
			encodeBrokerFrame({
				id: "busy-1",
				method: "respond.force",
				params: { runId: fx.manifest.runId, taskId: fx.taskId, questionId, body: "forced under lock" },
			}),
		);
		const frame = (await client.waitForFrame((f) => (f as { id?: string })?.id === "busy-1")) as ResponseFrame | undefined;
		const elapsed = Date.now() - t0;
		assert.equal(frame?.error?.code, "busy", `typed busy frame, not a close: ${JSON.stringify(frame)}`);
		assert.ok(elapsed >= 1_000 && elapsed < 10_000, `bounded busy-retry (~1.55s schedule), took ${elapsed}ms`);
		assert.equal(client.closed, false, "connection survives the contention");

		// The gate never ran → nothing appended, no audit.
		assert.equal(fs.existsSync(fx.taskInbox), false);
		const events = fs.existsSync(fx.manifest.eventsPath)
			? fs
					.readFileSync(fx.manifest.eventsPath, "utf8")
					.split(/\r?\n/)
					.filter((l) => l.trim().length > 0)
					.map((l) => JSON.parse(l) as Record<string, unknown>)
			: [];
		assert.equal(events.filter((e) => e.type === "respond.broker_append").length, 0);

		// Ping still answers (the pre-fix failure mode was an untyped close).
		client.socket.write(encodeBrokerFrame({ id: "ping-1", method: "ping", params: {} }));
		const pong = (await client.waitForFrame((f) => (f as { id?: string })?.id === "ping-1")) as ResponseFrame | undefined;
		assert.ok((pong?.result as { pong?: boolean } | undefined)?.pong === true, "ping answers after contention");

		// Release → the retry budget is not wedged: force succeeds.
		fs.rmSync(lockPath);
		client.socket.write(
			encodeBrokerFrame({
				id: "busy-2",
				method: "respond.force",
				params: { runId: fx.manifest.runId, taskId: fx.taskId, questionId, body: "forced after release" },
			}),
		);
		const ok = (await client.waitForFrame((f) => (f as { id?: string })?.id === "busy-2")) as ResponseFrame | undefined;
		assert.ok(ok?.result?.messageId, `force succeeds after the lock releases: ${JSON.stringify(ok)}`);
		assert.equal(ok?.result?.auth, "forced");
		assert.equal(rawRows(fx.taskInbox).length, 1);
	} finally {
		client.close();
		await fx.stop();
	}
});

// ----------------------------------------------------------------------------
// deliverResponseRow — HƯỚNG A follow-up (probes 14–17): force tier for a
// non-dispatcher responder against a LIVE park
// ----------------------------------------------------------------------------

test("deliverResponseRow: restarted/foreign responder + LIVE park → respond.force delivers a broker-signed row (via 'forced')", async () => {
	const pub = getMailboxVerifyKeyPublic();
	// Manifest says SOMEONE ELSE is the dispatcher (original leader died with
	// its heap keypair); the broker is bound to that dead key (CR can never
	// verify for us). The park is LIVE → force is the designed lane.
	const fx = await scaffold({ dispatcherVerifyKey: foreignPublicKeyB64(), brokerBoundKey: foreignPublicKeyB64() });
	try {
		const questionId = `q-forced-${randomBytes(3).toString("hex")}`;
		fx.park(questionId);
		const outcome = await deliverResponseRow(fx.manifest, responseRow(fx, questionId, "restarted leader forces through"));
		assert.equal(outcome.via, "forced", "non-dispatcher responder with a live park must deliver via respond.force");
		assert.ok(outcome.messageId.length > 0);
		// Exactly ONE row on disk — the broker-signed append. No local
		// duplicate row (a foreign local row would be unverifiable noise).
		const rows = rawRows(fx.taskInbox);
		assert.equal(rows.length, 1, "exactly one row — broker append only");
		// The broker host (this test process) signed it — verifiable by any
		// worker holding the broker/spawner public key.
		assert.ok(verifyMailboxRowSig(rows[0]!, [pub]), "broker-signed row verifies");
		// And the respond.broker_append audit event landed in events.jsonl.
		const events = fs.readFileSync(fx.manifest.eventsPath, "utf8");
		assert.ok(events.includes("respond.broker_append"), "audit event present");
		assert.ok(events.includes('"auth":"forced"'), "auth:forced recorded");
	} finally {
		await fx.stop();
	}
});

test("deliverResponseRow: non-dispatcher + park NOT live (dead park) → force no-park → local trail row", async () => {
	const pub = getMailboxVerifyKeyPublic();
	const fx = await scaffold({ dispatcherVerifyKey: foreignPublicKeyB64(), brokerBoundKey: foreignPublicKeyB64() });
	try {
		const questionId = `q-dead-${randomBytes(3).toString("hex")}`;
		// NO park() — nothing waiting.
		const lines = await captureConsoleError(async () => {
			const outcome = await deliverResponseRow(fx.manifest, responseRow(fx, questionId, "late answer"));
			assert.equal(outcome.via, "local", "dead park → force rejects no-park → local append");
		});
		assert.ok(
			lines.some((l) => l.includes("respond.force-delivery-fallback")),
			"force fallback warn recorded",
		);
		assert.equal(rawRows(fx.taskInbox).length, 1, "local trail row appended");
	} finally {
		await fx.stop();
	}
});

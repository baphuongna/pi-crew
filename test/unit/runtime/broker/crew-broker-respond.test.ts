/**
 * crew-broker-respond.test.ts — HƯỚNG A (ADR Option 3, run
 * team_20261101000805_8fe294ff11954460, 2026-11-01): the broker-side
 * `respond.challenge` / `respond.append` / `respond.force` surface.
 *
 * Why this surface exists (the hướng C gaps of 0.11.55): responders that are
 * NOT the dispatch process (restarted leader, foreign session, scheduler
 * host) sign rows with a keypair the worker's w1a verify set does not carry,
 * so their rows drop as noise. Hướng A lets the BROKER process append the
 * row (its keypair == the worker's spawner keypair) gated by:
 *  - CR (`respond.append`): prove possession of the DISPATCHER private key
 *    over `respondAppendSignInput(nonce, params)` against the broker's
 *    construct-time HEAP-ONLY bound public key;
 *  - force (`respond.force`): token-less human-responsibility one-shot for a
 *    park that is live RIGHT NOW.
 *
 * Test levels used:
 *  - Socket-level integration against a REAL CrewBroker (raw NDJSON client,
 *    the handshake-test discipline) for every gate that is reachable over the
 *    wire, including the PRE-hello dispatch of all three methods.
 *  - Direct `handleRespondMethod` unit calls (the exported deps seam) ONLY
 *    where the wire cannot reach the state deterministically: challenge
 *    EXPIRY (RESPOND_CHALLENGE_TTL_MS would cost 30s of wall clock) and the
 *    no-challenge reject.
 *
 * INERT-READER LESSON (mandated): every delivery-side reader assertion runs
 * with PI_CREW_MAILBOX_VERIFY_KEY (singular) set to the broker host's public
 * key — the exact env a worker-context reader carries. Without the env the
 * reader is inert (keyless) and the drop path is unreproducible.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CrewBroker } from "../../../../src/runtime/broker/crew-broker.ts";
import {
	type BrokerRespondDeps,
	handleRespondMethod,
	RESPOND_CHALLENGE_TTL_MS,
} from "../../../../src/runtime/broker/protocol/broker-respond.ts";
import type { ServerConnection } from "../../../../src/runtime/broker/protocol/connection-state.ts";
import { type RespondCommonParams, respondAppendSignInput } from "../../../../src/runtime/broker/protocol/request-parsers.ts";
import { TEAM_EVENT_TYPES } from "../../../../src/state/contracts.ts";
import {
	COORDINATION_VERIFY_KEY_ENV,
	COORDINATION_VERIFY_KEYS_ENV,
	getMailboxVerifyKeyPublic,
	readMailbox,
	signCoordinationChallenge,
	verifyMailboxRowSig,
} from "../../../../src/state/coordination/mailbox.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../../../src/utils/ndjson.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { restoreEnv, snapshotEnv } from "../../../fixtures/test-env-helpers.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const TEAM: TeamConfig = {
	name: "respond-a",
	description: "hướng A broker respond tests",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "executor", description: "worker role" }],
};

const WORKFLOW: WorkflowConfig = {
	name: "respond-a-flow",
	description: "single step",
	source: "builtin",
	filePath: "builtin",
	steps: [{ id: "one", role: "worker", task: "exercise the respond.* broker surface" }],
};

function tempSocketPath(suffix: string): string {
	// Keep the path short (macOS sun_path budget 104B; win32 needs a named
	// pipe) — the handshake-test discipline.
	const tok = randomBytes(3).toString("hex");
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-crew-test-${tok}-${suffix}`;
	}
	return path.join(os.tmpdir(), `cbr-${tok}-${suffix}.sock`);
}

interface Fixture {
	cwd: string;
	manifest: TeamRunManifest;
	taskId: string;
	/** Path of the task's durable inbox JSONL (created on first append). */
	taskInbox: string;
	broker: CrewBroker;
	socketPath: string;
	/** Public verify key of the BROKER HOST process (== this test process). */
	brokerPub: string;
	/** The key the broker bound as the dispatcher trust anchor. */
	boundKey: string | undefined;
	park: (questionId: string) => void;
}

async function startRespondBroker(opts: { parkQuestionId?: string; boundDispatcherKey?: string }): Promise<Fixture> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-respond-broker-"));
	const created = createRunManifest({
		cwd,
		team: TEAM,
		workflow: WORKFLOW,
		goal: "hướng A broker respond gates",
		dispatcherVerifyKey: opts.boundDispatcherKey,
	});
	saveRunManifest(created.manifest);
	const manifest = created.manifest;
	const taskId = created.tasks[0]!.id;
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
	if (opts.parkQuestionId !== undefined) park(opts.parkQuestionId);
	else saveRunTasks(manifest, created.tasks);

	const socketPath = tempSocketPath("respond");
	const broker = new CrewBroker({
		sessionId: manifest.sessionId ?? "session-respond-test",
		socketPath,
		enabled: true,
		cwd,
		...(opts.boundDispatcherKey !== undefined ? { dispatcherVerifyKey: opts.boundDispatcherKey } : {}),
	});
	await broker.start();
	return {
		cwd,
		manifest,
		taskId,
		taskInbox: path.join(manifest.stateRoot, "mailbox", "tasks", taskId, "inbox.jsonl"),
		broker,
		socketPath,
		brokerPub: getMailboxVerifyKeyPublic(),
		boundKey: opts.boundDispatcherKey,
		park,
	};
}

async function stopFixture(fx: Fixture): Promise<void> {
	await fx.broker.stop();
	await removeDirWithRetry(fx.cwd);
}

/** Arbitrary Ed25519 public key (base64 SPKI) — a "stranger"/foreign role. */
function foreignPublicKeyB64(): string {
	const { publicKey } = generateKeyPairSync("ed25519");
	return Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64");
}

// ----------------------------------------------------------------------------
// Raw NDJSON client (handshake-test discipline)
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
		client.waitForFrame = (predicate, timeoutMs = 3000) =>
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

async function request(client: RawClient, method: string, params: Record<string, unknown>, id: string): Promise<ResponseFrame | undefined> {
	client.socket.write(encodeBrokerFrame({ id, method, params }));
	return (await client.waitForFrame((f) => (f as { id?: string })?.id === id)) as ResponseFrame | undefined;
}

/** Full CR flow on ONE connection (the nonce is bound per-connection). */
async function crAppend(
	client: RawClient,
	params: RespondCommonParams,
	tag: string,
	sign: (nonce: string, params: RespondCommonParams) => string,
): Promise<ResponseFrame | undefined> {
	const ch = await request(client, "respond.challenge", { runId: params.runId }, `${tag}-c`);
	const nonce = (ch?.result as { nonce?: string } | undefined)?.nonce;
	assert.ok(nonce, `respond.challenge must return a nonce: ${JSON.stringify(ch)}`);
	return request(client, "respond.append", { ...params, nonce, sig: sign(nonce, params) }, `${tag}-a`);
}

/** Sign with THIS process's coordination keypair (the dispatcher when the
 *  broker binds this process's public key). */
function signAsInProcessDispatcher(nonce: string, params: RespondCommonParams): string {
	return signCoordinationChallenge(respondAppendSignInput(nonce, params));
}

// ----------------------------------------------------------------------------
// Worker-context reader env (INERT-READER LESSON — mandated)
// ----------------------------------------------------------------------------

/** Install the FINDING-B worker env: singular = the spawner/broker key.
 *  Returns a restore function (snapshot/restore discipline). */
function installWorkerVerifyEnv(singular: string, plural?: string[]): () => void {
	const snap = snapshotEnv([COORDINATION_VERIFY_KEY_ENV, COORDINATION_VERIFY_KEYS_ENV]);
	process.env[COORDINATION_VERIFY_KEY_ENV] = singular;
	if (plural !== undefined && plural.length > 0) process.env[COORDINATION_VERIFY_KEYS_ENV] = plural.join(",");
	else delete process.env[COORDINATION_VERIFY_KEYS_ENV];
	return () => restoreEnv(snap);
}

/** Read the raw durable rows (readMailbox strips `sig` from results; the
 *  w1a gate already ran inside parseMailboxFile — this re-checks raw bytes). */
function rawRows(file: string): Array<Record<string, unknown>> {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function readAuditEvents(manifest: TeamRunManifest): Array<Record<string, unknown>> {
	if (!fs.existsSync(manifest.eventsPath)) return [];
	return fs
		.readFileSync(manifest.eventsPath, "utf8")
		.split(/\r?\n/)
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ----------------------------------------------------------------------------
// Direct-handler seam (deterministic nonce-state control)
// ----------------------------------------------------------------------------

interface HandlerHarness {
	deps: BrokerRespondDeps;
	errors: Array<{ id: string; code: string; message: string }>;
	results: Array<{ id: string; result: unknown }>;
}

function handlerHarness(cwd: string, boundKey: string | undefined): HandlerHarness {
	const errors: HandlerHarness["errors"] = [];
	const results: HandlerHarness["results"] = [];
	const deps: BrokerRespondDeps = {
		sendError: (_conn, id, code, message) => {
			errors.push({ id, code, message });
		},
		sendResult: (_conn, id, result) => {
			results.push({ id, result });
		},
		cwd,
		dispatcherVerifyKey: boundKey,
		respondChallenges: new WeakMap<ServerConnection, { nonce: string; runId: string; expiresAt: number }>(),
		respondChallengeCounts: new WeakMap<ServerConnection, number>(),
		respondedQuestionIds: new Set<string>(),
		runLockBusyRetry: <T>(_manifest: TeamRunManifest, fn: () => T) => Promise.resolve({ ok: true as const, value: fn() }),
		socketPath: "respond-unit-test.sock",
	};
	return { deps, errors, results };
}

function fakeConn(role?: "worker"): ServerConnection {
	return { authed: false, ...(role !== undefined ? { role } : {}) } as unknown as ServerConnection;
}

// ----------------------------------------------------------------------------
// CR gate
// ----------------------------------------------------------------------------

test("respond.append: valid dispatcher sig on ONE connection appends a broker-signed leader row", async () => {
	const fx = await startRespondBroker({ boundDispatcherKey: getMailboxVerifyKeyPublic() });
	const client = await rawConnect(fx.socketPath);
	try {
		const questionId = `q-cr-${randomBytes(3).toString("hex")}`;
		const params: RespondCommonParams = {
			runId: fx.manifest.runId,
			taskId: fx.taskId,
			questionId,
			body: "the answer, broker-signed",
			priority: "normal",
			deliveryMode: "next_turn",
			requestId: questionId,
		};
		const ap = await crAppend(client, params, "ok", signAsInProcessDispatcher);
		assert.ok(ap?.result?.messageId, `append must succeed: ${JSON.stringify(ap)}`);
		assert.equal(ap?.result?.auth, "challenge-response");
		assert.equal(ap?.result?.deduped, false);

		// Row shape + w1a: the durable row is signed by the BROKER HOST keypair
		// and verifies under it — the whole point of hướng A.
		const rows = rawRows(fx.taskInbox);
		assert.equal(rows.length, 1, "exactly one row appended");
		const row = rows[0]!;
		assert.equal(row.from, "leader");
		assert.equal(row.kind, "response");
		assert.equal(row.questionId, questionId);
		assert.equal(row.requestId, questionId);
		assert.equal(row.id, ap.result.messageId);
		assert.ok(verifyMailboxRowSig(row, [fx.brokerPub]), "row verifies under the broker host public key");
		assert.equal(verifyMailboxRowSig({ ...row, body: "tampered" }, [fx.brokerPub]), false, "tampered row fails verify");

		// INERT-READER LESSON: worker-context env (singular verify key) — the
		// parse-time w1a gate must DELIVER the broker-signed row.
		const restore = installWorkerVerifyEnv(fx.brokerPub);
		try {
			const delivered = readMailbox(fx.manifest, "inbox", fx.taskId, "response");
			assert.deepEqual(
				delivered.map((m) => m.id),
				[ap.result.messageId],
				"broker-signed response row is DELIVERED in the worker-context reader",
			);
		} finally {
			restore();
		}
	} finally {
		client.close();
		await stopFixture(fx);
	}
});

test("respond.append: sig from a NON-dispatcher key is rejected (auth), no row, no nonce echo", async () => {
	// Broker binds a FOREIGN dispatcher key; this process signs with its own
	// keypair — the worker/stranger position (public material only).
	const fx = await startRespondBroker({ boundDispatcherKey: foreignPublicKeyB64() });
	const client = await rawConnect(fx.socketPath);
	try {
		const params: RespondCommonParams = {
			runId: fx.manifest.runId,
			taskId: fx.taskId,
			questionId: `q-wrongkey-${randomBytes(3).toString("hex")}`,
			body: "signed by the wrong key",
			requestId: `q-wrongkey-${randomBytes(3).toString("hex")}`,
		};
		const ch = await request(client, "respond.challenge", { runId: params.runId }, "wk-c");
		const nonce = (ch?.result as { nonce?: string } | undefined)?.nonce;
		assert.ok(nonce, "challenge issuance is not gated on the signer");
		const ap = await request(client, "respond.append", { ...params, nonce, sig: signAsInProcessDispatcher(nonce, params) }, "wk-a");
		assert.equal(ap?.error?.code, "auth", `wrong-key sig rejected: ${JSON.stringify(ap)}`);
		assert.match(ap?.error?.message ?? "", /signature verification failed/);
		assert.ok(!JSON.stringify(ap).includes(nonce), "error frame must not echo the nonce");
		assert.equal(fs.existsSync(fx.taskInbox), false, "no row appended on a failed CR");
		assert.equal(readAuditEvents(fx.manifest).filter((e) => e.type === "respond.broker_append").length, 0);
	} finally {
		client.close();
		await stopFixture(fx);
	}
});

test("respond.append: nonce is single-use — replay on the same AND on a new connection fails (auth)", async () => {
	const fx = await startRespondBroker({ boundDispatcherKey: getMailboxVerifyKeyPublic() });
	const client = await rawConnect(fx.socketPath);
	try {
		const questionId = `q-reuse-${randomBytes(3).toString("hex")}`;
		const params: RespondCommonParams = {
			runId: fx.manifest.runId,
			taskId: fx.taskId,
			questionId,
			body: "first (valid) answer",
			requestId: questionId,
		};
		const ap = await crAppend(client, params, "ru", signAsInProcessDispatcher);
		assert.ok(ap?.result?.messageId, "first append succeeds");

		// The challenge record is burned on FIRST use — a byte-identical replay
		// (same nonce, same valid sig) must not append a second row.
		const ch = await request(client, "respond.challenge", { runId: params.runId }, "ru-c2");
		const nonce2 = (ch?.result as { nonce?: string } | undefined)?.nonce;
		assert.ok(nonce2, "fresh challenge must return a nonce");
		const sig2 = signAsInProcessDispatcher(nonce2, params);
		const replaySame = await request(client, "respond.append", { ...params, nonce: nonce2, sig: sig2 }, "ru-a2");
		assert.ok(replaySame?.result?.messageId, "a FRESH challenge on the same connection is a new valid CR round");
		const replayBurned = await request(client, "respond.append", { ...params, nonce: nonce2, sig: sig2 }, "ru-a3");
		assert.equal(replayBurned?.error?.code, "auth", "burned nonce cannot be reused on the same connection");

		// Cross-connection: the nonce is bound to the connection object — a
		// second connection replaying it never had a challenge.
		const client2 = await rawConnect(fx.socketPath);
		try {
			const replayNew = await request(client2, "respond.append", { ...params, nonce: nonce2, sig: sig2 }, "ru-a4");
			assert.equal(replayNew?.error?.code, "auth");
			assert.match(replayNew?.error?.message ?? "", /no active challenge/);
		} finally {
			client2.close();
		}
		// Idempotency: the two VALID appends shared requestId=questionId →
		// exactly one durable row.
		const rows = rawRows(fx.taskInbox);
		assert.equal(rows.length, 1, "requestId=questionId dedup keeps exactly one row");
	} finally {
		client.close();
		await stopFixture(fx);
	}
});

test("respond.append (handler unit): an EXPIRED challenge is rejected (auth)", async () => {
	const fx = await startRespondBroker({ boundDispatcherKey: getMailboxVerifyKeyPublic() });
	try {
		const h = handlerHarness(fx.cwd, fx.brokerPub);
		const conn = fakeConn();
		const questionId = `q-exp-${randomBytes(3).toString("hex")}`;
		const nonce = "n".repeat(43);
		// Seed the per-connection challenge record already past its TTL
		// (RESPOND_CHALLENGE_TTL_MS) — deterministic without 30s of wall clock.
		h.deps.respondChallenges.set(conn, {
			nonce,
			runId: fx.manifest.runId,
			expiresAt: Date.now() - 1_000,
		});
		await handleRespondMethod(h.deps, conn, "req-exp", "respond.append", {
			runId: fx.manifest.runId,
			taskId: fx.taskId,
			questionId,
			body: "late answer",
			requestId: questionId,
			nonce,
			sig: "s".repeat(86),
		});
		assert.equal(h.errors.length, 1);
		assert.equal(h.errors[0]?.code, "auth");
		assert.match(h.errors[0]?.message ?? "", /expired/);
		assert.equal(fs.existsSync(fx.taskInbox), false, "expired challenge must not append");
	} finally {
		await stopFixture(fx);
	}
});

test("respond.append (handler unit): no prior challenge → auth reject; TTL constant sanity", async () => {
	const fx = await startRespondBroker({ boundDispatcherKey: getMailboxVerifyKeyPublic() });
	try {
		const h = handlerHarness(fx.cwd, fx.brokerPub);
		const conn = fakeConn();
		const questionId = `q-noch-${randomBytes(3).toString("hex")}`;
		await handleRespondMethod(h.deps, conn, "req-noch", "respond.append", {
			runId: fx.manifest.runId,
			taskId: fx.taskId,
			questionId,
			body: "answer without challenging",
			requestId: questionId,
			nonce: "n".repeat(43),
			sig: "s".repeat(86),
		});
		assert.equal(h.errors.length, 1);
		assert.equal(h.errors[0]?.code, "auth");
		assert.match(h.errors[0]?.message ?? "", /no active challenge/);
		// Contract pin: the TTL the expiry gate implements.
		assert.equal(RESPOND_CHALLENGE_TTL_MS, 30_000);
	} finally {
		await stopFixture(fx);
	}
});

// ----------------------------------------------------------------------------
// Force gate
// ----------------------------------------------------------------------------

test("respond.force: live park DELIVERS a leader-forced row tagged data.tag 'forced' + audit", async () => {
	const questionId = `q-force-${randomBytes(3).toString("hex")}`;
	const fx = await startRespondBroker({ parkQuestionId: questionId });
	const client = await rawConnect(fx.socketPath);
	try {
		const t0 = Date.now();
		const fp = await request(
			client,
			"respond.force",
			{ runId: fx.manifest.runId, taskId: fx.taskId, questionId, body: "forced answer" },
			"f1",
		);
		assert.ok(fp?.result?.messageId, `force on a live park appends: ${JSON.stringify(fp)}`);
		assert.equal(fp?.result?.auth, "forced");
		assert.ok(Date.now() - t0 < 5_000, "force answers well within the test budget");

		const rows = rawRows(fx.taskInbox);
		assert.equal(rows.length, 1);
		const row = rows[0]!;
		assert.equal(row.from, "leader-forced", "forced rows carry the fence-able from marker");
		assert.equal((row.data as Record<string, unknown> | undefined)?.tag, "forced");
		assert.equal(row.kind, "response");
		assert.equal(row.questionId, questionId);
		assert.ok(verifyMailboxRowSig(row, [fx.brokerPub]), "forced row verifies under the broker host key");

		// Worker-context reader (singular env) DELIVERS the forced row too.
		const restore = installWorkerVerifyEnv(fx.brokerPub);
		try {
			const delivered = readMailbox(fx.manifest, "inbox", fx.taskId, "response");
			assert.deepEqual(
				delivered.map((m) => m.id),
				[fp?.result?.messageId],
			);
		} finally {
			restore();
		}
	} finally {
		client.close();
		await stopFixture(fx);
	}
});

test("respond.force: questionId matching no live park is rejected (no-park)", async () => {
	const fx = await startRespondBroker({ parkQuestionId: `q-live-${randomBytes(3).toString("hex")}` });
	const client = await rawConnect(fx.socketPath);
	try {
		const fp = await request(
			client,
			"respond.force",
			{ runId: fx.manifest.runId, taskId: fx.taskId, questionId: "not-a-live-park", body: "x" },
			"f2",
		);
		assert.equal(fp?.error?.code, "no-park", `mismatched questionId rejected: ${JSON.stringify(fp)}`);
		assert.equal(fs.existsSync(fx.taskInbox), false);
	} finally {
		client.close();
		await stopFixture(fx);
	}
});

test("respond.force: one-shot — second force AND force-after-CR-append are rejected (already-answered)", async () => {
	const bound = getMailboxVerifyKeyPublic();
	const questionId = `q-1shot-${randomBytes(3).toString("hex")}`;
	const fx = await startRespondBroker({ parkQuestionId: questionId, boundDispatcherKey: bound });
	const client = await rawConnect(fx.socketPath);
	try {
		const first = await request(
			client,
			"respond.force",
			{ runId: fx.manifest.runId, taskId: fx.taskId, questionId, body: "first forced" },
			"o1",
		);
		assert.ok(first?.result?.messageId, "first force succeeds");
		const second = await request(
			client,
			"respond.force",
			{ runId: fx.manifest.runId, taskId: fx.taskId, questionId, body: "second forced" },
			"o2",
		);
		assert.equal(second?.error?.code, "already-answered", `one-shot per park: ${JSON.stringify(second)}`);

		// Cross-path one-shot: a CR append on a question the force path already
		// answered (both paths share requestId=questionId dedup) → rejected.
		const params: RespondCommonParams = {
			runId: fx.manifest.runId,
			taskId: fx.taskId,
			questionId,
			body: "cr answer after force",
			requestId: questionId,
		};
		const ap = await crAppend(client, params, "x1", signAsInProcessDispatcher);
		assert.equal(ap?.result?.deduped, true, "CR append dedupes onto the forced row");
		const rows = rawRows(fx.taskInbox);
		assert.equal(rows.length, 1, "exactly one durable row across both paths");
		assert.equal(rows[0]?.from, "leader-forced");

		// And the reverse order on a fresh park: CR append first, then force.
		const q2 = `q-1shotb-${randomBytes(3).toString("hex")}`;
		fx.park(q2);
		const params2: RespondCommonParams = {
			runId: fx.manifest.runId,
			taskId: fx.taskId,
			questionId: q2,
			body: "cr first",
			requestId: q2,
		};
		const ap2 = await crAppend(client, params2, "x2", signAsInProcessDispatcher);
		assert.ok(ap2?.result?.messageId, "CR append on fresh park succeeds");
		const forceAfter = await request(
			client,
			"respond.force",
			{ runId: fx.manifest.runId, taskId: fx.taskId, questionId: q2, body: "force after cr" },
			"o3",
		);
		assert.equal(forceAfter?.error?.code, "already-answered", "force after a CR append is one-shot too");
	} finally {
		client.close();
		await stopFixture(fx);
	}
});

test("respond.append + respond.force: worker-token (hello'd) connections are rejected (forbidden)", async () => {
	const questionId = `q-wt-${randomBytes(3).toString("hex")}`;
	const fx = await startRespondBroker({ parkQuestionId: questionId, boundDispatcherKey: getMailboxVerifyKeyPublic() });
	const client = await rawConnect(fx.socketPath);
	try {
		// Per-task token → role "worker" (role derives from the token TYPE).
		const workerToken = fx.broker.issueRunToken(fx.manifest.runId, fx.taskId);
		const hello = await request(
			client,
			"hello",
			{ protocol: 1, runId: fx.manifest.runId, taskId: fx.taskId, token: workerToken },
			"h-wt",
		);
		assert.ok((hello?.result as { ok?: boolean } | undefined)?.ok === true, "worker hello succeeds");

		const fp = await request(
			client,
			"respond.force",
			{ runId: fx.manifest.runId, taskId: fx.taskId, questionId, body: "worker tries force" },
			"wf",
		);
		assert.equal(fp?.error?.code, "forbidden", "worker-token connection cannot force");

		const ap = await request(
			client,
			"respond.append",
			{
				runId: fx.manifest.runId,
				taskId: fx.taskId,
				questionId,
				body: "worker tries CR",
				requestId: questionId,
				nonce: "n".repeat(43),
				sig: "s".repeat(86),
			},
			"wa",
		);
		assert.equal(ap?.error?.code, "forbidden", "worker-token connection cannot CR-append");
		assert.equal(fs.existsSync(fx.taskInbox), false, "neither path appended anything");
	} finally {
		client.close();
		await stopFixture(fx);
	}
});

// ----------------------------------------------------------------------------
// Event audit
// ----------------------------------------------------------------------------

test("respond.broker_append is a registered team event type and the audit data carries the contract shape", async () => {
	// Registration half — protects against silent unregistration (the
	// check:event-types gate enforces this repo-wide; pinned here too).
	assert.ok(
		(TEAM_EVENT_TYPES as readonly string[]).includes("respond.broker_append"),
		"respond.broker_append must stay registered in TEAM_EVENT_TYPES",
	);

	// Data-shape half — exercise both auth paths on one fixture and inspect
	// the durable event log.
	const questionId = `q-audit-${randomBytes(3).toString("hex")}`;
	const fx = await startRespondBroker({ parkQuestionId: questionId, boundDispatcherKey: getMailboxVerifyKeyPublic() });
	const client = await rawConnect(fx.socketPath);
	try {
		const fp = await request(
			client,
			"respond.force",
			{ runId: fx.manifest.runId, taskId: fx.taskId, questionId, body: "forced for audit" },
			"au-f",
		);
		assert.ok(fp?.result?.messageId);
		const q2 = `q-audit2-${randomBytes(3).toString("hex")}`;
		fx.park(q2);
		const params: RespondCommonParams = {
			runId: fx.manifest.runId,
			taskId: fx.taskId,
			questionId: q2,
			body: "cr for audit",
			requestId: q2,
		};
		const ap = await crAppend(client, params, "au-c", signAsInProcessDispatcher);
		assert.ok(ap?.result?.messageId);

		const audits = readAuditEvents(fx.manifest).filter((e) => e.type === "respond.broker_append");
		assert.equal(audits.length, 2, "one audit per successful broker append");
		const forced = audits.find((e) => (e.data as Record<string, unknown> | undefined)?.auth === "forced");
		const cr = audits.find((e) => (e.data as Record<string, unknown> | undefined)?.auth === "challenge-response");
		assert.ok(forced, "forced audit present");
		assert.ok(cr, "challenge-response audit present");
		for (const [ev, expected] of [
			[forced, questionId],
			[cr, q2],
		] as const) {
			const data = ev!.data as Record<string, unknown>;
			assert.equal(data.taskId, fx.taskId);
			assert.equal(data.questionId, expected);
			assert.equal(typeof data.requestId, "string");
			assert.equal(typeof data.messageId, "string");
			assert.equal(typeof data.deduped, "boolean");
			assert.equal(ev!.runId, fx.manifest.runId);
		}
		const forcedData = forced!.data as Record<string, unknown>;
		assert.equal(forcedData.tag, "forced", "forced audit carries the forced tag");
		assert.equal(forcedData.brokerSocket, fx.socketPath, "forced audit carries the broker socket identity");
		assert.equal((cr!.data as Record<string, unknown>).tag, undefined, "CR audit is NOT tagged forced");
	} finally {
		client.close();
		await stopFixture(fx);
	}
});

/** Standalone signer process (the 0.11.55 FOREIGN-SIGNER harness discipline):
 *  imports the REAL mailbox module in its own process, signs one row with ITS
 *  OWN heap keypair, and appends it RAW to the task inbox file — a third
 *  process bypassing the broker ("tự append thô fs"). Reports its public key. */
const STRANGER_SIGNER_HARNESS = `
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
const [, , mailboxModulePath, rowPath, inboxPath, resultPath] = process.argv;
const mailbox = await import(pathToFileURL(mailboxModulePath).href);
const row = JSON.parse(fs.readFileSync(rowPath, "utf8"));
fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
fs.appendFileSync(inboxPath, JSON.stringify(mailbox.signMailboxMessage(row)) + "\\n");
fs.writeFileSync(resultPath, JSON.stringify({ pub: mailbox.getMailboxVerifyKeyPublic() }));
`;

// w1a reader gates: broker rows DELIVER, stranger-signed rows DROP

test("w1a reader (worker env, singular key): broker rows DELIVER; stranger-signed raw-fs row DROPS as noise", async () => {
	const questionId = `q-stranger-${randomBytes(3).toString("hex")}`;
	const fx = await startRespondBroker({ parkQuestionId: questionId, boundDispatcherKey: getMailboxVerifyKeyPublic() });
	const client = await rawConnect(fx.socketPath);
	try {
		// Broker-side row (forced path).
		const fp = await request(
			client,
			"respond.force",
			{ runId: fx.manifest.runId, taskId: fx.taskId, questionId, body: "broker row" },
			"st-f",
		);
		assert.ok(fp?.result?.messageId);

		// Stranger: a THIRD process signs a shape-valid response row with its
		// own keypair and appends it straight to the JSONL.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-respond-stranger-"));
		const harnessPath = path.join(dir, "stranger-signer.ts");
		const rowPath = path.join(dir, "row.json");
		const resultPath = path.join(dir, "result.json");
		fs.writeFileSync(harnessPath, STRANGER_SIGNER_HARNESS);
		fs.writeFileSync(
			rowPath,
			JSON.stringify({
				id: "msg_stranger_response",
				runId: fx.manifest.runId,
				direction: "inbox",
				from: "leader",
				to: fx.taskId,
				taskId: fx.taskId,
				body: "stranger forged response",
				createdAt: new Date().toISOString(),
				status: "queued",
				kind: "response",
				priority: "normal",
				deliveryMode: "next_turn",
				questionId,
				requestId: "req_stranger_response",
			}),
		);
		const mailboxModulePath = fileURLToPath(new URL("../../../../src/state/coordination/mailbox.ts", import.meta.url));
		const child = spawnSync(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", harnessPath, mailboxModulePath, rowPath, fx.taskInbox, resultPath],
			{ encoding: "utf8", timeout: 30_000 },
		);
		assert.equal(child.status, 0, `stranger signer failed: ${child.stderr}`);
		const strangerPub = (JSON.parse(fs.readFileSync(resultPath, "utf8")) as { pub: string }).pub;
		await removeDirWithRetry(dir);

		// Sanity: the stranger row is WELL-FORMED and properly signed — it
		// drops only because the worker's key set does not carry that key.
		const rows = rawRows(fx.taskInbox);
		assert.equal(rows.length, 2, "both rows are on disk");
		const strangerRow = rows.find((r) => r.id === "msg_stranger_response")!;
		assert.ok(strangerRow);
		assert.equal(verifyMailboxRowSig(strangerRow, [strangerPub]), true, "stranger row verifies under its OWN key (sanity)");
		assert.equal(verifyMailboxRowSig(strangerRow, [fx.brokerPub]), false, "stranger row does not verify under the broker key");

		// INERT-READER LESSON: the reader must carry the worker env (singular
		// verify key) — the delivery gate then keeps ONLY the broker row.
		const restore = installWorkerVerifyEnv(fx.brokerPub);
		try {
			const delivered = readMailbox(fx.manifest, "inbox", fx.taskId, "response");
			assert.deepEqual(
				delivered.map((m) => m.id),
				[fp?.result?.messageId],
				"broker-signed row DELIVERED; stranger-signed row DROPPED as noise",
			);
		} finally {
			restore();
		}
	} finally {
		client.close();
		await stopFixture(fx);
	}
});

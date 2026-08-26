/**
 * wait-request-broker.test.ts — WP-2/R2 STEP 3+4 unit tests.
 *
 * Binding contract: ADR-0 docs/decisions/2026-08-17-waiting-producer-ask.md
 * items 3 (park shape), 6 (task-scoped-token auth + `to` enforcement),
 * 7 (capability gate, fail-closed, never silent).
 *
 * Registry (match-kind API, crew-broker-tokens.ts):
 *  - compound match / bare-runId fallback match / orchestrator match / no match
 *  - legacy tokenRole()/matches() semantics preserved (the bare-runId fallback
 *    is NOT consulted when a compound key exists for the task)
 *
 * Broker wait.request / wait.resolve (real socket + temp run dir):
 *  1. compound-key token parks task+manifest: task.status "waiting" +
 *     task.waiting {questionId, askedAt, deadline, options} + manifest.waitState;
 *     manifest.status stays "running"; server clamp applies at 3600s;
 *     ask.requested + task.waiting events land in events.jsonl.
 *  2. legacy bare-runId fallback token: wait.* rejected with a migrate hint;
 *     nothing parked, no ask.requested event.
 *  3. cross-task `to`: rejected server-side; nothing parked.
 *  4. flag off (waitMethodsEnabled default false): policy-disabled error AND
 *     a policy.action entry in events.jsonl; nothing parked.
 *  5. wait.resolve round-trip: parked → resolved flips waiting→running, clears
 *     waitState, appends ask.answered + task.resumed; a questionId mismatch is
 *     rejected WITHOUT clearing anything.
 *
 * Task 10 (mux-surface A1 §5.2) — revokeTaskToken + stale-token hello:
 *  6. valid hello ok → revokeTaskToken(taskId) → re-hello with the old token
 *     is rejected with code "revoked";
 *  7. an ALREADY-authed connection is rejected at the next request entry
 *     (no force-close — A1 enforces at the frame boundary);
 *  8. hello against a terminal run (completed) → "stale-token" even though
 *     the token still matches the heap registry;
 *  9. wrong token + ACTIVE run + matching taskId → "stale-token" (NOT the
 *     generic auth error) so a re-attaching surface worker can tell a stale
 *     token from a fabricated one;
 * 10. wrong token + unknown taskId / unknown run → generic auth (no
 *     disclosure of which id was valid).
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
import { BrokerTokenRegistry } from "../../../../src/runtime/broker/crew-broker-tokens.ts";
import type { TeamEvent } from "../../../../src/state/event-log/event-log.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../../../src/utils/ndjson.ts";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function tempSocketPath(suffix: string): string {
	// Keep the path short: macOS sun_path budget is 104 bytes. See
	// crew-broker-handshake.test.ts for the rationale.
	const tok = randomBytes(3).toString("hex");
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-crew-test-${tok}-${suffix}`;
	}
	return path.join(os.tmpdir(), `pwr-${tok}-${suffix}.sock`);
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
		client.waitForFrame = (predicate, timeoutMs = 2000) => {
			return new Promise((res, rej) => {
				pending.push({ resolve: res, predicate });
				setTimeout(() => rej(new Error("waitForFrame: timeout")), timeoutMs).unref();
			});
		};
		sock.on("data", (chunk: Buffer) => {
			let frames: unknown[];
			try {
				frames = client.decoder.push(chunk);
			} catch {
				return;
			}
			for (const f of frames) {
				const idx = pending.findIndex((p) => p.predicate(f));
				if (idx !== -1) {
					pending.splice(idx, 1)[0].resolve(f);
				}
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

async function startBroker(opts: { cwd: string; waitMethodsEnabled?: boolean }): Promise<{
	broker: CrewBroker;
	socketPath: string;
}> {
	const socketPath = tempSocketPath("wait");
	const broker = new CrewBroker({
		sessionId: "session-wait-test",
		socketPath,
		enabled: true,
		cwd: opts.cwd,
		...(opts.waitMethodsEnabled === undefined ? {} : { waitMethodsEnabled: opts.waitMethodsEnabled }),
	});
	await broker.start();
	return { broker, socketPath };
}

interface ScaffoldRun {
	cwd: string;
	runId: string;
	taskId: string;
	otherTaskId: string;
}

/** Create a scaffold run, then flip the executor task to "running" (and the
 *  manifest to "running") so the park precondition (task.status === "running")
 *  is realistic. */
async function scaffoldRunningTask(prefix: string): Promise<ScaffoldRun> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-wait-${prefix}-`));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: `wait-broker-${prefix}` },
		{ cwd },
	);
	const runId = run.details.runId!;
	const loaded = loadRunManifestById(cwd, runId)!;
	const executor = loaded.tasks.find((t) => t.role === "executor") ?? loaded.tasks[0];
	const other = loaded.tasks.find((t) => t.id !== executor.id)!;
	const now = new Date().toISOString();
	const updatedTasks = loaded.tasks.map((t) => (t.id === executor.id ? { ...t, status: "running" as const, startedAt: now } : t));
	saveRunTasks(loaded.manifest, updatedTasks);
	saveRunManifest({ ...loaded.manifest, status: "running", updatedAt: now });
	return { cwd, runId, taskId: executor.id, otherTaskId: other.id };
}

async function hello(client: RawClient, runId: string, taskId: string, token: string): Promise<void> {
	client.socket.write(encodeBrokerFrame({ id: "hello-1", method: "hello", params: { protocol: 1, runId, taskId, token } }));
	const ack = (await client.waitForFrame((f) => (f as { id?: string })?.id === "hello-1")) as {
		result?: { ok?: boolean };
		error?: { code: string };
	};
	assert.ok(ack?.result?.ok === true, `hello must succeed: ${JSON.stringify(ack)}`);
}

function parseEvents(eventsPath: string): TeamEvent[] {
	const raw = fs.readFileSync(eventsPath, "utf8");
	return raw
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as TeamEvent);
}

/** Read events.jsonl, polling until `until` is satisfied (max 2s). The
 *  broker's event appends go through appendEventAsync's direct async queue —
 *  flushEventLogBuffer() only drains the 20ms coalescing buffer, so a plain
 *  read can race the in-flight appendFile. Polling keeps the test both fast
 *  and deterministic. */
async function readEvents(eventsPath: string, until?: (events: TeamEvent[]) => boolean): Promise<TeamEvent[]> {
	const deadline = Date.now() + 2000;
	for (;;) {
		const events = parseEvents(eventsPath);
		if (!until || until(events)) return events;
		if (Date.now() > deadline) return events; // return what we have — assertions report the gap
		await new Promise((r) => setTimeout(r, 25));
	}
}

// ----------------------------------------------------------------------------
// Registry: tokenRoleWithMatchKind (STEP 3a)
// ----------------------------------------------------------------------------

test("registry: compound-key match is reported as compound", () => {
	const reg = new BrokerTokenRegistry();
	const runId = "run-mk-compound";
	reg.issue(runId, "task-A", "tok-compound");
	assert.deepEqual(reg.tokenRoleWithMatchKind(runId, "task-A", "tok-compound"), {
		role: "worker",
		matchKind: "compound",
	});
});

test("registry: bare-runId token matched with a taskId present is runId-fallback", () => {
	const reg = new BrokerTokenRegistry();
	const runId = "run-mk-fallback";
	reg.issue(runId, undefined, "tok-legacy");
	assert.deepEqual(reg.tokenRoleWithMatchKind(runId, "task-A", "tok-legacy"), {
		role: "worker",
		matchKind: "runId-fallback",
	});
});

test("registry: orchestrator token reports role orchestrator (compound-shaped key)", () => {
	const reg = new BrokerTokenRegistry();
	const runId = "run-mk-orch";
	reg.issueOrchestratorToken(runId, "tok-orch");
	assert.deepEqual(reg.tokenRoleWithMatchKind(runId, "task-A", "tok-orch"), {
		role: "orchestrator",
		matchKind: "compound",
	});
});

test("registry: unknown candidate returns null", () => {
	const reg = new BrokerTokenRegistry();
	const runId = "run-mk-null";
	reg.issue(runId, "task-A", "tok-real");
	assert.equal(reg.tokenRoleWithMatchKind(runId, "task-A", "nope"), null);
	assert.equal(reg.tokenRoleWithMatchKind("run-never-issued", "task-A", "tok-real"), null);
});

test("registry: legacy tokenRole()/matches() semantics preserved (no fallback when compound exists)", () => {
	const reg = new BrokerTokenRegistry();
	const runId = "run-mk-legacy";
	reg.issue(runId, "task-A", "tok-compound");
	reg.issue(runId, undefined, "tok-legacy");
	// Compound exists → the bare-runId fallback must NOT authenticate that task.
	assert.equal(reg.tokenRole(runId, "task-A", "tok-legacy"), null);
	assert.equal(reg.matches(runId, "task-A", "tok-legacy"), false);
	// Compound token still works and reports worker.
	assert.equal(reg.tokenRole(runId, "task-A", "tok-compound"), "worker");
	assert.equal(reg.matches(runId, "task-A", "tok-compound"), true);
	// No taskId → the key degenerates to bare runId: honest kind is runId-fallback.
	assert.deepEqual(reg.tokenRoleWithMatchKind(runId, undefined, "tok-legacy"), {
		role: "worker",
		matchKind: "runId-fallback",
	});
});

// ----------------------------------------------------------------------------
// Broker: wait.request park contract (STEP 3b/3c + STEP 4)
// ----------------------------------------------------------------------------

test("wait.request: compound-key token parks task+manifest (status unchanged, clamp applied)", async () => {
	const scaff = await scaffoldRunningTask("park");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd, waitMethodsEnabled: true });
	const token = broker.issueRunToken(scaff.runId, scaff.taskId);
	try {
		const client = await rawConnect(socketPath);
		await hello(client, scaff.runId, scaff.taskId, token);
		const t0 = Date.now();
		client.socket.write(
			encodeBrokerFrame({
				id: "w1",
				method: "wait.request",
				params: { to: scaff.taskId, question: "Deploy to prod now?", options: ["yes", "no"], timeoutSec: 99_999 },
			}),
		);
		const res = (await client.waitForFrame((f) => (f as { id?: string })?.id === "w1")) as {
			result?: {
				ok?: boolean;
				questionId?: string;
				askedAt?: string;
				deadline?: number;
				timeoutSec?: number;
				clamped?: boolean;
			};
			error?: { code: string; message: string };
		};
		assert.ok(!res.error, `wait.request must succeed: ${JSON.stringify(res)}`);
		assert.equal(res.result?.ok, true);
		// questionId is an unguessable randomUUID (ADR item 5).
		assert.match(res.result?.questionId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		assert.equal(res.result?.timeoutSec, 3600, "server clamp must cap at 3600s");
		assert.equal(res.result?.clamped, true);
		assert.ok(typeof res.result?.askedAt === "string" && !Number.isNaN(Date.parse(res.result.askedAt)));
		const deadline = res.result?.deadline ?? 0;
		assert.ok(deadline >= t0 + 3_599_000, `deadline must be ~now+3600s (got ${deadline}, t0 ${t0})`);
		assert.ok(deadline <= Date.now() + 3_600_500, "deadline must never exceed now+3600s");

		const reloaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		const task = reloaded.tasks.find((t) => t.id === scaff.taskId)!;
		assert.equal(task.status, "waiting", "park flips the TASK status to waiting");
		assert.equal(task.waiting?.questionId, res.result?.questionId);
		assert.equal(task.waiting?.deadline, deadline);
		assert.deepEqual(task.waiting?.options, ["yes", "no"]);
		assert.equal(task.waiting?.askedAt, res.result?.askedAt);
		// manifest.waitState pointer set; manifest.status NEVER flips (ADR item 3).
		assert.deepEqual(reloaded.manifest.waitState, {
			taskId: scaff.taskId,
			questionId: res.result?.questionId,
			askedAt: res.result?.askedAt,
		});
		assert.equal(reloaded.manifest.status, "running");

		const events = await readEvents(
			reloaded.manifest.eventsPath,
			(ev) => ev.some((e) => e.type === "ask.requested") && ev.some((e) => e.type === "task.waiting"),
		);
		const asked = events.find((e) => e.type === "ask.requested");
		assert.ok(asked, "ask.requested event must be appended");
		assert.equal(asked?.taskId, scaff.taskId);
		assert.equal(asked?.message, "Deploy to prod now?");
		assert.equal((asked?.data as Record<string, unknown> | undefined)?.questionId, res.result?.questionId);
		assert.equal((asked?.data as Record<string, unknown> | undefined)?.clamped, true);
		const waitingEvt = events.find((e) => e.type === "task.waiting");
		assert.ok(waitingEvt, "task.waiting lifecycle event must mirror the persisted status flip");
		client.close();
	} finally {
		await broker.stop();
		fs.rmSync(scaff.cwd, { recursive: true, force: true });
	}
});

test("wait.request: legacy bare-runId fallback token rejected with migrate hint, nothing parked", async () => {
	const scaff = await scaffoldRunningTask("legacy");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd, waitMethodsEnabled: true });
	// Legacy model: token issued WITHOUT taskId; hello still auths via fallback.
	const legacyToken = broker.issueRunToken(scaff.runId);
	try {
		const client = await rawConnect(socketPath);
		await hello(client, scaff.runId, scaff.taskId, legacyToken);
		client.socket.write(
			encodeBrokerFrame({
				id: "w1",
				method: "wait.request",
				params: { to: scaff.taskId, question: "legacy token ask?", timeoutSec: 60 },
			}),
		);
		const res = (await client.waitForFrame((f) => (f as { id?: string })?.id === "w1")) as {
			error?: { code: string; message: string };
		};
		assert.equal(res.error?.code, "forbidden");
		assert.match(res.error?.message ?? "", /task-scoped token/);
		assert.match(res.error?.message ?? "", /PI_CREW_BROKER_TASK_ID/, "error must carry the migrate hint");

		const reloaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		const task = reloaded.tasks.find((t) => t.id === scaff.taskId)!;
		assert.equal(task.status, "running", "task must NOT be parked");
		assert.equal(task.waiting, undefined);
		assert.equal(reloaded.manifest.waitState, undefined);
		const events = await readEvents(reloaded.manifest.eventsPath);
		assert.equal(
			events.find((e) => e.type === "ask.requested"),
			undefined,
			"no ask.requested event",
		);
		client.close();
	} finally {
		await broker.stop();
		fs.rmSync(scaff.cwd, { recursive: true, force: true });
	}
});

test("wait.request: cross-task 'to' rejected server-side, nothing parked", async () => {
	const scaff = await scaffoldRunningTask("crossto");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd, waitMethodsEnabled: true });
	const token = broker.issueRunToken(scaff.runId, scaff.taskId);
	try {
		const client = await rawConnect(socketPath);
		await hello(client, scaff.runId, scaff.taskId, token);
		client.socket.write(
			encodeBrokerFrame({
				id: "w1",
				method: "wait.request",
				params: { to: scaff.otherTaskId, question: "park someone else?", timeoutSec: 60 },
			}),
		);
		const res = (await client.waitForFrame((f) => (f as { id?: string })?.id === "w1")) as {
			error?: { code: string; message: string };
		};
		assert.equal(res.error?.code, "forbidden");
		assert.match(res.error?.message ?? "", /must match the authenticated task/);

		const reloaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		for (const t of reloaded.tasks) {
			assert.notEqual(t.status, "waiting", `task ${t.id} must NOT be parked`);
			assert.equal(t.waiting, undefined);
		}
		assert.equal(reloaded.manifest.waitState, undefined);
		const events = await readEvents(reloaded.manifest.eventsPath);
		assert.equal(
			events.find((e) => e.type === "ask.requested"),
			undefined,
		);
		client.close();
	} finally {
		await broker.stop();
		fs.rmSync(scaff.cwd, { recursive: true, force: true });
	}
});

test("wait.request: flag off (default) → policy-disabled error AND policy.action event, nothing parked", async () => {
	const scaff = await scaffoldRunningTask("flagoff");
	// waitMethodsEnabled omitted → default false (fail-closed).
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd });
	const token = broker.issueRunToken(scaff.runId, scaff.taskId);
	try {
		const client = await rawConnect(socketPath);
		await hello(client, scaff.runId, scaff.taskId, token);
		client.socket.write(
			encodeBrokerFrame({
				id: "w1",
				method: "wait.request",
				params: { to: scaff.taskId, question: "gated ask?", timeoutSec: 60 },
			}),
		);
		const res = (await client.waitForFrame((f) => (f as { id?: string })?.id === "w1")) as {
			error?: { code: string; message: string };
		};
		assert.equal(res.error?.code, "policy-disabled");
		assert.match(res.error?.message ?? "", /waitMethodsEnabled/);

		const reloaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		const task = reloaded.tasks.find((t) => t.id === scaff.taskId)!;
		assert.equal(task.status, "running", "task must NOT be parked while gated");
		assert.equal(reloaded.manifest.waitState, undefined);
		// Fail-closed but NEVER silent: the rejection is durable in events.jsonl.
		// (The scaffold run itself emits policy.action "closeout" events — match
		// on OUR reason, not on the first policy.action.)
		const events = await readEvents(reloaded.manifest.eventsPath, (ev) =>
			ev.some(
				(e) => e.type === "policy.action" && (e.data as Record<string, unknown> | undefined)?.reason === "wait-methods-disabled",
			),
		);
		const policy = events.find(
			(e) => e.type === "policy.action" && (e.data as Record<string, unknown> | undefined)?.reason === "wait-methods-disabled",
		);
		assert.ok(policy, "policy.action event must be appended when the gate rejects");
		assert.equal((policy?.data as Record<string, unknown> | undefined)?.action, "wait.request");
		assert.equal((policy?.data as Record<string, unknown> | undefined)?.reason, "wait-methods-disabled");
		assert.equal(
			events.find((e) => e.type === "ask.requested"),
			undefined,
		);
		client.close();
	} finally {
		await broker.stop();
		fs.rmSync(scaff.cwd, { recursive: true, force: true });
	}
});

// ----------------------------------------------------------------------------
// Broker: wait.resolve (STEP 4, terminal report)
// ----------------------------------------------------------------------------

test("wait.resolve: parked task resolves waiting→running, waitState cleared, events appended; mismatch rejected", async () => {
	const scaff = await scaffoldRunningTask("resolve");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd, waitMethodsEnabled: true });
	const token = broker.issueRunToken(scaff.runId, scaff.taskId);
	try {
		const client = await rawConnect(socketPath);
		await hello(client, scaff.runId, scaff.taskId, token);
		// Park first (default timeout: 600s, unclamped).
		client.socket.write(encodeBrokerFrame({ id: "w1", method: "wait.request", params: { to: scaff.taskId, question: "Continue?" } }));
		const park = (await client.waitForFrame((f) => (f as { id?: string })?.id === "w1")) as {
			result?: { ok?: boolean; questionId?: string; timeoutSec?: number; clamped?: boolean };
		};
		assert.equal(park.result?.ok, true);
		assert.equal(park.result?.timeoutSec, 600, "default timeoutSec is 600");
		assert.equal(park.result?.clamped, false);
		const questionId = park.result?.questionId ?? "";
		assert.ok(questionId.length > 0, "park result must carry a questionId");

		// Mismatched questionId → rejected WITHOUT clearing the park.
		client.socket.write(
			encodeBrokerFrame({ id: "r1", method: "wait.resolve", params: { to: scaff.taskId, questionId: "not-the-question" } }),
		);
		const bad = (await client.waitForFrame((f) => (f as { id?: string })?.id === "r1")) as {
			error?: { code: string };
		};
		assert.equal(bad.error?.code, "bad-params");
		let reloaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		let task = reloaded.tasks.find((t) => t.id === scaff.taskId)!;
		assert.equal(task.status, "waiting", "mismatched resolve must not clear the park");
		assert.ok(reloaded.manifest.waitState);

		// Correct resolve → waiting→running, waitState cleared.
		client.socket.write(encodeBrokerFrame({ id: "r2", method: "wait.resolve", params: { to: scaff.taskId, questionId } }));
		const ok = (await client.waitForFrame((f) => (f as { id?: string })?.id === "r2")) as {
			result?: { ok?: boolean; questionId?: string };
			error?: { code: string };
		};
		assert.ok(!ok.error, `wait.resolve must succeed: ${JSON.stringify(ok)}`);
		assert.equal(ok.result?.ok, true);
		assert.equal(ok.result?.questionId, questionId);

		reloaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		task = reloaded.tasks.find((t) => t.id === scaff.taskId)!;
		assert.equal(task.status, "running", "resolve flips the task back to running");
		assert.equal(task.waiting, undefined);
		assert.equal(reloaded.manifest.waitState, undefined, "manifest.waitState cleared");
		assert.equal(reloaded.manifest.status, "running");

		const events = await readEvents(
			reloaded.manifest.eventsPath,
			(ev) => ev.some((e) => e.type === "ask.answered") && ev.some((e) => e.type === "task.resumed"),
		);
		assert.ok(
			events.find((e) => e.type === "ask.answered"),
			"ask.answered event must be appended",
		);
		assert.ok(
			events.find((e) => e.type === "task.resumed"),
			"task.resumed lifecycle event must be appended",
		);
		client.close();
	} finally {
		await broker.stop();
		fs.rmSync(scaff.cwd, { recursive: true, force: true });
	}
});

test("wait.resolve: flag off → policy-disabled error AND policy.action event", async () => {
	const scaff = await scaffoldRunningTask("resolveoff");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd });
	const token = broker.issueRunToken(scaff.runId, scaff.taskId);
	try {
		const client = await rawConnect(socketPath);
		await hello(client, scaff.runId, scaff.taskId, token);
		client.socket.write(encodeBrokerFrame({ id: "r1", method: "wait.resolve", params: { to: scaff.taskId, questionId: "q-any" } }));
		const res = (await client.waitForFrame((f) => (f as { id?: string })?.id === "r1")) as {
			error?: { code: string; message: string };
		};
		assert.equal(res.error?.code, "policy-disabled");
		assert.match(res.error?.message ?? "", /waitMethodsEnabled/);
		const reloaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		const events = await readEvents(reloaded.manifest.eventsPath, (ev) =>
			ev.some(
				(e) => e.type === "policy.action" && (e.data as Record<string, unknown> | undefined)?.reason === "wait-methods-disabled",
			),
		);
		const policy = events.find(
			(e) => e.type === "policy.action" && (e.data as Record<string, unknown> | undefined)?.reason === "wait-methods-disabled",
		);
		assert.ok(policy, "policy.action event must be appended");
		assert.equal((policy?.data as Record<string, unknown> | undefined)?.action, "wait.resolve");
		client.close();
	} finally {
		await broker.stop();
		fs.rmSync(scaff.cwd, { recursive: true, force: true });
	}
});

// ----------------------------------------------------------------------------
// Task 10 (mux-surface A1 §5.2): revokeTaskToken + stale-token hello errors
// ----------------------------------------------------------------------------

test("revokeTaskToken: valid hello ok → revoke → re-hello with the old token is 'revoked'", async () => {
	const scaff = await scaffoldRunningTask("revoke");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd });
	const token = broker.issueRunToken(scaff.runId, scaff.taskId);
	try {
		const client = await rawConnect(socketPath);
		await hello(client, scaff.runId, scaff.taskId, token);
		client.close();

		broker.revokeTaskToken(scaff.taskId);

		const client2 = await rawConnect(socketPath);
		client2.socket.write(
			encodeBrokerFrame({ id: "hello-r", method: "hello", params: { protocol: 1, runId: scaff.runId, taskId: scaff.taskId, token } }),
		);
		const res = (await client2.waitForFrame((f) => (f as { id?: string })?.id === "hello-r")) as {
			result?: { ok?: boolean };
			error?: { code: string; message: string };
		};
		assert.equal(res.error?.code, "revoked");
		assert.match(res.error?.message ?? "", /revoked/i);
		client2.close();
	} finally {
		await broker.stop();
		fs.rmSync(scaff.cwd, { recursive: true, force: true });
	}
});

test("revokeTaskToken: already-authed connection is rejected at the next request entry (no force-close)", async () => {
	const scaff = await scaffoldRunningTask("revokeinflight");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd, waitMethodsEnabled: true });
	const token = broker.issueRunToken(scaff.runId, scaff.taskId);
	try {
		const client = await rawConnect(socketPath);
		await hello(client, scaff.runId, scaff.taskId, token);

		broker.revokeTaskToken(scaff.taskId);

		// The open connection is NOT force-closed by the revoke itself; the
		// NEXT frame on it is rejected with 'revoked' and the conn closes.
		client.socket.write(encodeBrokerFrame({ id: "p-1", method: "ping", params: null }));
		const res = (await client.waitForFrame((f) => (f as { id?: string })?.id === "p-1")) as {
			result?: { pong?: boolean };
			error?: { code: string; message: string };
		};
		assert.equal(res.error?.code, "revoked");
		assert.ok(!res.result?.pong, "revoked token must not answer ping");
		await new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
	} finally {
		await broker.stop();
		fs.rmSync(scaff.cwd, { recursive: true, force: true });
	}
});

test("hello: run terminal (completed) → 'stale-token' even though the token still matches", async () => {
	const scaff = await scaffoldRunningTask("terminal");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd });
	const token = broker.issueRunToken(scaff.runId, scaff.taskId);
	// Flip the run to a terminal status on disk.
	const loaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
	saveRunManifest({ ...loaded.manifest, status: "completed", updatedAt: new Date().toISOString() });
	try {
		const client = await rawConnect(socketPath);
		client.socket.write(
			encodeBrokerFrame({ id: "hello-t", method: "hello", params: { protocol: 1, runId: scaff.runId, taskId: scaff.taskId, token } }),
		);
		const res = (await client.waitForFrame((f) => (f as { id?: string })?.id === "hello-t")) as {
			result?: { ok?: boolean };
			error?: { code: string; message: string };
		};
		assert.equal(res.error?.code, "stale-token");
		assert.match(res.error?.message ?? "", /stale/i);
		client.close();
	} finally {
		await broker.stop();
		fs.rmSync(scaff.cwd, { recursive: true, force: true });
	}
});

test("hello: wrong token + ACTIVE run + matching taskId → 'stale-token', not generic auth", async () => {
	const scaff = await scaffoldRunningTask("staleactive");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd });
	broker.issueRunToken(scaff.runId, scaff.taskId);
	try {
		const client = await rawConnect(socketPath);
		client.socket.write(
			encodeBrokerFrame({
				id: "hello-s",
				method: "hello",
				params: { protocol: 1, runId: scaff.runId, taskId: scaff.taskId, token: "token-not-from-this-broker" },
			}),
		);
		const res = (await client.waitForFrame((f) => (f as { id?: string })?.id === "hello-s")) as {
			error?: { code: string; message: string };
		};
		assert.equal(res.error?.code, "stale-token");
		assert.match(res.error?.message ?? "", /stale/i);
		client.close();
	} finally {
		await broker.stop();
		fs.rmSync(scaff.cwd, { recursive: true, force: true });
	}
});

test("hello: wrong token + unknown taskId (run active) + unknown run → generic auth (no disclosure)", async () => {
	const scaff = await scaffoldRunningTask("generic");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd });
	broker.issueRunToken(scaff.runId, scaff.taskId);
	try {
		const client = await rawConnect(socketPath);
		// Run exists but the taskId does not — must stay generic.
		client.socket.write(
			encodeBrokerFrame({
				id: "hello-g1",
				method: "hello",
				params: { protocol: 1, runId: scaff.runId, taskId: "no-such-task", token: "x" },
			}),
		);
		const res1 = (await client.waitForFrame((f) => (f as { id?: string })?.id === "hello-g1")) as {
			error?: { code: string; message: string };
		};
		assert.equal(res1.error?.code, "auth");
		assert.equal(res1.error?.message, "hello rejected");

		// Run does not exist at all — generic too.
		const client2 = await rawConnect(socketPath);
		client2.socket.write(
			encodeBrokerFrame({
				id: "hello-g2",
				method: "hello",
				params: { protocol: 1, runId: "run-not-on-disk", taskId: "task-A", token: "x" },
			}),
		);
		const res2 = (await client2.waitForFrame((f) => (f as { id?: string })?.id === "hello-g2")) as {
			error?: { code: string; message: string };
		};
		assert.equal(res2.error?.code, "auth");
		assert.equal(res2.error?.message, "hello rejected");
		client.close();
		client2.close();
	} finally {
		await broker.stop();
		fs.rmSync(scaff.cwd, { recursive: true, force: true });
	}
});

test("P1 wiring: disabled waitMethodsEnabled rejects wait.request with the policy message (production fail-closed path)", async () => {
	// WP-2 review round 1 (P1): lifecycle-handlers now threads
	// cfg?.waitMethodsEnabled ?? false into the production CrewBroker. The
	// constructor default (false) previously made the flag a dead knob. This
	// pins the fail-closed contract end-to-end: valid compound token + hello
	// + flag OFF -> structured policy rejection, nothing parked.
	const scaff = await scaffoldRunningTask("wiring");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd, waitMethodsEnabled: false });
	const token = broker.issueRunToken(scaff.runId, scaff.taskId);
	try {
		const client = await rawConnect(socketPath);
		await hello(client, scaff.runId, scaff.taskId, token);
		client.socket.write(
			encodeBrokerFrame({ id: "wr-1", method: "wait.request", params: { to: scaff.taskId, question: "wiring?", timeoutSec: 30 } }),
		);
		const frame = (await client.waitForFrame((f) => (f as { id?: string })?.id === "wr-1")) as {
			error?: { code?: string; message?: string };
		};
		assert.ok(frame?.error, "disabled waitMethodsEnabled must reject wait.request");
		assert.match(frame.error.message ?? frame.error.code ?? "", /disabled|policy/i);
		client.socket.destroy();
	} finally {
		await broker.stop();
		fs.rmSync(scaff.cwd, { recursive: true, force: true });
	}
});

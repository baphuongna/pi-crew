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
 * 11. M3-6 (R21-M1): resolving one of TWO concurrent parks must NOT un-shield
 *     the other — the single run-level waitState slot is re-pointed at the
 *     still-parked task (isWaitAnswerPending stays true) instead of cleared.
 * 12. M4-R1(a) (fix-wave 6 residual): the PARK write must not shorten the
 *     shield either — the slot follows the park with the LATEST deadline, so a
 *     newer-but-shorter park never replaces a longer-lived one.
 * 13. M4-R1(b): the sibling slot writers (respond requeue / ask-timeout
 *     requeue) re-point through the same helper instead of clearing the slot
 *     while another task is still parked.
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
import { __test__repointedWaitState, repointWaitState } from "../../../../src/runtime/broker/protocol/wait-resolve.ts";
import { isWaitAnswerPending } from "../../../../src/runtime/stale-reconciler.ts";
import type { TeamEvent } from "../../../../src/state/event-log/event-log.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../../../src/utils/ndjson.ts";
import { teardownCwd } from "../../../fixtures/teardown-cwd.ts";

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
	saveRunManifest({ ...loaded.manifest, status: "running", updatedAt: now }, { allowTerminalExit: true });
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

test("registry: bare-runId token does NOT match an explicit taskId claim (w1a fallback retired)", () => {
	const reg = new BrokerTokenRegistry();
	const runId = "run-mk-fallback";
	reg.issue(runId, undefined, "tok-legacy");
	// broker-bare-run-token-forged-task-identity: an identity claim must be
	// proven by the compound key — the bare per-run token binds nothing.
	assert.equal(reg.tokenRoleWithMatchKind(runId, "task-A", "tok-legacy"), null);
	// A NO-taskId hello still resolves via the bare key (legacy model).
	assert.deepEqual(reg.tokenRoleWithMatchKind(runId, undefined, "tok-legacy"), {
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
		// R2-M-A2 (wave-4): the broker also stamps the (clamped) deadline onto the
		// manifest pointer so the stale-reconciler shield derives from it.
		assert.deepEqual(reloaded.manifest.waitState, {
			taskId: scaff.taskId,
			questionId: res.result?.questionId,
			askedAt: res.result?.askedAt,
			deadline,
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
		teardownCwd(scaff.cwd);
	}
});

test("wait.request: legacy bare-runId token cannot bind an explicit taskId (rejected at hello, nothing parked)", async () => {
	const scaff = await scaffoldRunningTask("legacy");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd, waitMethodsEnabled: true });
	// Legacy model: token issued WITHOUT taskId. w1a retired the runId-fallback
	// for EXPLICIT taskId claims, so hello itself now REJECTS (the claim is not
	// proven by any compound key; the run+task exist → classified stale-token).
	// Even stronger than the old hello-accepted/forbidden-at-wait shape: the
	// forged identity never binds at all.
	const legacyToken = broker.issueRunToken(scaff.runId);
	try {
		const client = await rawConnect(socketPath);
		client.socket.write(
			encodeBrokerFrame({
				id: "hello-1",
				method: "hello",
				params: { protocol: 1, runId: scaff.runId, taskId: scaff.taskId, token: legacyToken },
			}),
		);
		const ack = (await client.waitForFrame((f) => (f as { id?: string })?.id === "hello-1")) as {
			result?: { ok?: boolean };
			error?: { code: string; message?: string };
		};
		assert.ok(!ack.result?.ok, "hello must NOT succeed with a bare token for an explicit taskId");
		assert.ok(ack.error, "hello must return an auth-class error");
		assert.ok(typeof ack.error?.code === "string" && ack.error.code.length > 0);
		client.socket.write(
			encodeBrokerFrame({
				id: "w1",
				method: "wait.request",
				params: { to: scaff.taskId, question: "legacy token ask?", timeoutSec: 60 },
			}),
		);
		// The broker closes an unauthenticated connection at hello rejection
		// (sendErrorAndClose) — the wait.request frame can never park anything.

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
		teardownCwd(scaff.cwd);
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
		teardownCwd(scaff.cwd);
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
		teardownCwd(scaff.cwd);
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
		// Park first (F2: default timeout is 480s — must stay strictly below the
		// 600s response watchdog so the parked worker wakes before being killed;
		// unclamped).
		client.socket.write(encodeBrokerFrame({ id: "w1", method: "wait.request", params: { to: scaff.taskId, question: "Continue?" } }));
		const park = (await client.waitForFrame((f) => (f as { id?: string })?.id === "w1")) as {
			result?: { ok?: boolean; questionId?: string; timeoutSec?: number; clamped?: boolean };
		};
		assert.equal(park.result?.ok, true);
		assert.equal(park.result?.timeoutSec, 480, "default timeoutSec is 480 (F2: < response watchdog 600s)");
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
		teardownCwd(scaff.cwd);
	}
});

// ----------------------------------------------------------------------------
// Broker: wait.resolve outcome discrimination (G5 respond-delivery ack)
// ----------------------------------------------------------------------------

test("wait.resolve G5: outcome answered → task.respond_delivered ack with taskId/questionId/pid; timed-out → no delivery claim", async () => {
	const scaff = await scaffoldRunningTask("g5deliv");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd, waitMethodsEnabled: true });
	const token = broker.issueRunToken(scaff.runId, scaff.taskId);
	try {
		const client = await rawConnect(socketPath);
		await hello(client, scaff.runId, scaff.taskId, token);

		// Park #1 → resolve with outcome "timed-out": the park clears and the
		// lifecycle events land, but NO delivery is claimed — a timed-out park
		// never picked up a mailbox response.
		client.socket.write(encodeBrokerFrame({ id: "w1", method: "wait.request", params: { to: scaff.taskId, question: "Q1" } }));
		const park1 = (await client.waitForFrame((f) => (f as { id?: string })?.id === "w1")) as { result?: { questionId?: string } };
		const q1 = park1.result?.questionId ?? "";
		assert.ok(q1.length > 0, "park #1 must return a questionId");
		client.socket.write(
			encodeBrokerFrame({ id: "r1", method: "wait.resolve", params: { to: scaff.taskId, questionId: q1, outcome: "timed-out" } }),
		);
		const res1 = (await client.waitForFrame((f) => (f as { id?: string })?.id === "r1")) as {
			result?: { ok?: boolean };
			error?: { code: string };
		};
		assert.ok(!res1.error, `timed-out resolve must succeed: ${JSON.stringify(res1)}`);
		const eventsPath = loadRunManifestById(scaff.cwd, scaff.runId)!.manifest.eventsPath;
		await readEvents(eventsPath, (ev) => ev.some((e) => e.type === "task.resumed"));
		// Drain the fire-and-forget window before judging the absence.
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.ok(
			!parseEvents(eventsPath).some((e) => e.type === "task.respond_delivered"),
			"timed-out resolve must NOT emit a delivery ack",
		);

		// Park #2 (task flipped back to running) — seed a heartbeat pid on the
		// parked task so the ack carries the liveness-pid evidence, then resolve
		// with outcome "answered": the worker-claimed pickup of the mailbox
		// response → respond_delivered ack.
		client.socket.write(encodeBrokerFrame({ id: "w2", method: "wait.request", params: { to: scaff.taskId, question: "Q2" } }));
		const park2 = (await client.waitForFrame((f) => (f as { id?: string })?.id === "w2")) as { result?: { questionId?: string } };
		const q2 = park2.result?.questionId ?? "";
		assert.ok(q2.length > 0 && q2 !== q1, "park #2 must return a fresh questionId");
		{
			const loaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
			saveRunTasks(
				loaded.manifest,
				loaded.tasks.map((t) =>
					t.id === scaff.taskId
						? { ...t, heartbeat: { workerId: t.id, pid: process.pid, lastSeenAt: new Date().toISOString(), alive: true } }
						: t,
				),
			);
		}
		client.socket.write(
			encodeBrokerFrame({ id: "r2", method: "wait.resolve", params: { to: scaff.taskId, questionId: q2, outcome: "answered" } }),
		);
		const res2 = (await client.waitForFrame((f) => (f as { id?: string })?.id === "r2")) as {
			result?: { ok?: boolean };
			error?: { code: string };
		};
		assert.ok(!res2.error, `answered resolve must succeed: ${JSON.stringify(res2)}`);

		const events = await readEvents(eventsPath, (ev) => ev.some((e) => e.type === "task.respond_delivered"));
		const delivered = events.filter((e) => e.type === "task.respond_delivered");
		assert.equal(delivered.length, 1, "exactly one respond_delivered ack");
		const ack = delivered[0]!;
		assert.equal(ack.taskId, scaff.taskId, "ack names the waiting task");
		assert.equal(ack.runId, scaff.runId);
		const data = ack.data as Record<string, unknown> | undefined;
		assert.equal(data?.questionId, q2, "ack carries the delivered questionId");
		assert.equal(data?.workerPid, process.pid, "ack carries the heartbeat pid (liveness parity with respond_missed)");
		// respond_missed is the ROOT-side (leader respond path) twin — the broker
		// never emits it.
		assert.ok(!events.some((e) => e.type === "task.respond_missed"), "broker must not emit respond_missed");
		client.close();
	} finally {
		await broker.stop();
		teardownCwd(scaff.cwd);
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
		teardownCwd(scaff.cwd);
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
		teardownCwd(scaff.cwd);
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
		teardownCwd(scaff.cwd);
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
		teardownCwd(scaff.cwd);
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
		teardownCwd(scaff.cwd);
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
		teardownCwd(scaff.cwd);
	}
});

// ----------------------------------------------------------------------------
// Task 10 fix round 1: re-issue after revoke + orchestrator role exemption
// ----------------------------------------------------------------------------

test("registry: issue() after revokeToken returns a FRESH secret (idempotent reuse must not resurrect a revoked token)", () => {
	const reg = new BrokerTokenRegistry();
	const runId = "run-reissue";
	const t1 = reg.issue(runId, "task-A");
	reg.revokeToken(t1);
	assert.equal(reg.isTaskTokenRevoked(runId, "task-A"), true, "revoked before re-issue");
	// BUG #1 (fix round 1): issue() was idempotent per key and returned the
	// very token that had just been revoked — the degrade respawn flow then
	// hands a dead token to the new worker.
	const t2 = reg.issue(runId, "task-A");
	assert.notEqual(t2, t1, "re-issue must mint a fresh secret, not reuse the revoked one");
	assert.equal(reg.isTaskTokenRevoked(runId, "task-A"), false, "new token must not be revoked");
	assert.equal(reg.tokenRole(runId, "task-A", t2), "worker", "fresh token authenticates");
	assert.equal(reg.tokenRole(runId, "task-A", t1), null, "old token stays dead (no longer registered)");
});

test("revokeTaskToken + re-issue: respawned worker authenticates with the fresh token (degrade flow)", async () => {
	const scaff = await scaffoldRunningTask("reissue");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd, waitMethodsEnabled: true });
	const deadToken = broker.issueRunToken(scaff.runId, scaff.taskId);
	broker.revokeTaskToken(scaff.taskId);
	try {
		const freshToken = broker.issueRunToken(scaff.runId, scaff.taskId);
		assert.notEqual(freshToken, deadToken, "re-issue must return a different secret");

		const client = await rawConnect(socketPath);
		await hello(client, scaff.runId, scaff.taskId, freshToken);
		// The fresh token must carry full worker capability — park + resolve.
		client.socket.write(encodeBrokerFrame({ id: "w1", method: "wait.request", params: { to: scaff.taskId, question: "respawned?" } }));
		const res = (await client.waitForFrame((f) => (f as { id?: string })?.id === "w1")) as {
			result?: { ok?: boolean };
			error?: { code: string };
		};
		assert.ok(!res.error, `wait.request with the re-issued token must succeed: ${JSON.stringify(res)}`);
		assert.equal(res.result?.ok, true);
		client.close();
	} finally {
		await broker.stop();
		teardownCwd(scaff.cwd);
	}
});

test("revokeTaskToken: already-authed connection STAYS revoked across a re-issue (secret-based frame check)", async () => {
	const scaff = await scaffoldRunningTask("revokewin");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd });
	const t2 = broker.issueRunToken(scaff.runId, scaff.taskId);
	try {
		const client = await rawConnect(socketPath);
		await hello(client, scaff.runId, scaff.taskId, t2);

		broker.revokeTaskToken(scaff.taskId);
		// Re-issue for the respawn (spec §7 degrade): a NEW worker gets t3.
		const t3 = broker.issueRunToken(scaff.runId, scaff.taskId);
		assert.notEqual(t3, t2);

		// BUG #3 (fix round 2): the frame-entry check used to look up the
		// token CURRENTLY registered for the key — after the re-issue that is
		// t3 (not revoked), so the OLD connection authenticated with the
		// revoked t2 silently regained full capability. The check must be
		// secret-based: the connection stays dead even though the key is live.
		client.socket.write(encodeBrokerFrame({ id: "p-1", method: "ping", params: null }));
		const res = (await client.waitForFrame((f) => (f as { id?: string })?.id === "p-1")) as {
			result?: { pong?: boolean };
			error?: { code: string };
		};
		assert.equal(res.error?.code, "revoked", "frame on a revoked-secret connection must be rejected");
		assert.ok(!res.result?.pong);
		await new Promise<void>((resolve) => client.socket.once("close", () => resolve()));

		// Control: the respawned worker with t3 is unaffected.
		const client2 = await rawConnect(socketPath);
		await hello(client2, scaff.runId, scaff.taskId, t3);
		client2.socket.write(encodeBrokerFrame({ id: "p-2", method: "ping", params: null }));
		const pong = (await client2.waitForFrame((f) => (f as { id?: string })?.id === "p-2")) as {
			result?: { pong?: boolean };
		};
		assert.equal(pong.result?.pong, true);
		client2.close();
	} finally {
		await broker.stop();
		teardownCwd(scaff.cwd);
	}
});

test("revokeTaskToken: orchestrator role is exempt from the revoked check (hello + frames)", async () => {
	const scaff = await scaffoldRunningTask("orchexempt");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd });
	broker.issueRunToken(scaff.runId, scaff.taskId);
	broker.revokeTaskToken(scaff.taskId);
	const orchToken = broker.issueOrchestratorToken(scaff.runId);
	try {
		const client = await rawConnect(socketPath);
		// BUG #2 (fix round 1): the revoked check keyed on (runId, taskId)
		// without a role guard, so an orchestrator hello naming the revoked
		// task as its taskId was rejected with 'revoked' — breaking the T11
		// degrade flow (orchestrator steers after revoking a task).
		await hello(client, scaff.runId, scaff.taskId, orchToken);
		client.socket.write(encodeBrokerFrame({ id: "p-1", method: "ping", params: null }));
		const pong = (await client.waitForFrame((f) => (f as { id?: string })?.id === "p-1")) as {
			result?: { pong?: boolean };
			error?: { code: string };
		};
		assert.ok(!pong.error, `orchestrator frames must not hit the revoked check: ${JSON.stringify(pong)}`);
		assert.equal(pong.result?.pong, true);
		client.close();
	} finally {
		await broker.stop();
		teardownCwd(scaff.cwd);
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
		teardownCwd(scaff.cwd);
	}
});

test("F1: wait.request pushes the question to a registered sync foreground waiter (resolveRunPromise)", async () => {
	const scaff = await scaffoldRunningTask("f1push");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd, waitMethodsEnabled: true });
	const token = broker.issueRunToken(scaff.runId, scaff.taskId);
	// Register the foreground waiter exactly like team-tool run.ts does for a
	// sync run — the broker's park must release it with the waiting payload.
	const { registerRunPromise } = await import("../../../../src/runtime/run-tracker.ts");
	const entry = registerRunPromise(scaff.runId);
	const waiter = entry.promise;
	try {
		const client = await rawConnect(socketPath);
		await hello(client, scaff.runId, scaff.taskId, token);
		client.socket.write(
			encodeBrokerFrame({
				id: "f1-1",
				method: "wait.request",
				params: { to: scaff.taskId, question: "Authorize the override?", options: ["yes", "no"], timeoutSec: 60 },
			}),
		);
		const settled = await waiter;
		assert.ok(settled.waiting, "waiter released with a waiting payload");
		assert.equal(settled.waiting?.taskId, scaff.taskId);
		assert.equal(settled.waiting?.question, "Authorize the override?");
		assert.deepEqual(settled.waiting?.options, ["yes", "no"]);
		assert.ok(typeof settled.waiting?.questionId === "string" && settled.waiting.questionId.length > 0);
		assert.ok(typeof settled.waiting?.deadline === "number");
		await client.close();
	} finally {
		await broker.stop();
	}
});

// ----------------------------------------------------------------------------
// M3-6 (R21-M1, fix-wave 6): scoped waitState clear — one resolve must never
// un-shield a DIFFERENT task that is still parked.
// ----------------------------------------------------------------------------

const WAITING = (deadline: number, questionId: string) => ({
	questionId,
	askedAt: new Date(Date.now() - 1000).toISOString(),
	deadline,
});

test("M4-R1(b) unit: repointWaitState(predicate) re-points at a surviving park, clears only when alone", () => {
	const now = Date.now();
	const parkedA = { id: "task-a", status: "waiting" as const, waiting: WAITING(now + 3_600_000, "qA") };
	const parkedB = { id: "task-b", status: "waiting" as const, waiting: WAITING(now + 60_000, "qB") };
	const running = { id: "task-c", status: "running" as const };
	const ended = new Set(["task-b"]);
	const isEnded = (taskId: string) => ended.has(taskId);
	const slotB = { taskId: "task-b", questionId: "qB", askedAt: "x", deadline: now + 60_000 };

	// Slot owned by an ended park + a sibling still parked → re-point at the
	// sibling (latest deadline wins) — the respond / ask-timeout writers' fix.
	const repointed = repointWaitState([parkedA, parkedB, running] as never, slotB, isEnded);
	assert.equal(repointed?.taskId, "task-a");
	assert.equal(repointed?.questionId, "qA");
	assert.equal(repointed?.deadline, now + 3_600_000);

	// The ended park is excluded even while the input view still flags it
	// "waiting" (wait.resolve and the requeue writers pass different views).
	const stillWaitingEnded = { id: "task-b", status: "waiting" as const, waiting: WAITING(now + 10_000_000, "qB") };
	assert.equal(repointWaitState([stillWaitingEnded, parkedA] as never, slotB, isEnded)?.taskId, "task-a");

	// Slot owned by an ended park + nothing else parked → cleared.
	assert.equal(repointWaitState([running] as never, slotB, isEnded), undefined);

	// Slot owned by a park that is NOT ended → untouched.
	const untouched = { taskId: "task-a", questionId: "qA", askedAt: "x", deadline: now };
	assert.deepEqual(repointWaitState([parkedA] as never, untouched, isEnded), untouched);
	// No slot at all → unchanged.
	assert.equal(repointWaitState([parkedA] as never, undefined, isEnded), undefined);
});

test("M3-6 unit: repointedWaitState keeps a surviving park, never clobbers a newer one", () => {
	const now = Date.now();
	const parkedA = { id: "task-a", status: "waiting" as const, waiting: WAITING(now + 3_600_000, "qA") };
	const parkedB = { id: "task-b", status: "waiting" as const, waiting: WAITING(now + 60_000, "qB") };
	const running = { id: "task-c", status: "running" as const };

	// Slot owned by the park being ended + a sibling still parked → re-point at
	// the sibling (latest deadline wins so the run shield never expires early).
	const repointed = __test__repointedWaitState(
		[parkedA, parkedB, running] as never,
		{ taskId: "task-b", questionId: "qB", askedAt: "x", deadline: now + 60_000 },
		"task-b",
		"qB",
	);
	assert.equal(repointed?.taskId, "task-a");
	assert.equal(repointed?.questionId, "qA");
	assert.equal(repointed?.deadline, now + 3_600_000);

	// Slot owned by the park being ended + nothing else parked → cleared.
	assert.equal(
		__test__repointedWaitState([running] as never, { taskId: "task-b", questionId: "qB", askedAt: "x", deadline: now }, "task-b", "qB"),
		undefined,
	);
	// No slot at all → unchanged.
	assert.equal(__test__repointedWaitState([parkedA] as never, undefined, "task-b", "qB"), undefined);
	// Slot owned by a DIFFERENT (newer) park → untouched (pre-existing contract).
	const other = { taskId: "task-b", questionId: "qB", askedAt: "x", deadline: now };
	assert.deepEqual(__test__repointedWaitState([parkedA] as never, other, "task-z", "qz"), other);
});

test("M3-6 (R21-M1): resolving one of two concurrent parks re-points waitState at the still-parked task", async () => {
	const scaff = await scaffoldRunningTask("m3-6");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd, waitMethodsEnabled: true });
	const tokenA = broker.issueRunToken(scaff.runId, scaff.taskId);
	const tokenB = broker.issueRunToken(scaff.runId, scaff.otherTaskId);
	const clientA = await rawConnect(socketPath);
	const clientB = await rawConnect(socketPath);
	try {
		// Both tasks must be "running" for the broker's park precondition.
		const seeded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		const startedAt = new Date().toISOString();
		saveRunTasks(
			seeded.manifest,
			seeded.tasks.map((t) =>
				t.id === scaff.taskId || t.id === scaff.otherTaskId ? { ...t, status: "running" as const, startedAt } : t,
			),
		);

		// Park 1: task A, long deadline.
		await hello(clientA, scaff.runId, scaff.taskId, tokenA);
		clientA.socket.write(
			encodeBrokerFrame({ id: "m6-a1", method: "wait.request", params: { to: scaff.taskId, question: "A?", timeoutSec: 3600 } }),
		);
		const parkA = (await clientA.waitForFrame((f) => (f as { id?: string })?.id === "m6-a1")) as {
			result?: { questionId?: string };
			error?: { code: string };
		};
		assert.ok(parkA.result?.questionId, `park A must succeed: ${JSON.stringify(parkA)}`);
		const questionA = parkA.result.questionId;

		// Park 2: the sibling task, short deadline — the single slot must KEEP A
		// (M4-R1a: a newer park never shortens a live shield).
		await hello(clientB, scaff.runId, scaff.otherTaskId, tokenB);
		clientB.socket.write(
			encodeBrokerFrame({ id: "m6-b1", method: "wait.request", params: { to: scaff.otherTaskId, question: "B?", timeoutSec: 60 } }),
		);
		const parkB = (await clientB.waitForFrame((f) => (f as { id?: string })?.id === "m6-b1")) as {
			result?: { questionId?: string };
			error?: { code: string };
		};
		assert.ok(parkB.result?.questionId, `park B must succeed: ${JSON.stringify(parkB)}`);
		const questionB = parkB.result.questionId;

		let loaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		// M4-R1(a): the slot follows the park with the LATEST deadline, so the
		// newer-but-SHORTER park (B, 60s) must NOT replace A's 3600s shield
		// (pre-fix: "the single slot follows the newer park" → shield shortened).
		assert.equal(loaded.manifest.waitState?.taskId, scaff.taskId, "a newer shorter park never shortens the run shield");
		assert.equal(loaded.manifest.waitState?.questionId, questionA, "the kept slot still carries the older park's questionId");
		assert.equal(isWaitAnswerPending(loaded.manifest), true, "the shield is still live after the second park");

		// Resolve the NEWER park (B) — the older park's stale-repair shield must
		// survive: the slot belongs to A, so a non-owner resolve leaves it alone.
		clientB.socket.write(
			encodeBrokerFrame({ id: "m6-b2", method: "wait.resolve", params: { to: scaff.otherTaskId, questionId: questionB } }),
		);
		const resolvedB = (await clientB.waitForFrame((f) => (f as { id?: string })?.id === "m6-b2")) as {
			result?: { ok?: boolean };
			error?: { code: string };
		};
		assert.ok(!resolvedB.error, `wait.resolve B must succeed: ${JSON.stringify(resolvedB)}`);

		loaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		assert.equal(loaded.tasks.find((t) => t.id === scaff.otherTaskId)?.status, "running", "resolved park flips back to running");
		assert.equal(loaded.tasks.find((t) => t.id === scaff.taskId)?.status, "waiting", "the older park stays parked");
		assert.equal(loaded.manifest.waitState?.taskId, scaff.taskId, "waitState is RE-POINTED at the still-parked task");
		assert.equal(loaded.manifest.waitState?.questionId, questionA, "the re-pointed slot carries the survivor's questionId");
		assert.equal(isWaitAnswerPending(loaded.manifest), true, "the surviving park keeps its stale-repair shield (R21-M1)");

		// Resolving the LAST park clears the slot for real.
		clientA.socket.write(
			encodeBrokerFrame({ id: "m6-a2", method: "wait.resolve", params: { to: scaff.taskId, questionId: questionA } }),
		);
		const resolvedA = (await clientA.waitForFrame((f) => (f as { id?: string })?.id === "m6-a2")) as {
			result?: { ok?: boolean };
			error?: { code: string };
		};
		assert.ok(!resolvedA.error, `wait.resolve A must succeed: ${JSON.stringify(resolvedA)}`);
		loaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		assert.equal(loaded.manifest.waitState, undefined, "last park resolved → slot cleared");
		assert.equal(isWaitAnswerPending(loaded.manifest), false, "no park left → no shield");
	} finally {
		clientA.close();
		clientB.close();
		await broker.stop();
		teardownCwd(scaff.cwd);
	}
});

// ----------------------------------------------------------------------------
// M4-R1(a) (fix-wave 6 residual, M3-C): the PARK write must never shorten the
// run-level shield. `isWaitAnswerPending` reads ONLY manifest.waitState, so
// overwriting the slot with a newer-but-shorter park used to drop the
// protection of an older, longer park that was still awaiting an answer.
// ----------------------------------------------------------------------------

test("M4-R1(a): the park slot follows the LATEST deadline — a newer shorter park never shortens the shield", async () => {
	const scaff = await scaffoldRunningTask("m4r1a");
	const { broker, socketPath } = await startBroker({ cwd: scaff.cwd, waitMethodsEnabled: true });
	const tokenA = broker.issueRunToken(scaff.runId, scaff.taskId);
	const tokenB = broker.issueRunToken(scaff.runId, scaff.otherTaskId);
	const clientA = await rawConnect(socketPath);
	const clientB = await rawConnect(socketPath);
	try {
		const seeded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		const startedAt = new Date().toISOString();
		saveRunTasks(
			seeded.manifest,
			seeded.tasks.map((t) =>
				t.id === scaff.taskId || t.id === scaff.otherTaskId ? { ...t, status: "running" as const, startedAt } : t,
			),
		);

		// Park B first with the LONG deadline (3600s) — it owns the slot.
		await hello(clientB, scaff.runId, scaff.otherTaskId, tokenB);
		clientB.socket.write(
			encodeBrokerFrame({
				id: "a-b1",
				method: "wait.request",
				params: { to: scaff.otherTaskId, question: "B long?", timeoutSec: 3600 },
			}),
		);
		const parkB = (await clientB.waitForFrame((f) => (f as { id?: string })?.id === "a-b1")) as {
			result?: { questionId?: string };
			error?: { code: string };
		};
		assert.ok(parkB.result?.questionId, `park B must succeed: ${JSON.stringify(parkB)}`);
		let loaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		assert.equal(loaded.manifest.waitState?.taskId, scaff.otherTaskId, "first park owns the slot");

		// Park A with a SHORT deadline (60s): the newer park must NOT shorten the
		// live shield (pre-fix: the slot followed the newer park → 60s shield).
		await hello(clientA, scaff.runId, scaff.taskId, tokenA);
		clientA.socket.write(
			encodeBrokerFrame({ id: "a-a1", method: "wait.request", params: { to: scaff.taskId, question: "A short?", timeoutSec: 60 } }),
		);
		const parkA = (await clientA.waitForFrame((f) => (f as { id?: string })?.id === "a-a1")) as {
			result?: { questionId?: string };
			error?: { code: string };
		};
		assert.ok(parkA.result?.questionId, `park A must succeed: ${JSON.stringify(parkA)}`);
		const questionA = parkA.result.questionId;

		loaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		assert.equal(loaded.tasks.find((t) => t.id === scaff.taskId)?.status, "waiting", "the newer park still parks its task");
		assert.equal(loaded.manifest.waitState?.taskId, scaff.otherTaskId, "the longer park keeps the shield (M4-R1a)");
		assert.ok(
			(loaded.manifest.waitState?.deadline ?? 0) > Date.now() + 3_000_000,
			"the shield still expires at B's 3600s deadline, not A's 60s one",
		);
		assert.equal(isWaitAnswerPending(loaded.manifest), true);

		// Resolve B → the slot re-points at the surviving park (A), never to nothing.
		clientB.socket.write(
			encodeBrokerFrame({
				id: "a-b2",
				method: "wait.resolve",
				params: { to: scaff.otherTaskId, questionId: parkB.result.questionId },
			}),
		);
		assert.ok(
			!((await clientB.waitForFrame((f) => (f as { id?: string })?.id === "a-b2")) as { error?: unknown }).error,
			"resolve B must succeed",
		);
		loaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		assert.equal(loaded.manifest.waitState?.taskId, scaff.taskId, "re-pointed at the surviving park");
		assert.equal(loaded.manifest.waitState?.questionId, questionA);

		// B is running again → a new park with a LATER deadline legitimately takes
		// the slot (the rule only refuses a SHORTENING overwrite).
		clientB.socket.write(
			encodeBrokerFrame({
				id: "a-b3",
				method: "wait.request",
				params: { to: scaff.otherTaskId, question: "B again?", timeoutSec: 3600 },
			}),
		);
		const parkB2 = (await clientB.waitForFrame((f) => (f as { id?: string })?.id === "a-b3")) as {
			result?: { questionId?: string };
			error?: { code: string };
		};
		assert.ok(parkB2.result?.questionId, `re-park B must succeed: ${JSON.stringify(parkB2)}`);
		loaded = loadRunManifestById(scaff.cwd, scaff.runId)!;
		assert.equal(loaded.manifest.waitState?.taskId, scaff.otherTaskId, "a park with a later deadline takes the slot");
		assert.equal(loaded.manifest.waitState?.questionId, parkB2.result.questionId);
	} finally {
		clientA.close();
		clientB.close();
		await broker.stop();
		teardownCwd(scaff.cwd);
	}
});

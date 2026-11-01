/**
 * runner-broker.test.ts — FINDING D (2026-11-01): async runs must host their
 * broker in the DETACHED RUNNER (the only process guaranteed to outlive the
 * run), not ride the dispatcher's socket (a `pi -p` dispatcher exits seconds
 * after dispatch and session_shutdown unlinks that socket — live probes 8/9).
 *
 * Covers startRunnerHostedBroker:
 *  - happy path: binds + serves connects on the derived/overridden socket path
 *  - issuer contract: fail-closed (no taskId / foreign runId / depth cap),
 *    per-task compound tokens, SAME task → SAME token (stdin-payload parity)
 *  - PI_CREW_BROKER=0 → soft-fail undefined, nothing bound
 *  - bind collision (EADDRINUSE) → soft-fail undefined (legacy issuer stays)
 *  - stop(): idempotent, unlinks the leaf (ownership-gated)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { startRunnerHostedBroker } from "../../../../src/runtime/broker/runner-broker.ts";

const priorBrokerEnv = process.env.PI_CREW_BROKER;
test.after(() => {
	if (priorBrokerEnv === undefined) delete process.env.PI_CREW_BROKER;
	else process.env.PI_CREW_BROKER = priorBrokerEnv;
});

function tempSocketPath(tag: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-runner-broker-${tag}-`));
	return path.join(dir, `${tag}.sock`);
}

function tempCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-runner-broker-cwd-"));
}

/** Connect probe: resolves true when a listener accepts on the path. */
function canConnect(socketPath: string, timeoutMs = 2000): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = net.createConnection(socketPath);
		const done = (ok: boolean) => {
			sock.destroy();
			resolve(ok);
		};
		sock.once("connect", () => done(true));
		sock.once("error", () => done(false));
		setTimeout(() => done(false), timeoutMs).unref();
	});
}

test("runner-broker: starts, binds the overridden socket, and accepts connects", async () => {
	delete process.env.PI_CREW_BROKER;
	const socketPath = tempSocketPath("happy");
	const handle = await startRunnerHostedBroker({
		runId: "team_20261101_runner_broker_happy",
		cwd: tempCwd(),
		socketPath,
		resolveMaxDepth: () => 4,
	});
	assert.ok(handle, "broker handle");
	assert.equal(handle.socketPath, socketPath);
	assert.equal(await canConnect(socketPath), true, "listener accepts");
	await handle.stop();
	assert.equal(await canConnect(socketPath), false, "socket gone after stop");
});

test("runner-broker: issuer is fail-closed and payload-parity token-cached", async () => {
	delete process.env.PI_CREW_BROKER;
	const runId = "team_20261101_runner_broker_issuer";
	const handle = await startRunnerHostedBroker({
		runId,
		cwd: tempCwd(),
		socketPath: tempSocketPath("issuer"),
		resolveMaxDepth: () => 2,
	});
	assert.ok(handle);
	const issue = handle.issueForChild;

	assert.equal(await issue(runId, undefined, undefined), undefined, "no taskId → no creds (w1a fail-closed)");
	assert.equal(await issue("team_other", "t1", undefined), undefined, "foreign runId → no creds");
	assert.equal(await issue(runId, "t1", 2), undefined, "childDepth >= maxDepth → no creds");

	const first = await issue(runId, "t1", undefined);
	const again = await issue(runId, "t1", 1);
	assert.ok(first, "t1 creds");
	assert.ok(again, "t1 creds on re-ask");
	assert.equal(first.socketPath, handle.socketPath);
	assert.equal(first.token, again.token, "SAME taskId → SAME cached token (payload parity)");
	assert.ok(first.token.length > 0);

	const second = await issue(runId, "t2", undefined);
	assert.ok(second);
	assert.notEqual(second.token, first.token, "different taskId → different compound token");

	await handle.stop();
});

test("runner-broker: PI_CREW_BROKER=0 → soft-fail, nothing bound", async () => {
	process.env.PI_CREW_BROKER = "0";
	const socketPath = tempSocketPath("disabled");
	const handle = await startRunnerHostedBroker({
		runId: "team_20261101_runner_broker_disabled",
		cwd: tempCwd(),
		socketPath,
		resolveMaxDepth: () => 4,
	});
	assert.equal(handle, undefined, "disabled → undefined (caller keeps legacy issuer)");
	assert.equal(fs.existsSync(socketPath), false, "no socket leaf created");
});

test("runner-broker: bind collision → soft-fail (legacy dispatcher-socket path stays)", {
	skip: process.platform === "win32",
}, async () => {
	delete process.env.PI_CREW_BROKER;
	const socketPath = tempSocketPath("collide");
	// Occupy the exact path with a foreign listener first.
	const squatter = net.createServer(() => {});
	await new Promise<void>((resolve) => squatter.listen(socketPath, resolve));
	try {
		const handle = await startRunnerHostedBroker({
			runId: "team_20261101_runner_broker_collide",
			cwd: tempCwd(),
			socketPath,
			resolveMaxDepth: () => 4,
		});
		assert.equal(handle, undefined, "EADDRINUSE → soft-fail, NOT a thrown boot error");
		// The squatter must survive untouched (connect-then-unlink refuses to
		// replace a LIVE listener — socket-stop.ts ownership discipline).
		assert.equal(await canConnect(socketPath), true, "foreign listener unharmed");
	} finally {
		await new Promise<void>((resolve) => squatter.close(() => resolve()));
	}
});

test("runner-broker: stop() is idempotent", async () => {
	delete process.env.PI_CREW_BROKER;
	const handle = await startRunnerHostedBroker({
		runId: "team_20261101_runner_broker_stop2",
		cwd: tempCwd(),
		socketPath: tempSocketPath("stop2"),
		resolveMaxDepth: () => 4,
	});
	assert.ok(handle);
	await handle.stop();
	await handle.stop(); // must not throw
});

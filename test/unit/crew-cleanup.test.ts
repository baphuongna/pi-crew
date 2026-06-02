import test from "node:test";
import assert from "node:assert/strict";
import { childProcessRegistry, registerChildProcess, unregisterChildProcess, registerCleanupHandler } from "../../src/extension/crew-cleanup.ts";

test("ChildProcessRegistry registers processes", () => {
	childProcessRegistry.clear();

	registerChildProcess(1234, "run-1", "agent-1");
	registerChildProcess(5678, "run-1", "agent-2");

	const pids = childProcessRegistry.getAllPids();
	assert.equal(pids.length, 2);
	assert.ok(pids.includes(1234));
	assert.ok(pids.includes(5678));

	childProcessRegistry.clear();
});

test("ChildProcessRegistry unregisters processes", () => {
	childProcessRegistry.clear();

	registerChildProcess(1234, "run-1", "agent-1");
	registerChildProcess(5678, "run-1", "agent-2");

	unregisterChildProcess(1234);

	const pids = childProcessRegistry.getAllPids();
	assert.equal(pids.length, 1);
	assert.ok(!pids.includes(1234));
	assert.ok(pids.includes(5678));

	childProcessRegistry.clear();
});

test("ChildProcessRegistry returns process info", () => {
	childProcessRegistry.clear();

	const before = Date.now();
	registerChildProcess(9999, "run-test", "agent-test");
	const after = Date.now();

	const info = childProcessRegistry.getInfo(9999);
	assert.ok(info !== undefined);
	assert.equal(info!.pid, 9999);
	assert.equal(info!.runId, "run-test");
	assert.equal(info!.agentId, "agent-test");
	assert.ok(info!.startedAt >= before);
	assert.ok(info!.startedAt <= after);

	childProcessRegistry.clear();
});

test("ChildProcessRegistry clears all processes", () => {
	childProcessRegistry.clear();

	registerChildProcess(1111, "run-1", "agent-1");
	registerChildProcess(2222, "run-2", "agent-2");
	registerChildProcess(3333, "run-3", "agent-3");

	assert.equal(childProcessRegistry.getAllPids().length, 3);

	childProcessRegistry.clear();

	assert.equal(childProcessRegistry.getAllPids().length, 0);
});

test("process.on SIGTERM/SIGHUP listeners are registered only once (no stacking)", () => {
	// Count listeners on process before and after multiple registerCleanupHandler calls.
	// If the implementation is correct, the count should stay the same.
	// We use a minimal ExtensionAPI stub since registerCleanupHandler only uses
	// the .on method to register the session_shutdown handler.
	const beforeSIGTERM = process.listenerCount("SIGTERM");
	const beforeSIGHUP = process.listenerCount("SIGHUP");

	// Re-import the module to test its idempotency. In a production runtime,
	// registerCleanupHandler is called once per extension load. The implementation
	// should guard against re-registration with a module-level flag.
	// We test indirectly: after we add a listener, calling registerCleanupHandler
	// should not increase the count.
	const fakeApi = { on: () => {} } as never;
	for (let i = 0; i < 5; i++) {
		registerCleanupHandler(fakeApi);
	}

	const afterSIGTERM = process.listenerCount("SIGTERM");
	const afterSIGHUP = process.listenerCount("SIGHUP");

	// Listener count should be at most 1 (or before count, if test ran first)
	assert.ok(afterSIGTERM - beforeSIGTERM <= 1, `SIGTERM listener stacked: ${afterSIGTERM - beforeSIGTERM} new listeners`);
	assert.ok(afterSIGHUP - beforeSIGHUP <= 1, `SIGHUP listener stacked: ${afterSIGHUP - beforeSIGHUP} new listeners`);
});

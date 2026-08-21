/**
 * Unit tests for the child-process abort shield.
 *
 * Regression: /crew-view switchSession mid-foreground-run →
 * stopSessionBoundSubagents → abort() → signal propagates into the vendored
 * pi SDK's session machinery → an internal controller abort reaches a child
 * spawned with `options.signal` that has no 'error' listener →
 * child.emit("error", new AbortError(...)) throws inside the AbortSignal
 * dispatch → EventTarget captures it and RETHROWS on the next tick →
 * uncaughtException → "pi exiting due to uncaughtException: AbortError" →
 * the whole terminal dies.
 *
 * A try/catch around abort() cannot stop the async rethrow; the shield makes
 * sure the spawned child ALWAYS has an 'error' listener before any abort can
 * fire, so the emit dispatches instead of throwing.
 *
 * If the shield regresses, the abort below reproduces the original crash and
 * THIS TEST FILE'S PROCESS DIES with the uncaughtException — which the test
 * runner reports as a failure. That is the intended regression signal.
 */
import assert from "node:assert/strict";
import { spawn as rawSpawn } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";

import { installChildProcessAbortShield } from "../../../src/utils/child-process-shield.ts";

// Capture the PRIVATE spawn binding BEFORE installing the shield: simulates
// modules (like the vendored SDK) that grabbed `spawn` before our patch — the
// prototype.kill half of the shield must protect those too.
installChildProcessAbortShield();

function spawnSleepyChild(options?: { signal?: AbortSignal }): ReturnType<typeof rawSpawn> {
	// Long-lived child: aborting it is guaranteed to hit the kill→error path
	// before its 'exit' event can dispose node's abort listener.
	return rawSpawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
		stdio: "ignore",
		...options,
	});
}

function settle(): Promise<void> {
	// Give any would-be nextTick rethrow (the old crash mode) time to surface.
	return new Promise((resolve) => setTimeout(resolve, 250));
}

test("abort of a signal-spawned child cannot crash the process (pre-bound spawn binding)", async () => {
	const controller = new AbortController();
	const child = spawnSleepyChild({ signal: controller.signal });
	const errors: Error[] = [];
	// The consumer's own listener (the SDK usually has none, but when it does
	// it must still receive the abort).
	child.on("error", (error) => errors.push(error));

	assert.doesNotThrow(() => controller.abort());

	await settle();
	assert.equal(errors.length, 1, "the AbortError is delivered, not thrown");
	assert.equal(errors[0]?.name, "AbortError");
	assert.equal(errors[0]?.message, "The operation was aborted");
	assert.ok(child.killed, "the child was killed by the abort");
});

test("pre-aborted signal spawn is safe (nextTick abort path)", async () => {
	const controller = new AbortController();
	controller.abort();
	const child = spawnSleepyChild({ signal: controller.signal });

	await settle();
	// No crash is the assertion; the child must also have been handled.
	assert.ok(child.killed || child.exitCode !== null || child.signalCode !== null);
});

test("spawn-failure (ENOENT) on a signal-spawned child is delivered, not thrown", async () => {
	const controller = new AbortController();
	const child = rawSpawn("/nonexistent/definitely-missing-bin-xyz", [], { signal: controller.signal });
	const errors: Error[] = [];
	child.on("error", (error) => errors.push(error));
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(errors.length, 1);
	assert.equal((errors[0] as NodeJS.ErrnoException).code, "ENOENT");
});

test("shield is idempotent — no duplicate listeners on repeated install", async () => {
	installChildProcessAbortShield();
	// ESM `import` holds the PRE-patch spawn binding captured when the module
	// namespace was created; fetch the CURRENT (patched) spawn via require so
	// the shield's spawn wrapper actually wraps this child.
	const require = createRequire(import.meta.url);
	const patchedSpawn = (require("node:child_process") as typeof import("node:child_process")).spawn as typeof rawSpawn;
	const controller = new AbortController();
	const child = patchedSpawn("/nonexistent/definitely-missing-bin-xyz", [], { signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(child.listenerCount("error"), 1, "exactly the one shield no-op listener");
});

test("normal explicit kill() still works with the shield installed", async () => {
	const child = spawnSleepyChild();
	const result = child.kill();
	assert.equal(result, true);
	assert.ok(child.killed);
	await settle();
});

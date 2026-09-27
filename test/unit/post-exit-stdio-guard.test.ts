import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { attachPostExitStdioGuard, trySignalChild } from "../../src/runtime/process/post-exit-stdio-guard.ts";

class MockPipedChild extends EventEmitter {
	readonly stdout: PassThrough;
	readonly stderr: PassThrough;

	constructor() {
		super();
		this.stdout = new PassThrough();
		this.stderr = new PassThrough();
	}

	kill(): boolean {
		return true;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

// RR-021 WI-3.2: poll-based wait (25ms) instead of fixed sleeps — same timers
// under test, but the test no longer fails when the machine is slow (the sleep
// was sized for the happy path) nor wastes wall-time when the event lands early.
// Deadline is >= 2x the worst-case timer being waited on.
async function waitFor(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(25);
	}
	return predicate();
}

test("trySignalChild reports whether a termination signal was actually delivered", () => {
	assert.equal(trySignalChild({ kill: () => true }, "SIGTERM"), true);
	assert.equal(trySignalChild({ kill: () => false }, "SIGTERM"), false);
	assert.equal(
		trySignalChild(
			{
				kill: () => {
					throw new Error("gone");
				},
			},
			"SIGTERM",
		),
		false,
	);
});

test("idle timer closes post-exit silent streams", async () => {
	const child = new MockPipedChild();
	attachPostExitStdioGuard(child as unknown as Parameters<typeof attachPostExitStdioGuard>[0], {
		idleMs: 1500,
		hardMs: 8000,
	});
	child.emit("exit", 0, null);
	// Worst case = idleMs 1500 → deadline 3000 (2x).
	const closed = await waitFor(() => child.stdout.destroyed && child.stderr.destroyed, 3000);
	assert.ok(closed, "idle timer must close silent streams within 2x idleMs");
	assert.ok(child.stdout.destroyed);
	assert.ok(child.stderr.destroyed);
});

test("hard timer closes chatty streams", async () => {
	const child = new MockPipedChild();
	const start = Date.now();
	attachPostExitStdioGuard(child as unknown as Parameters<typeof attachPostExitStdioGuard>[0], {
		idleMs: 1000,
		hardMs: 2000,
	});
	child.emit("exit", 0, null);

	const spamInterval = setInterval(() => {
		child.stdout.write("tick\n");
		child.stderr.write("tick\n");
	}, 200);
	// Worst case = hardMs 2000 → deadline 4000 (2x). The spam keeps the idle
	// timer re-arming, so only the hard timer can close the streams.
	const closed = await waitFor(() => child.stdout.destroyed && child.stderr.destroyed, 4000);
	clearInterval(spamInterval);

	assert.ok(closed, "hard timer must close chatty streams within 2x hardMs");
	assert.ok(Date.now() - start >= 2000 - 500);
	assert.ok(child.stdout.destroyed);
	assert.ok(child.stderr.destroyed);
});

test("arms immediately when attached AFTER exit (regression: in-exit-handler attach, B4)", async () => {
	// Production attaches the guard from INSIDE the child 'exit' handler, so by
	// attach time the child has already exited (exitCode set) and a freshly
	// registered 'exit' listener would NOT fire for the in-flight event. Without
	// the fix the guard never arms -> hang if a descendant holds the pipes open.
	const child = new MockPipedChild();
	(child as unknown as { exitCode: number | null }).exitCode = 0;
	attachPostExitStdioGuard(child as unknown as Parameters<typeof attachPostExitStdioGuard>[0], {
		idleMs: 200,
		hardMs: 8000,
	});
	// Intentionally do NOT emit "exit" — production cannot either.
	// Worst case = idleMs 200 → deadline 400 (2x).
	const closed = await waitFor(() => child.stdout.destroyed && child.stderr.destroyed, 400);
	assert.ok(closed, "guard must arm immediately when attached post-exit");
	assert.ok(child.stdout.destroyed, "guard must arm immediately when attached post-exit");
	assert.ok(child.stderr.destroyed);
});

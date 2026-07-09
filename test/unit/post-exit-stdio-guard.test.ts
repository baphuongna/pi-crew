import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { attachPostExitStdioGuard, trySignalChild } from "../../src/runtime/post-exit-stdio-guard.ts";

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
	await sleep(2200);
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
	await sleep(5000);
	clearInterval(spamInterval);

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
	await sleep(600);
	assert.ok(child.stdout.destroyed, "guard must arm immediately when attached post-exit");
	assert.ok(child.stderr.destroyed);
});

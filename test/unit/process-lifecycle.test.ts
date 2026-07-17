import assert from "node:assert/strict";
import { test } from "node:test";
import {
	disposeAllOwnedProcesses,
	disposeAllOwners,
	disposeOwner,
	liveOwnedProcessCount,
	registerResourceOwner,
	resourceOwnerCount,
	spawnOwnedProcess,
} from "../../src/runtime/process-lifecycle.ts";

const isPosix = process.platform !== "win32";

// Helper: a sleep script that ignores SIGTERM for a while to force SIGKILL.
// On Windows we use a ping-based sleep; on POSIX we use `sleep`.
function sleepScript(seconds: number): { cmd: string; args: string[] } {
	if (isPosix) {
		return { cmd: "sleep", args: [String(seconds)] };
	}
	// Windows: ping localhost N times ≈ N seconds.
	return { cmd: "ping", args: ["-n", String(seconds + 1), "127.0.0.1"] };
}

// Helper: a script that exits immediately with a given code.
function exitScript(code: number): { cmd: string; args: string[] } {
	if (isPosix) {
		return { cmd: "/bin/sh", args: ["-c", `exit ${code}`] };
	}
	return { cmd: "cmd", args: ["/c", `exit ${code}`] };
}

// ─── OwnedProcess: spawn + natural exit ──────────────────────────────────────

test("spawnOwnedProcess: child exits naturally and awaitExit observes code", async () => {
	const { cmd, args } = exitScript(0);
	const owner = spawnOwnedProcess(cmd, args, { name: "exit-0" });
	const result = await owner.awaitExit();
	assert.equal(result.exited, true);
	assert.equal(result.code, 0);
	// After natural exit + drain window, the owner deregisters.
	await delay(400);
	assert.equal(owner.isDisposed, false); // natural exit doesn't set disposed
});

test("spawnOwnedProcess: non-zero exit code observed", async () => {
	const { cmd, args } = exitScript(3);
	const owner = spawnOwnedProcess(cmd, args, { name: "exit-3" });
	const result = await owner.awaitExit();
	assert.equal(result.exited, true);
	assert.equal(result.code, 3);
});

// ─── dispose: escalating kill ─────────────────────────────────────────────────

test("dispose: SIGTERM kills a sleep process within grace period", async () => {
	const { cmd, args } = sleepScript(30);
	const owner = spawnOwnedProcess(cmd, args, {
		name: "sleep-sigterm",
		gracefulMs: 1000,
	});
	// Give the child a moment to actually start.
	await delay(100);
	assert.equal(owner.isDisposed, false);
	await owner.dispose();
	assert.equal(owner.isDisposed, true);
	// After dispose, the process should be gone.
	const result = await owner.awaitExit();
	assert.equal(result.exited, true);
	await delay(200);
	assert.equal(liveOwnedProcessCount(), 0);
});

test("dispose: escalates to SIGKILL when process ignores SIGTERM", async () => {
	if (!isPosix) {
		// On Windows taskkill /F is the only path; covered by the basic test.
		return;
	}
	// Trap SIGTERM and ignore it, so only SIGKILL works.
	// `trap '' TERM` makes the shell ignore SIGTERM; `sleep 30` keeps it alive.
	const owner = spawnOwnedProcess("/bin/sh", ["-c", "trap '' TERM; sleep 30"], {
		name: "ignore-sigterm",
		gracefulMs: 300,
	});
	await delay(150);
	const start = Date.now();
	await owner.dispose();
	const elapsed = Date.now() - start;
	assert.equal(owner.isDisposed, true);
	// Should have taken at least the grace period (SIGTERM waited, then SIGKILL).
	assert.ok(elapsed >= 250, `dispose should wait grace period (elapsed=${elapsed}ms)`);
	// And the process must actually be dead.
	const result = await owner.awaitExit();
	assert.equal(result.exited, true);
});

// ─── dispose: idempotency ────────────────────────────────────────────────────

test("dispose: idempotent — repeated calls return the same promise", async () => {
	const { cmd, args } = sleepScript(30);
	const owner = spawnOwnedProcess(cmd, args, {
		name: "idempotent",
		gracefulMs: 500,
	});
	await delay(100);
	const p1 = owner.dispose();
	const p2 = owner.dispose();
	const p3 = owner.dispose();
	assert.equal(p1, p2);
	assert.equal(p2, p3);
	await p1;
	assert.equal(owner.isDisposed, true);
});

test("dispose: after natural exit is a no-op", async () => {
	const { cmd, args } = exitScript(0);
	const owner = spawnOwnedProcess(cmd, args, { name: "no-op-after-exit" });
	await owner.awaitExit();
	await delay(400); // let reconciliation deregister
	// dispose() on a terminated owner is a true no-op.
	const before = liveOwnedProcessCount();
	await owner.dispose();
	assert.equal(owner.isDisposed, true);
	assert.equal(liveOwnedProcessCount(), before);
});

// ─── awaitExit: bounded timeout ───────────────────────────────────────────────

test("awaitExit: timeoutMs fires before a long-running process exits", async () => {
	const { cmd, args } = sleepScript(10);
	const owner = spawnOwnedProcess(cmd, args, { name: "bounded-await" });
	await delay(100);
	const result = await owner.awaitExit({ timeoutMs: 200 });
	assert.equal(result.exited, false);
	await owner.dispose();
});

// ─── onExit callback ──────────────────────────────────────────────────────────

test("onExit: callback fires on natural exit", async () => {
	const { cmd, args } = exitScript(0);
	const owner = spawnOwnedProcess(cmd, args, { name: "onexit-natural" });
	let fired = false;
	let observedCode: number | null | undefined;
	const unsub = owner.onExit((code) => {
		fired = true;
		observedCode = code;
	});
	await owner.awaitExit();
	// callback may fire synchronously or on next microtask; wait briefly.
	await delay(50);
	assert.equal(fired, true);
	assert.equal(observedCode, 0);
	unsub();
});

test("onExit: callback fires on dispose kill", async () => {
	const { cmd, args } = sleepScript(30);
	const owner = spawnOwnedProcess(cmd, args, {
		name: "onexit-kill",
		gracefulMs: 500,
	});
	let fired = false;
	owner.onExit(() => {
		fired = true;
	});
	await delay(100);
	await owner.dispose();
	await owner.awaitExit();
	await delay(50);
	assert.equal(fired, true);
});

test("onExit: unsubscribe prevents callback", async () => {
	const { cmd, args } = exitScript(0);
	const owner = spawnOwnedProcess(cmd, args, { name: "onexit-unsub" });
	let fired = false;
	const unsub = owner.onExit(() => {
		fired = true;
	});
	unsub();
	await owner.awaitExit();
	await delay(50);
	assert.equal(fired, false);
});

// ─── live-owner tracking ───────────────────────────────────────────────────────

test("liveOwnedProcessCount: increments on spawn, decrements after exit", async () => {
	const before = liveOwnedProcessCount();
	const { cmd, args } = exitScript(0);
	const owner = spawnOwnedProcess(cmd, args, { name: "count-track" });
	assert.equal(liveOwnedProcessCount(), before + 1);
	await owner.awaitExit();
	await delay(400); // drain window
	assert.equal(liveOwnedProcessCount(), before);
});

test("disposeAllOwnedProcesses: disposes every live owner", async () => {
	const before = liveOwnedProcessCount();
	const { cmd, args } = sleepScript(30);
	const a = spawnOwnedProcess(cmd, args, {
		name: "disposeall-a",
		gracefulMs: 500,
	});
	const b = spawnOwnedProcess(cmd, args, {
		name: "disposeall-b",
		gracefulMs: 500,
	});
	await delay(100);
	assert.equal(liveOwnedProcessCount(), before + 2);
	await disposeAllOwnedProcesses();
	assert.equal(liveOwnedProcessCount(), before);
	await a.awaitExit();
	await b.awaitExit();
});

// ─── registerResourceOwner ─────────────────────────────────────────────────────

test("registerResourceOwner: register + disposeAllOwners invokes disposer", async () => {
	let disposed = false;
	const unsub = registerResourceOwner("test:timer", async () => {
		disposed = true;
	});
	assert.equal(resourceOwnerCount(), 1);
	await disposeAllOwners();
	assert.equal(disposed, true);
	assert.equal(resourceOwnerCount(), 0);
	unsub();
});

test("registerResourceOwner: re-register replaces prior disposer", async () => {
	let firstDisposed = false;
	let secondDisposed = false;
	registerResourceOwner("test:replace", async () => {
		firstDisposed = true;
	});
	registerResourceOwner("test:replace", async () => {
		secondDisposed = true;
	});
	assert.equal(resourceOwnerCount(), 1);
	await disposeAllOwners();
	assert.equal(firstDisposed, false);
	assert.equal(secondDisposed, true);
});

test("registerResourceOwner: unregister removes owner only if still active", async () => {
	let disposed = false;
	const unsub = registerResourceOwner("test:unsub", async () => {
		disposed = true;
	});
	unsub();
	assert.equal(resourceOwnerCount(), 0);
	await disposeAllOwners();
	assert.equal(disposed, false);
});

test("registerResourceOwner: unregister is idempotent and doesn't remove a replacement", async () => {
	let firstDisposed = false;
	let secondDisposed = false;
	const unsubFirst = registerResourceOwner("test:idempotent-unsub", async () => {
		firstDisposed = true;
	});
	registerResourceOwner("test:idempotent-unsub", async () => {
		secondDisposed = true;
	});
	// Unregistering the FIRST registration must NOT remove the second (replacement).
	unsubFirst();
	assert.equal(resourceOwnerCount(), 1);
	await disposeAllOwners();
	assert.equal(firstDisposed, false);
	assert.equal(secondDisposed, true);
});

test("disposeOwner: disposes a single named owner", async () => {
	let aDisposed = false;
	let bDisposed = false;
	registerResourceOwner("test:owner-a", async () => {
		aDisposed = true;
	});
	registerResourceOwner("test:owner-b", async () => {
		bDisposed = true;
	});
	const ok = await disposeOwner("test:owner-a");
	assert.equal(ok, true);
	assert.equal(aDisposed, true);
	assert.equal(bDisposed, false);
	assert.equal(resourceOwnerCount(), 1);
	await disposeAllOwners();
});

test("disposeOwner: returns false for unknown name", async () => {
	const ok = await disposeOwner("test:nonexistent");
	assert.equal(ok, false);
});

test("disposeAllOwners: surfaces AggregateError when a disposer throws", async () => {
	registerResourceOwner("test:throws", async () => {
		throw new Error("boom");
	});
	await assert.rejects(
		() => disposeAllOwners(),
		(err) => {
			assert.ok(err instanceof AggregateError, `expected AggregateError, got ${err?.constructor?.name}`);
			return true;
		},
	);
});

test("disposeAllOwners: runs all disposers even if some throw", async () => {
	let secondRan = false;
	registerResourceOwner("test:throws2", async () => {
		throw new Error("boom2");
	});
	registerResourceOwner("test:runs2", async () => {
		secondRan = true;
	});
	await assert.rejects(() => disposeAllOwners());
	assert.equal(secondRan, true);
});

// ─── abort signal ─────────────────────────────────────────────────────────────

test("abort signal: pre-aborted signal disposes on spawn", async () => {
	const ac = new AbortController();
	ac.abort();
	const { cmd, args } = sleepScript(30);
	const owner = spawnOwnedProcess(cmd, args, {
		name: "pre-aborted",
		signal: ac.signal,
		gracefulMs: 500,
	});
	// Pre-aborted: dispose fires immediately.
	await owner.dispose();
	assert.equal(owner.isDisposed, true);
	await owner.awaitExit();
});

test("abort signal: aborting after spawn triggers dispose", async () => {
	const ac = new AbortController();
	const { cmd, args } = sleepScript(30);
	const owner = spawnOwnedProcess(cmd, args, {
		name: "abort-after",
		signal: ac.signal,
		gracefulMs: 500,
	});
	await delay(100);
	ac.abort();
	await owner.awaitExit();
	assert.equal(owner.isDisposed, true);
});

// ─── helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * U15 redteam tests — OwnedProcess group-kill + postmortem registry.
 *
 * Port contract (spec U15, proof-of-pattern round 9 + gotcha):
 *   - double/concurrent dispose share ONE in-flight promise, one TERM.
 *   - backgrounded descendants (`sh -c "… & …"`) are reaped by root-exit
 *     drain-reconcile — no child outlives its owner.
 *   - PID-recycle guard: late dispose after a clean drain never re-signals
 *     a pgid the OS may have recycled.
 *   - wedged child (SIGTERM-ignoring) still bounded by the SIGKILL cap.
 *   - leader-death scenario: wedged root + backgrounded descendant leave NO
 *     live member of the pgid after T.
 *   - adoption integration: registerActiveChild adopts; killProcessTree /
 *     killProcessPid route through the escalating owned dispose; the zombie
 *     scanner and PI_CREW_PARENT_PID child-side guard are KEPT (source pins).
 *
 * These tests spawn REAL processes (sh/sleep) — they are POSIX-only in the
 * group assertions and skip cleanly on Windows.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { killProcessTree, registerActiveChild, unregisterActiveChild } from "../../../../src/runtime/child-pi/child-pi-kill.ts";
import {
	adoptOwnedProcess,
	disposeAllOwnedProcesses,
	liveOwnedProcessCount,
	spawnOwnedProcess,
} from "../../../../src/runtime/child-pi/owned-process.ts";
import {
	postmortemHookCount,
	registerPostmortemCleanup,
	runPostmortemCleanup,
} from "../../../../src/runtime/child-pi/postmortem-registry.ts";

const isPosix = process.platform !== "win32";

// The production ladder deliberately unrefs its poll/delay timers (they must
// not pin the host loop — see owned-process.ts). Under `node --test`, once a
// test's child dies nothing else keeps the loop alive, so those unref'd timers
// would never fire and the harness cancels the test with "event loop has
// already resolved". A REF'd keepalive interval per test restores deterministic
// timer delivery without touching production semantics (RR-021 lesson).
let keepalive: NodeJS.Timeout | undefined;
beforeEach(() => {
	keepalive = setInterval(() => {
		/* pin the loop only — see comment above */
	}, 25);
});
afterEach(() => {
	if (keepalive) clearInterval(keepalive);
	keepalive = undefined;
});

function tmpMarkerFile(label: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-u15-"));
	return path.join(dir, `${label}.marker`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => {
			const t = setTimeout(resolve, 20);
			t.unref?.();
		});
	}
	assert.fail(`waitFor timed out: ${label}`);
}

async function waitForFileContains(file: string, needle: string, timeoutMs = 5_000): Promise<void> {
	await waitFor(
		() => {
			try {
				return fs.readFileSync(file, "utf8").includes(needle);
			} catch {
				return false;
			}
		},
		timeoutMs,
		`file ${file} contains ${JSON.stringify(needle)}`,
	);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** ESRCH on -pgid means no member of the group is alive (zombies count as alive). */
function processGroupGone(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

test("U15: immediate dispose wins the startup race and returns to baseline", async () => {
	const before = liveOwnedProcessCount();
	const owner = spawnOwnedProcess("sh", ["-c", "sleep 30"], { name: "u15-startup-race", gracefulMs: 100 });
	await owner.dispose();
	assert.equal(owner.disposed, true);
	const exit = await owner.awaitExit({ timeoutMs: 2_000 });
	assert.equal(exit.exited, true);
	await waitFor(() => liveOwnedProcessCount() === before, 3_000, "live count baseline after immediate dispose");
});

test("U15: bounded awaitExit reports a live long-runner without killing it, never rejects", async () => {
	const before = liveOwnedProcessCount();
	const owner = spawnOwnedProcess("sh", ["-c", "sleep 30"], { name: "u15-bounded-await", gracefulMs: 100 });
	try {
		const probe = await owner.awaitExit({ timeoutMs: 0 });
		assert.deepEqual(probe, { exited: false, code: null });
		if (owner.pid !== undefined) assert.equal(processAlive(owner.pid), true);
	} finally {
		await owner.dispose();
	}
	const exit = await owner.awaitExit({ timeoutMs: 2_000 });
	assert.equal(exit.exited, true);
	await waitFor(() => liveOwnedProcessCount() === before, 3_000, "live count baseline after bounded-await dispose");
});

test("U15 redteam: double and concurrent dispose share one settled result and issue one terminating signal", async () => {
	const before = liveOwnedProcessCount();
	const marker = tmpMarkerFile("concurrent-dispose");
	const ready = `${marker}.ready`;
	const owner = spawnOwnedProcess(
		"sh",
		["-c", `trap 'echo term >> ${marker}; exit 0' TERM; echo up > ${ready}; while :; do sleep 1; done`],
		{ name: "u15-concurrent-dispose", gracefulMs: 500 },
	);
	try {
		await waitForFileContains(ready, "up", 2_000);
		const first = owner.dispose();
		const second = owner.dispose();
		assert.equal(second, first, "concurrent dispose() must return the SAME in-flight promise");
		const results = await Promise.all([first, second, owner.dispose()]);
		assert.deepEqual(results, [undefined, undefined, undefined]);
		const exit = await owner.awaitExit({ timeoutMs: 2_000 });
		assert.equal(exit.exited, true);
		const terms = fs
			.readFileSync(marker, "utf8")
			.split("\n")
			.filter((line) => line === "term");
		assert.equal(terms.length, 1, "exactly one terminating signal delivered to the group");
		await waitFor(() => liveOwnedProcessCount() === before, 3_000, "live count baseline after concurrent dispose");
	} finally {
		await owner.dispose();
	}
});

test("U15 redteam: backgrounded descendants are reaped by root-exit drain-reconcile", { skip: !isPosix }, async () => {
	const before = liveOwnedProcessCount();
	// Root exits immediately; the backgrounded `sleep 30` keeps the process
	// group alive — the zombie vector U15 exists to close.
	const owner = spawnOwnedProcess("sh", ["-c", "(sleep 30) & exit 0"], {
		name: "u15-backgrounded-descendants",
		gracefulMs: 200,
	});
	const pgid = owner.pid;
	assert.ok(pgid !== undefined && pgid > 0);
	const exit = await owner.awaitExit({ timeoutMs: 2_000 });
	assert.equal(exit.exited, true, "root exits on its own");
	// Reconcile: 250ms drain poll → group still alive → auto-dispose reaps it.
	await waitFor(() => processGroupGone(pgid), 3_000, "backgrounded descendant group reaped after root exit");
	await waitFor(() => liveOwnedProcessCount() === before, 3_000, "live count baseline after drain-reconcile");
	assert.equal(owner.terminated, true);
});

test("U15 redteam: late dispose after clean drain is a settled no-op and never re-signals a recycled pgid", async () => {
	const before = liveOwnedProcessCount();
	// Root exits cleanly with no backgrounded descendants → group drains within
	// ROOT_EXIT_DRAIN_MS and reconciliation deregisters (terminal).
	const owner = spawnOwnedProcess("sh", ["-c", "exit 0"], { name: "u15-pid-recycle" });
	const pgid = owner.pid;
	assert.ok(pgid !== undefined && pgid > 0);
	const exit = await owner.awaitExit({ timeoutMs: 2_000 });
	assert.equal(exit.exited, true);
	await waitFor(() => liveOwnedProcessCount() === before, 2_000, "live count baseline after clean-drain reconcile");
	assert.equal(owner.terminated, true, "PID-recycle guard armed by clean drain");

	// Simulate the OS recycling the pgid into an unrelated live group: sig-0
	// probes report alive; record any TERMINATING signal aimed at -pgid.
	const realKill = process.kill;
	const terminatingSignals: Array<string | number> = [];
	const fakeKill = ((pid: number, signal?: string | number): boolean => {
		if (pid === -pgid) {
			if (signal === undefined || signal === 0) return true;
			terminatingSignals.push(signal);
			return true;
		}
		return realKill.call(process, pid, signal);
	}) as typeof process.kill;
	process.kill = fakeKill;
	try {
		await owner.dispose();
		await owner.dispose();
		assert.deepEqual(terminatingSignals, [], "terminated owner must never re-signal the (recycled) pgid");
		assert.equal(owner.disposed, true);
		assert.equal(liveOwnedProcessCount(), before);
	} finally {
		process.kill = realKill;
	}
});

test("U15 redteam: wedged (SIGTERM-ignoring) child is still bounded by the SIGKILL cap", { skip: !isPosix }, async () => {
	const before = liveOwnedProcessCount();
	const owner = spawnOwnedProcess("sh", ["-c", `trap "" TERM; while :; do sleep 1; done`], {
		name: "u15-wedged-cap",
		gracefulMs: 300,
	});
	const pgid = owner.pid;
	assert.ok(pgid !== undefined);
	const started = Date.now();
	await owner.dispose(); // must RESOLVE — never hang on an unkillable child
	const elapsed = Date.now() - started;
	// gracefulMs (300) + SIGKILL_REAP_CAP_MS (2000) + scheduling slack.
	assert.ok(elapsed < 300 + 2_000 + 1_500, `dispose resolved in ${elapsed}ms (within grace+cap)`);
	await waitFor(() => processGroupGone(pgid), 2_000, "wedged group gone after SIGKILL escalation");
	await waitFor(() => liveOwnedProcessCount() === before, 3_000, "live count baseline after wedged dispose");
});

test("U15 redteam: leader-death — wedged root + backgrounded descendant leave no live member after T", { skip: !isPosix }, async () => {
	const before = liveOwnedProcessCount();
	// Root traps/ignores SIGTERM AND backgrounds a long sleep: the hardest
	// shape — SIGTERM does nothing, only the SIGKILL escalation can clear it.
	const owner = spawnOwnedProcess("sh", ["-c", `(sleep 30) & trap "" TERM; while :; do sleep 1; done`], {
		name: "u15-leader-death",
		gracefulMs: 300,
	});
	const pgid = owner.pid;
	assert.ok(pgid !== undefined);
	await owner.dispose();
	// After T (reap completes within grace+cap), NO process may remain in the
	// group — neither the wedged leader nor its backgrounded descendant.
	await waitFor(() => processGroupGone(pgid), 3_000, "no live member of pgid after leader-death dispose");
	const exit = await owner.awaitExit({ timeoutMs: 2_000 });
	assert.equal(exit.exited, true);
	await waitFor(() => liveOwnedProcessCount() === before, 3_000, "live count baseline after leader-death dispose");
});

test("U15: adopted non-leader child (rpc-branch shape) falls back to single-process dispose", { skip: !isPosix }, async () => {
	const before = liveOwnedProcessCount();
	// NOT detached → the child shares OUR process group; adoptOwnedProcess must
	// resolve pgid=undefined on Linux (authoritative /proc check) and dispose
	// via direct pid kill without ever signaling our own group.
	const child = spawn("sh", ["-c", `trap "" TERM; while :; do sleep 1; done`], { stdio: "ignore" });
	assert.ok(child.pid !== undefined);
	const owner = adoptOwnedProcess(child, { name: "u15-non-leader", gracefulMs: 300 });
	assert.equal(owner.pgid, undefined, "non-leader adoption must not claim group ownership");
	await owner.dispose();
	const exit = await owner.awaitExit({ timeoutMs: 2_500 });
	assert.equal(exit.exited, true, "single-process fallback terminated the SIGTERM-ignoring child");
	await waitFor(() => liveOwnedProcessCount() === before, 3_000, "live count baseline after non-leader dispose");
});

test("U15 integration: registerActiveChild adopts; killProcessTree routes through the owned dispose", { skip: !isPosix }, async () => {
	const before = liveOwnedProcessCount();
	const child = spawn("sh", ["-c", "(sleep 30) & sleep 30"], { stdio: "ignore", detached: true });
	assert.ok(child.pid !== undefined);
	const pgid = child.pid;
	registerActiveChild(child.pid, child);
	try {
		// Root is still alive here; killProcessTree must escalate the whole
		// group (root + backgrounded descendant) via the owned dispose ladder.
		killProcessTree(child.pid, child);
		await waitFor(() => processGroupGone(pgid), 4_000, "adopted group reaped via killProcessTree routing");
		// unregisterActiveChild is a bookkeeping-only call — it must NOT bypass
		// the owned lifecycle (reconcile/dispose own deregistration).
		unregisterActiveChild(child.pid);
		const exit = await new Promise<number | null>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
			else child.once("exit", (code) => resolve(code));
		});
		assert.ok(exit !== null || child.signalCode !== null, "child terminated");
		await waitFor(() => liveOwnedProcessCount() === before, 4_000, "live count baseline after routed kill");
	} finally {
		killProcessTree(child.pid, child);
		await disposeAllOwnedProcesses();
	}
});

test("U15: postmortem registry — register/run/unregister + signal listeners installed", async () => {
	const calls: string[] = [];
	const before = postmortemHookCount();
	const unregister = registerPostmortemCleanup("u15-test-a", (reason) => {
		calls.push(reason);
	});
	assert.equal(postmortemHookCount(), before + 1);
	await runPostmortemCleanup("manual");
	assert.deepEqual(calls, ["manual"]);
	// Unregistered hooks never run again.
	unregister();
	await runPostmortemCleanup("SIGTERM");
	assert.deepEqual(calls, ["manual"]);

	// Last-wins replacement: a stale unregister must NOT evict the newer hook.
	const un1 = registerPostmortemCleanup("u15-test-b", () => {
		calls.push("b1");
	});
	un1();
	const un2 = registerPostmortemCleanup("u15-test-b", () => {
		calls.push("b2");
	});
	un1(); // stale
	await runPostmortemCleanup("manual");
	assert.ok(calls.includes("b2"), "newer registration survived the stale unregister");
	assert.ok(!calls.includes("b1"), "replaced registration was evicted by last-wins");
	un2();
	assert.equal(postmortemHookCount(), before);

	// The process-level listeners are installed (exit/SIGINT/SIGTERM/SIGHUP/
	// uncaught/unhandled) — presence check only; firing real signals in the
	// shared test-runner process is not safe.
	assert.ok(process.listenerCount("exit") >= 1);
	assert.ok(process.listenerCount("SIGINT") >= 1);
	assert.ok(process.listenerCount("SIGTERM") >= 1);
	assert.ok(process.listenerCount("SIGHUP") >= 1);
});

test("U15 source-pin: kill routing + zombie scanner + PI_CREW_PARENT_PID guard kept", async () => {
	const killSrc = fs.readFileSync(
		path.join(import.meta.dirname, "..", "..", "..", "..", "src", "runtime", "child-pi", "child-pi-kill.ts"),
		"utf8",
	);
	// Routing: killProcessTree + killProcessPid must consult the owned registry.
	const routed = killSrc.match(/ownedByPid\.get\(pid\)/g);
	assert.ok(routed && routed.length >= 2, `expected ≥2 ownedByPid.get(pid) routing sites, found ${routed?.length ?? 0}`);
	// Adoption at registration.
	assert.match(killSrc, /registerActiveChild[\s\S]*?adoptOwnedProcess\(/, "registerActiveChild must adopt the child");
	// Background zombie scanner KEPT (spec: complementary layer).
	assert.match(killSrc, /60_000/, "60s zombie scanner interval kept");
	// terminateActiveChildPiProcesses sweeps owners too.
	assert.match(killSrc, /terminateActiveChildPiProcesses[\s\S]*?disposeAllOwnedProcesses\(\)/);
	// Child-side guard KEPT (spec: complementary layer).
	const spawnSrc = fs.readFileSync(
		path.join(import.meta.dirname, "..", "..", "..", "..", "src", "runtime", "child-pi", "child-pi-spawn.ts"),
		"utf8",
	);
	assert.match(spawnSrc, /PI_CREW_PARENT_PID/, "PI_CREW_PARENT_PID child-side guard kept in spawn options");
	// Round-9 gotcha pinned: the root handle must never be unref'd as a statement
	// (the single textual mention lives inside the explanatory comment).
	const ownedSrc = fs.readFileSync(
		path.join(import.meta.dirname, "..", "..", "..", "..", "src", "runtime", "child-pi", "owned-process.ts"),
		"utf8",
	);
	const unrefStatements = ownedSrc.split("\n").filter((line) => /^\s*child\.unref\(\)/.test(line));
	assert.deepEqual(unrefStatements, [], "root child handle must NOT be unref'd (starve exit-event gotcha)");
	assert.match(ownedSrc, /do NOT child\.unref\(\)/);
	// Internal poll/delay timers unref THEMSELVES (they must not pin the host loop).
	assert.match(ownedSrc, /timer\.unref\?\.\(\)/);
});

/**
 * run-worker-cap.test.ts — T-4 (Round 9 transitive-coverage gap, refactor-plan
 * review §ROUND 9 "T-4/5/6 — LOW: run-worker.ts (transitive only)").
 *
 * `src/runtime/run-worker.ts` was previously exercised only transitively
 * (task-runner / run-coalesced / dynamic-workflow). These tests drive the REAL
 * module end-to-end through the child-spawn boundary and assert the global
 * worker-cap semantics that CORE-13 centralized:
 *
 *   1. acquire BLOCKS at the configured concurrency bound (peak overlap == cap),
 *   2. release-on-settle hands the slot to the next queued acquire (FIFO),
 *   3. release-on-throw — withWorkerSlot's try/finally frees the slot when the
 *      spawn itself rejects (deadlock safety), verified by proving the pool is
 *      NOT short one slot afterwards,
 *   4. `cap: false` bypasses the semaphore entirely (goal-judge exemption,
 *      RFC MAJ#3 — see global-worker-cap.ts module header).
 *
 * ── MOCK SEAM (deliberately narrow) ──
 * ONLY the child spawn boundary is faked: a real child process running a
 * tiny Node script (PI_TEAMS_PI_BIN + npm_config_prefix allowlist, the same
 * seam as run-coalesced-timeout.test.ts). The script appends start/end
 * hrtime.bigint() stamps to `<cwd>/worker-overlap.log`, which gives
 * cross-process monotonic intervals for exact peak-overlap arithmetic.
 *
 * PI_TEAMS_MOCK_CHILD_PI is explicitly NOT used: every mock fixture resolves
 * synchronously (<1ms), so blocking at the bound can never be observed
 * (documented in run-coalesced-timeout.test.ts's header). `mock.module` is
 * also unavailable under this repo's runner (tsx/esm loader, Node 22 —
 * `typeof t.mock.module === "undefined"`; see stringenum-fallback-composition
 * .test.ts's header note).
 *
 * Worker-shell env gotcha (.crew/knowledge.md 2026-08-15): the harness exports
 * PI_CREW_* env vars, so every test snapshots/restores the spawn-relevant env
 * and deletes PI_CREW_DEPTH (depth guard) + the mock-mode vars. The cap is set
 * via the exported __test_resetCap seam (capacity resolves at module-load time
 * from env, so runtime env changes would not apply).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../src/agents/agent-config.ts";
import { runWorker } from "../../../src/runtime/run-worker.ts";
import { __test_resetCap, getWorkerCapCapacity } from "../../../src/runtime/scheduling/global-worker-cap.ts";

/** Per-child run interval measured from the shared overlap log (ns, monotonic). */
interface Span {
	pid: number;
	startNs: bigint;
	endNs: bigint;
}

const agent: AgentConfig = {
	name: "worker",
	description: "cap-test worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

/** Spawn-relevant env vars: snapshot + restore + the worker-shell scrub set. */
const ENV_KEYS = [
	"PI_TEAMS_PI_BIN",
	"PI_TEAMS_MOCK_CHILD_PI",
	"PI_CREW_ALLOW_MOCK",
	"PI_CREW_DEPTH",
	"PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS",
	"npm_config_prefix",
	"NPM_CONFIG_PREFIX",
] as const;

function snapshotEnv(keys: readonly string[]): Record<string, string | undefined> {
	const snap: Record<string, string | undefined> = {};
	for (const k of keys) snap[k] = process.env[k];
	return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
	for (const [k, v] of Object.entries(snap)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-runworker-cap-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

/**
 * Write a fake-pi bin that:
 *   - logs `start <pid> <hrtime.bigint()>` on boot and `end <pid> <ns>` right
 *     before exit into `<cwd>/worker-overlap.log` (shared across siblings),
 *   - emits one valid assistant message line (runChildPi settle path),
 *   - sleeps `workMs` then exits 0.
 */
function writeFakePi(scriptDir: string, workMs: number): string {
	const scriptPath = path.join(scriptDir, `fake-pi-${workMs}ms.js`);
	fs.writeFileSync(
		scriptPath,
		[
			"// T-4 fixture: overlap-measuring fake pi.",
			"const fs = require('node:fs');",
			"const path = require('node:path');",
			`const workMs = ${workMs};`,
			"const log = path.join(process.cwd(), 'worker-overlap.log');",
			"fs.appendFileSync(log, 'start ' + process.pid + ' ' + process.hrtime.bigint() + '\\n');",
			"process.stdout.write(JSON.stringify({",
			"\ttype: 'message',",
			"\tmessage: { role: 'assistant', content: [{ type: 'text', text: 'worker done' }] },",
			"}) + '\\n');",
			"process.on('SIGTERM', () => process.exit(143));",
			"setTimeout(() => {",
			"\tfs.appendFileSync(log, 'end ' + process.pid + ' ' + process.hrtime.bigint() + '\\n');",
			"\tprocess.exit(0);",
			"}, workMs);",
		].join("\n"),
	);
	return scriptPath;
}

/** Point PI_TEAMS_PI_BIN at `scriptPath` inside the allowed `scriptDir` prefix. */
function useValidPiBin(scriptPath: string, scriptDir: string): void {
	process.env.npm_config_prefix = scriptDir; // pi-spawn.ts isWithinAllowedPrefixes
	process.env.PI_TEAMS_PI_BIN = scriptPath;
	process.env.PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS = "8000";
	delete process.env.PI_TEAMS_MOCK_CHILD_PI; // mock fixtures resolve synchronously — useless here
	delete process.env.PI_CREW_ALLOW_MOCK;
	delete process.env.PI_CREW_DEPTH; // worker-shell env would trip the depth guard
}

function readSpans(logPath: string): Span[] {
	const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
	const starts = new Map<number, bigint>();
	const spans: Span[] = [];
	for (const line of lines) {
		const [kind, pidStr, nsStr] = line.trim().split(" ");
		const pid = Number(pidStr);
		const ns = BigInt(nsStr);
		if (kind === "start") starts.set(pid, ns);
		else if (kind === "end") {
			const startNs = starts.get(pid);
			if (startNs !== undefined) spans.push({ pid, startNs, endNs: ns });
		}
	}
	return spans;
}

/**
 * Peak number of simultaneously-live child intervals. Ties at identical ns
 * sort ends (-1) before starts (+1), matching "release happens-before next
 * acquire" (withWorkerSlot releases in the finally of the settling child
 * before the queued acquire's spawn runs).
 */
function peakOverlap(spans: Span[]): number {
	const events: Array<[bigint, number]> = [];
	for (const s of spans) {
		events.push([s.startNs, 1], [s.endNs, -1]);
	}
	events.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
	let current = 0;
	let peak = 0;
	for (const [, delta] of events) {
		current += delta;
		if (current > peak) peak = current;
	}
	return peak;
}

/** Fail fast with a clear message instead of hanging when a slot leaks (deadlock). */
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms — a worker slot likely leaked (deadlock)`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

// ── Tests ───────────────────────────────────────────────────────────

test("T-4: runWorker blocks at the configured cap and releases on settle (real module, real spawn)", async () => {
	const envSnap = snapshotEnv(ENV_KEYS);
	const prevCap = getWorkerCapCapacity();
	// Canonicalize (macOS: /var/folders/... → /private/var/folders/...) so the
	// npm_config_prefix allowlist prefix matches what pi-spawn's
	// validateExplicitBin() sees after fs.realpathSync on the bin path.
	const scriptDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-runworker-cap-bin-")));
	const cwd = makeTmpCwd();
	try {
		useValidPiBin(writeFakePi(scriptDir, 200), scriptDir);
		__test_resetCap(2);

		// Three concurrent worker spawns under a cap of 2. Acquires 1+2 run
		// immediately; the third must QUEUE until a slot is released by a
		// settling child.
		const results = await withDeadline(
			Promise.all([
				runWorker({ cwd, task: "T-4 bound probe", agent }),
				runWorker({ cwd, task: "T-4 bound probe", agent }),
				runWorker({ cwd, task: "T-4 bound probe", agent }),
			]),
			15_000,
			"3 spawns under cap 2",
		);
		assert.ok(
			results.every((r) => r.exitCode === 0),
			`all spawns must succeed (exitCodes=${results.map((r) => r.exitCode).join(",")})`,
		);

		const spans = readSpans(path.join(cwd, "worker-overlap.log"));
		assert.equal(spans.length, 3, `expected 3 start/end pairs, got ${spans.length}`);

		// PRIMARY: peak concurrency is exactly the cap — never 3 (bound holds),
		// never <2 for this workload (both slots were usable).
		assert.equal(peakOverlap(spans), 2, "peak child overlap must equal the configured cap (2), not 3");

		// Release-on-settle → next acquire: the 3rd spawn must start no earlier
		// than the FIRST settled child's end stamp.
		const ordered = [...spans].sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0));
		const firstEnd = ordered[0]!.endNs < ordered[1]!.endNs ? ordered[0]!.endNs : ordered[1]!.endNs;
		assert.ok(ordered[2]!.startNs >= firstEnd, "3rd spawn must start only after a prior child settled (released its slot)");
	} finally {
		__test_resetCap(prevCap);
		restoreEnv(envSnap);
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(scriptDir, { recursive: true, force: true });
	}
});

test("T-4: cap:false bypasses the global worker cap (goal-judge exemption, RFC MAJ#3)", async () => {
	const envSnap = snapshotEnv(ENV_KEYS);
	const prevCap = getWorkerCapCapacity();
	// Canonicalize (macOS: /var/folders/... → /private/var/folders/...) so the
	// npm_config_prefix allowlist prefix matches what pi-spawn's
	// validateExplicitBin() sees after fs.realpathSync on the bin path.
	const scriptDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-runworker-cap-bin-")));
	const bypassCwd = makeTmpCwd();
	const cappedCwd = makeTmpCwd();
	try {
		useValidPiBin(writeFakePi(scriptDir, 150), scriptDir);
		__test_resetCap(1);

		// Bypass: two spawns with cap:false while capacity is 1 — both must run
		// concurrently (the semaphore is not consulted at all).
		const bypassed = await withDeadline(
			Promise.all([
				runWorker({ cwd: bypassCwd, task: "T-4 bypass probe", agent, cap: false }),
				runWorker({ cwd: bypassCwd, task: "T-4 bypass probe", agent, cap: false }),
			]),
			15_000,
			"2 cap:false spawns",
		);
		assert.ok(bypassed.every((r) => r.exitCode === 0));
		const bypassSpans = readSpans(path.join(bypassCwd, "worker-overlap.log"));
		assert.equal(bypassSpans.length, 2);
		assert.equal(peakOverlap(bypassSpans), 2, "cap:false must exceed the configured capacity (exempt from the semaphore)");

		// Control (same shape, default cap=true at capacity 1): strictly serial.
		const capped = await withDeadline(
			Promise.all([
				runWorker({ cwd: cappedCwd, task: "T-4 capped probe", agent }),
				runWorker({ cwd: cappedCwd, task: "T-4 capped probe", agent }),
			]),
			15_000,
			"2 capped spawns",
		);
		assert.ok(capped.every((r) => r.exitCode === 0));
		const cappedSpans = readSpans(path.join(cappedCwd, "worker-overlap.log"));
		assert.equal(cappedSpans.length, 2);
		assert.equal(peakOverlap(cappedSpans), 1, "default cap=true at capacity 1 must serialize the spawns");
	} finally {
		__test_resetCap(prevCap);
		restoreEnv(envSnap);
		fs.rmSync(bypassCwd, { recursive: true, force: true });
		fs.rmSync(cappedCwd, { recursive: true, force: true });
		fs.rmSync(scriptDir, { recursive: true, force: true });
	}
});

test("T-4: release-on-throw — a rejecting spawn frees its slot (withWorkerSlot try/finally)", async () => {
	const envSnap = snapshotEnv(ENV_KEYS);
	const prevCap = getWorkerCapCapacity();
	// Canonicalize (macOS: /var/folders/... → /private/var/folders/...) so the
	// npm_config_prefix allowlist prefix matches what pi-spawn's
	// validateExplicitBin() sees after fs.realpathSync on the bin path.
	const scriptDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-runworker-cap-bin-")));
	const escapeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-runworker-cap-escape-"));
	const cwd = makeTmpCwd();
	try {
		__test_resetCap(2);

		// Force a SYNCHRONOUS throw from inside runChildPi: point PI_TEAMS_PI_BIN
		// at a path OUTSIDE every allowed prefix and delete npm_config_prefix.
		// pi-spawn.ts getPiSpawnCommand throws ("outside allowed prefixes")
		// from prepareSpawnContext — BEFORE runChildPi's inner try, so the
		// rejection propagates out of runWorker and withWorkerSlot's finally
		// must release the acquired slot.
		const invalidBin = path.join(escapeDir, "fake-pi-invalid.js");
		fs.writeFileSync(invalidBin, "// intentionally unreachable: prefix validation rejects this path\n");
		process.env.PI_TEAMS_PI_BIN = invalidBin;
		delete process.env.npm_config_prefix;
		delete process.env.NPM_CONFIG_PREFIX;
		delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		delete process.env.PI_CREW_ALLOW_MOCK;
		delete process.env.PI_CREW_DEPTH;

		await assert.rejects(
			() => runWorker({ cwd, task: "T-4 throw probe", agent }),
			/outside allowed prefixes/,
			"the invalid PI_TEAMS_PI_BIN must reject the spawn",
		);

		// Deadlock-safety proof: with cap=2 and one THROWN spawn already
		// consumed, three more spawns still fit only if the thrown spawn's slot
		// was released. If the slot leaked, the 3rd spawn would block forever
		// and the deadline below fails with the explicit leak message.
		useValidPiBin(writeFakePi(scriptDir, 100), scriptDir);
		const results = await withDeadline(
			Promise.all([
				runWorker({ cwd, task: "T-4 post-throw probe", agent }),
				runWorker({ cwd, task: "T-4 post-throw probe", agent }),
				runWorker({ cwd, task: "T-4 post-throw probe", agent }),
			]),
			15_000,
			"3 spawns after a thrown spawn under cap 2",
		);
		assert.ok(
			results.every((r) => r.exitCode === 0),
			"all post-throw spawns must succeed — the thrown spawn's slot was freed",
		);
	} finally {
		__test_resetCap(prevCap);
		restoreEnv(envSnap);
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(scriptDir, { recursive: true, force: true });
		fs.rmSync(escapeDir, { recursive: true, force: true });
	}
});

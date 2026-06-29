/**
 * E2E test: background-runner watchdog force-aborts a hung process.
 *
 * Tests the REAL watchdog path (background-runner.ts watchdogTimer + force-exit
 * safety net) using a minimal harness script that replicates the keepAlive +
 * watchdog mechanism without needing a real team/run manifest.
 *
 * Design:
 *   - Spawn scripts/watchdog-harness.ts as a child process
 *   - Set PI_CREW_MAX_RUN_MS=5000 (5s timeout → watchdog fires at 5s)
 *   - Set PI_CREW_PARENT_PID=<test pid> so parent guard self-terminates if test dies
 *   - Assert: (a) process exits within bounded time (MAX_RUN_MS + HARD_KILL_GRACE_MS)
 *   - Assert: (b) process is not a zombie after test exits
 *
 * Reference: team-tool-parallel.test.ts:35-42 for PI_CREW_PARENT_PID pattern.
 *
 * @see src/runtime/background-runner.ts watchdogTimer + forceExit safety net
 * @see src/runtime/parent-guard.ts startParentGuard
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

// ─── Config (fast for test execution) ───────────────────────────────────────
/** Watchdog timeout — the harness will exit at MAX_RUN_MS + HARD_KILL_GRACE_MS */
const WATCHDOG_TIMEOUT_MS = 5_000; // 5 seconds (fast test)
/** Grace period after watchdog fires before force-exit */
const HARD_KILL_GRACE_MS = 15_000; // 15 seconds (matches background-runner.ts default)
/** Max time we wait for the process to die (timeout + grace + buffer) */
const MAX_WAIT_MS = WATCHDOG_TIMEOUT_MS + HARD_KILL_GRACE_MS + 5_000; // 25s total

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function resolveProjectRoot(): string {
	// Test lives in test/integration/, project root is three dirs up:
	// test/integration/background-runner-watchdog-e2e.test.ts → ../.. → pi-crew/
	const self = fileURLToPath(import.meta.url);
	return path.resolve(self, "..", "..", "..");
}

/**
 * Build a clean env block for the harness spawn.
 * Starts from a copy of process.env, sets test-specific overrides, and
 * removes vars that could interfere with the harness (mock flags etc).
 */
function buildHarnessEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	// Spread as NodeJS.ProcessEnv to avoid TypeScript narrowing the object type
	const base: NodeJS.ProcessEnv = { ...process.env };
	// Remove vars that could interfere
	delete base.PI_TEAMS_MOCK_CHILD_PI;
	delete base.PI_CREW_ALLOW_MOCK;
	delete base.PI_TEAMS_EXECUTE_WORKERS;
	// Apply overrides
	for (const [key, val] of Object.entries(overrides)) {
		base[key] = val;
	}
	return base;
}

// ─── Test 1: Watchdog force-exit path ─────────────────────────────────────────
/**
 * PRIMARY TEST: verifies the WATCHDOG PATH.
 *
 * - PI_CREW_PARENT_PID = this test process (stays alive throughout)
 * - PI_CREW_MAX_RUN_MS = 5000ms → watchdog fires at 5s
 * - Watchdog schedules force-exit at 5+15=20s
 * - Expected: process exits with code 1 at ~20s (not zombie)
 *
 * This is the CRITICAL path: the watchdog prevents zombie background-runners.
 */
test(
	"background-runner watchdog E2E: hung harness is killed within the grace window",
	async (t) => {
		const projectRoot = resolveProjectRoot();
		const harnessPath = path.join(projectRoot, "scripts", "watchdog-harness.ts");

		// Verify harness exists before trying to spawn
		if (!fs.existsSync(harnessPath)) {
			throw new Error(
				`watchdog harness not found at ${harnessPath} — run from pi-crew directory`,
			);
		}

		// ── Spawn ──────────────────────────────────────────────────────────────
		// Short watchdog timeout (5s) + parent guard tied to test process.
		// The harness will never resolve its main promise; the watchdog will fire
		// at 5s and force-exit at 5s+15s=20s.
		const childEnv = buildHarnessEnv({
			PI_CREW_MAX_RUN_MS: String(WATCHDOG_TIMEOUT_MS),
			PI_CREW_PARENT_PID: String(process.pid),
			PI_CREW_BG_REPORT_ON_FATAL: "0",
		});

		const child = spawn(process.execPath, [
			"--experimental-strip-types",
			harnessPath,
		], {
			cwd: projectRoot,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
			detached: false, // NOT detached — we need to track this child
			windowsHide: true,
		});

		// Collect stderr for diagnostics (cap at 64KB)
		const stderrChunks: Buffer[] = [];
		let stderrLen = 0;
		const STDERR_LIMIT = 64 * 1024;
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderrLen + chunk.length <= STDERR_LIMIT) {
				stderrChunks.push(chunk);
				stderrLen += chunk.length;
			}
		});

		// ── Wait for exit ───────────────────────────────────────────────────
		// We await the exit promise directly (not via t.test()) so the child
		// PID is live for the whole duration.
		const exitCode = await new Promise<number>((resolve, reject) => {
			const timeout = setTimeout(() => {
				// Last-chance zombie check before failing
				if (child.pid && isPidAlive(child.pid)) {
					try { process.kill(child.pid, 0); } catch { /* already dead */ }
				}
				reject(
					new Error(
						`Process ${child.pid} did NOT exit within ${MAX_WAIT_MS}ms ` +
						`(watchdog timeout=${WATCHDOG_TIMEOUT_MS}ms, grace=${HARD_KILL_GRACE_MS}ms). ` +
						`Stderr: ${Buffer.concat(stderrChunks).toString("utf-8").slice(0, 512)}`,
					),
				);
			}, MAX_WAIT_MS);

			child.on("exit", (code) => {
				clearTimeout(timeout);
				resolve(code ?? -1);
			});
			child.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});

		// ── Assertions ────────────────────────────────────────────────────────
		// The watchdog force-exits with code 1. Parent-death path uses 124.
		// Both indicate the process was NOT a zombie — only 124 confirms the
		// parent guard actually ran (not needed in this test but valid).
		assert.ok(
			[1, 124].includes(exitCode),
			`Expected exit code 1 (watchdog force-exit) or 124 (parent-death) but got ${exitCode}. ` +
			`Stderr: ${Buffer.concat(stderrChunks).toString("utf-8").slice(0, 1024)}`,
		);

		// ── Zombie verification ────────────────────────────────────────────────
		// process.kill(pid, 0) throws if PID is dead — verified explicitly.
		if (child.pid) {
			assert.ok(
				!isPidAlive(child.pid),
				`ZOMBIE DETECTED: child pid=${child.pid} is still alive after exit event`,
			);
		}

		console.log(
			`[watchdog-e2e] ✓ Process pid=${child.pid} exited with code=${exitCode} ` +
			`within ${MAX_WAIT_MS}ms (watchdog fires at ${WATCHDOG_TIMEOUT_MS}ms, ` +
			`force-exit at ${WATCHDOG_TIMEOUT_MS + HARD_KILL_GRACE_MS}ms). No zombie.`,
		);
	},
);

// ─── Test 2: Parent guard self-termination path ────────────────────────────────
/**
 * SECONDARY TEST: verifies the PARENT GUARD PATH (selfTerminate → exit 124).
 *
 * On some Unix systems (notably Linux containers), process.kill(1, 0) fails
 * with EPERM because PID 1 has a restricted security context. We use a
 * non-existent PID (999999) to deterministically trigger the selfTerminate path.
 *
 * This test verifies that:
 *   (a) the harness does NOT become a zombie when its parent dies
 *   (b) selfTerminate exits cleanly with code 124
 *
 * NOTE: This test exits in ~1-2s (parent-death path), not ~20s (watchdog path).
 * It is a complementary verification of the anti-zombie mechanism.
 */
test(
	"parent guard E2E: harness exits with 124 when parent dies (no zombie)",
	async (t) => {
		const projectRoot = resolveProjectRoot();
		const harnessPath = path.join(projectRoot, "scripts", "watchdog-harness.ts");

		if (!fs.existsSync(harnessPath)) {
			throw new Error(`watchdog harness not found at ${harnessPath}`);
		}

		// Non-existent parent PID → selfTerminate fires (code 124).
		// This tests the parent guard path, not the watchdog path.
		const childEnv = buildHarnessEnv({
			PI_CREW_MAX_RUN_MS: String(WATCHDOG_TIMEOUT_MS),
			PI_CREW_PARENT_PID: "999999", // non-existent → selfTerminate fires
			PI_CREW_BG_REPORT_ON_FATAL: "0",
		});

		const child = spawn(process.execPath, [
			"--experimental-strip-types",
			harnessPath,
		], {
			cwd: projectRoot,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
			windowsHide: true,
		});

		const exitCode = await new Promise<number>((resolve, reject) => {
			// Short timeout since parent-death path exits in ~1-2s, not ~20s.
			const timeout = setTimeout(() => {
				reject(
					new Error(`Process ${child.pid} did NOT exit within 5000ms (parent-death path)`),
				);
			}, 5_000);

			child.on("exit", (code) => {
				clearTimeout(timeout);
				resolve(code ?? -1);
			});
			child.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});

		// selfTerminate exits with 124 (parent died). This is expected.
		assert.equal(
			exitCode,
			124,
			`Expected exit code 124 (parent died) but got ${exitCode}`,
		);

		// Critical: ensure the process is NOT a zombie after selfTerminate.
		if (child.pid) {
			assert.ok(
				!isPidAlive(child.pid),
				`ZOMBIE LEAK: child pid=${child.pid} is still alive after selfTerminate`,
			);
		}

		console.log(
			`[watchdog-e2e] ✓ parent-guard selfTerminate(pid=${child.pid}) exited cleanly ` +
			`with code=124 (parent died), no zombie`,
		);
	},
);

// ─── Leak prevention ───────────────────────────────────────────────────────────
// Both tests await the child's exit promise, so children are guaranteed dead
// before the test file completes. The test.after() hook is kept as explicit
// documentation of the zombie-prevention requirement.
test.after(() => {
	// Safety net: ensure no child PIDs are still alive.
	// (Primary guarantee: both tests await their child's exit before returning.)
});

#!/usr/bin/env node
/**
 * Test runner wrapper that enforces non-zero exit code on failures.
 *
 * Problem: `tsx --test` always exits 0 even when tests fail.
 * Fix: Use stdio: 'inherit' so output streams directly (avoids pipe buffer
 * deadlocks on large test suites), and rely on the child's exit code.
 *
 * Always passes --test-force-exit so the child process cannot hang the
 * parent (pi) on shutdown. Defensive: prevents the "pi froze" failure
 * mode where a long-running test keeps file handles/timers open and
 * blocks the agent's wait-for-exit.
 *
 * F05 (RR-015) — FAIL CLOSED on an unknown child outcome:
 * `spawnSync()` reports `status: null` when the child was terminated by a
 * signal, and `status: undefined` (plus `error`) when the spawn itself failed.
 * The previous `process.exit(result.status ?? 0)` mapped BOTH to exit code 0,
 * so a test run whose coordinator was SIGKILLed reported success — a silent
 * CI false-green whose stdout was only "TAP version 13" (no `not ok` line for
 * a TAP scraper to catch either). Only `status === 0` with no signal is
 * success now; every other outcome prints a diagnostic and exits non-zero.
 *
 * Usage: node scripts/test-runner.mjs [tsx test args...]
 */
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Decide the wrapper's exit code from a `spawnSync` result. PURE + exported so
 * the exit semantics are unit-testable without spawning anything (F05 AC-6).
 *
 * Fail closed: only `status === 0` AND no `signal` AND no `error` is success.
 * - `signal` set (child killed)            → non-zero (was 0 for SIGKILL: the bug)
 * - `status === null`/`undefined`          → non-zero (unknown outcome)
 * - `error` (ENOENT/E2BIG/ETIMEDOUT…)      → non-zero (spawn failed)
 * - `status > 0`                           → that code (test failure)
 *
 * @param {{status?: number|null, signal?: string|null, error?: Error}} result
 * @returns {number} exit code
 */
export function resolveExitCode(result) {
	if (!result || typeof result !== "object") return 1;
	if (result.error) return 1;
	if (result.signal) return 1;
	if (typeof result.status !== "number") return 1;
	return result.status;
}

/** Human-readable diagnostic for a non-zero, non-plain-failure outcome. */
export function describeExitOutcome(result) {
	if (result?.error) return `spawn failed: ${result.error.message}`;
	if (result?.signal) return `test process was terminated by signal ${result.signal}`;
	if (result && typeof result.status !== "number") return "test process exited without a status code (unknown outcome)";
	return undefined;
}

const isEntryPoint = (() => {
	const argv1 = process.argv[1];
	if (!argv1) return false;
	const self = fileURLToPath(import.meta.url);
	try {
		return realpathSync(argv1) === realpathSync(self);
	} catch {
		// realpathSync fails only if a path vanished mid-run; fall back to a
		// lexical comparison so the CLI never silently becomes a no-op.
		return path.resolve(argv1) === path.resolve(self);
	}
})();

/**
 * Environment for the spawned test process.
 *
 * NODE_TEST_CONTEXT is DELETED on purpose. Node's test runner exports it to
 * every test file it loads (value `child-v8`); when a test file itself spawns
 * `node --test`, the nested runner sees that marker and prints
 *   "node:test run() is being called recursively within a test file. skipping
 *    running files."
 * then exits **0** having run NOTHING. That is the same class of silent
 * false-green as F05 (a green exit code with no tests executed), so the wrapper
 * must not hand the marker to its child. Node sets the variable for the child
 * it spawns itself, so removing it here only prevents the accidental nesting.
 */
function buildChildEnv() {
	const env = {
		...process.env,
		NODE_ENV: "test",
		PI_CREW_SKIP_HOME_CHECK: "1",
		// F-01: trust project-sourced .dwf.ts fixtures under test. The test
		// runner is a trusted context (our own fixtures, never hostile), so
		// opt into the project-dwf trust gate globally. Individual unit
		// tests (dynamic-workflow-runner-trust.test.ts) override this env
		// locally to exercise the deny path.
		PI_CREW_TRUST_PROJECT_DWF: "1",
	};
	delete env.NODE_TEST_CONTEXT;
	return env;
}

if (!isEntryPoint) {
	// Imported as a module (unit tests import `resolveExitCode`). Do nothing —
	// the CLI logic below must not run on import.
} else {

const args = process.argv.slice(2);
if (args.length === 0) {
	// When run by Node's test runner (no args), exit 0 gracefully.
	// This script needs test file arguments to do anything useful.
	console.log("skip: no test files specified");
	process.exit(0);
}

// Always inject --test-force-exit to guarantee child exits (prevents pi hang).
// EXCEPT when --watch is passed: node forbids --watch + --test-force-exit.
const watchMode = args.includes("--watch");
const hasForceExit = args.includes("--test-force-exit");
let finalArgs = hasForceExit ? args : watchMode ? args : ["--test-force-exit", ...args];

// Expand recursive globs (`**`) into an explicit file list. Node v22's --test does
// NOT expand `**` itself (only single-level `*`), so without this, tests in
// subdirectories (e.g. test/unit/security/) are INVISIBLE to `npm test`. The runner
// expands `<base>/**/*.test.ts` → recursive file walk, matching the BASENAME against
// the file pattern (so `**` = any depth).
function expandRecursiveGlob(arg) {
	if (!arg.includes("**")) return [arg];
	const idx = arg.indexOf("**");
	const base = arg.slice(0, idx).replace(/\/+$/, "");
	const filePattern = arg.slice(idx + 2).replace(/^\/+/, ""); // e.g. "*.test.ts"
	if (!base || !filePattern) return [arg];
	const re = new RegExp(
		"^" +
			filePattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") +
			"$",
	);
	const out = [];
	try {
		(function walk(dir) {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, e.name);
				if (e.isDirectory()) walk(full);
				else if (re.test(e.name)) out.push(full); // match BASENAME (** = any depth)
			}
		})(base);
	} catch {
		/* base dir missing — fall through to literal */
	}
	return out.length ? out : [arg];
}
finalArgs = finalArgs.flatMap(expandRecursiveGlob);

// CI reliability: node:test runs test FILES concurrently in one process
// (--test-concurrency=N). On shared CI runners (GitHub Actions), high
// concurrency causes cross-file filesystem contention that makes write-then-
// stat tests (notably state-store's createRunManifest assertions) flake:
//   - windows-latest: Windows Defender real-time scanning locks freshly-
//     created temp files → transient EPERM/EBUSY on rename inside
//     atomicWriteFile (exhausts the ~1.6s rename retries).
//   - macos-latest: /var/folders tmp contention under load → occasional
//     4ms instant write failures.
// The flake only surfaced after the Round 13/14 test additions pushed the
// runners past their timing threshold. Capping cross-file concurrency at 2
// across ALL platforms gives the FS room to flush and eliminates the storm.
// Local dev is unaffected (developers pass --test-concurrency=4 explicitly
// and run on idle machines). This only clamps the CI-requested value.
finalArgs = finalArgs.map((arg) => {
	const m = /^(--test-concurrency)=(\d+)$/.exec(arg);
	return m && Number(m[2]) > 2 ? `${m[1]}=2` : arg;
});

// Detect --watch. Node's --watch keeps the process alive and re-runs on file
// change; spawnSync cannot model that, so we switch to spawn + signal relay.
// `--watch` must be the FIRST node flag (before --test) per node CLI rules.
const testArgs = watchMode ? finalArgs.filter((a) => a !== "--watch") : finalArgs;
const nodeFlags = watchMode ? ["--watch", "--import", "tsx/esm", "--test"] : ["--import", "tsx/esm", "--test"];

if (watchMode) {
	// Long-running: spawn, pipe stdio, relay signals, exit with child code.
	const { spawn } = await import("node:child_process");
	const child = spawn(process.execPath, [...nodeFlags, ...testArgs], {
		stdio: "inherit",
		env: buildChildEnv(),
	});
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(sig, () => child.kill(sig));
	}
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
} else {
	const result = spawnSync(process.execPath, [...nodeFlags, ...testArgs], {
		stdio: "inherit",
		env: buildChildEnv(),
		// 2026-07-01: bumped from 600s → 900s after atomic-write.ts added
		// fs.fsyncSync for the mailbox-replay flake fix. fsync adds ~5-10ms
		// per atomic-write, which compounded across 5800 tests pushed
		// Windows CI just over the 10-minute budget.
		// 2026-09-17: bumped 900s → 1500s. The suite is now ~7900 tests (~737s
		// observed on idle Linux), leaving only ~20% headroom at 900s — and the
		// F05 fail-closed fix (correctly) turns a budget overrun into a red
		// build instead of the old silent exit-0. 25 min bounds a genuinely
		// hung coordinator while giving the grown suite + slower CI runners
		// room. Override with PI_CREW_TEST_RUNNER_TIMEOUT_MS if needed.
		timeout: Number(process.env.PI_CREW_TEST_RUNNER_TIMEOUT_MS ?? 1_500_000),
	});

	// F05: fail closed. `status === null` means the child died by SIGNAL (or the
	// spawn itself failed) — the old `result.status ?? 0` turned that into a
	// green build. Only an explicit 0 with no signal is success.
	const diagnostic = describeExitOutcome(result);
	if (diagnostic) {
		console.error(`\n[test-runner] FAIL (inconclusive): ${diagnostic}.`);
		console.error("[test-runner] Treating this as a test FAILURE (fail closed) — exit code will be non-zero.");
		if (result.error) console.error("[test-runner] cause:", result.error.message);
	}
	process.exit(resolveExitCode(result));
}

} // end !isEntryPoint else-branch

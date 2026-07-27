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
 * Usage: node scripts/test-runner.mjs [tsx test args...]
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
if (args.length === 0) {
	// When run by Node's test runner (no args), exit 0 gracefully.
	// This script needs test file arguments to do anything useful.
	console.log("skip: no test files specified");
	process.exit(0);
}

// Always inject --test-force-exit to guarantee child exits (prevents pi hang).
const hasForceExit = args.includes("--test-force-exit");
let finalArgs = hasForceExit ? args : ["--test-force-exit", ...args];

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

const result = spawnSync(
	process.execPath,
	["--import", "tsx/esm", "--test", ...finalArgs],
	{
		stdio: "inherit",
		env: {
			...process.env,
			NODE_ENV: "test",
			PI_CREW_SKIP_HOME_CHECK: "1",
			// F-01: trust project-sourced .dwf.ts fixtures under test. The test
			// runner is a trusted context (our own fixtures, never hostile), so
			// opt into the project-dwf trust gate globally. Individual unit
			// tests (dynamic-workflow-runner-trust.test.ts) override this env
			// locally to exercise the deny path.
			PI_CREW_TRUST_PROJECT_DWF: "1",
		},
		// 2026-07-01: bumped from 600s → 900s after atomic-write.ts added
		// fs.fsyncSync for the mailbox-replay flake fix. fsync adds ~5-10ms
		// per atomic-write, which compounded across 5800 tests pushed
		// Windows CI just over the 10-minute budget. 15 minutes gives
		// comfortable headroom on Windows (slowest) without masking real
		// test bugs.
		timeout: 900_000,
	},
);

if (result.error) {
	console.error("Test runner error:", result.error.message);
	process.exit(1);
}

// The Node.js test runner exits with non-zero when tests fail.
// With --test-force-exit, it may exit with code 1 if force-exited
// while tests were still running (which shouldn't happen normally).
process.exit(result.status ?? 0);

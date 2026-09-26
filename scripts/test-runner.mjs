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
import { sweepStaleTestTmpdirs } from "./sweep-test-tmp.mjs";

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

// ─── DP-03 (2026-09-22): CI test sharding ─────────────────────────────────────
// CI cannot raise --test-concurrency (clamped at 2 for Windows Defender /
// macOS tmp contention — see the clamp block below), and the unit suite
// (~8.1k tests, ~20 min local at concurrency 4, slower at 2) is about to
// breach the 1500s runner budget. The remaining lever is SHARDING: split the
// suite across parallel CI jobs, each on its own filesystem, so the per-FS
// contention that forced the clamp does not apply ACROSS jobs.

/**
 * Static wall-clock weights per top-level directory under test/unit/.
 * PER-FILE average weight = (directory wall-clock) ÷ (directory file count),
 * in centiseconds. MEASURED 2026-09-22 (idle Linux, node v22.23.1): every
 * directory run sequentially via test-runner at the SAME clamped concurrency
 * the CI shards use (--test-concurrency=2); the "(root)" bucket (files
 * directly in test/unit/) measured via 'test/unit/*.test.ts'. With per-file
 * weights, a shard's cumulative sum ÷100 ≈ its expected wall-clock seconds —
 * so the ±20% balance assertion in shard-partition.test.ts asserts REAL
 * expected runtime balance. Rebalance after big test additions.
 * If you add a top-level dir under test/unit/ you MUST add its weight here:
 * shard-partition.test.ts fails loudly on an unweighted directory.
 */
export const SHARD_DIR_WEIGHTS = {
	// PER-FILE average weights in centiseconds (dir wall-clock ÷ dir file count,
	// from the 2026-09-22 measurement). Per-FILE (not per-dir) is essential:
	// weighting each file by its DIR TOTAL balances cumulative bookkeeping sums
	// while real shard runtime stayed 2.5× apart (101s vs 254s) — caught while
	// validating this table. Cumulative shard sums in these units ≈ expected
	// real seconds × 100.
	scripts: 602, // 5 files, 30.1s — spawn subprocess runners per test
	teams: 166,
	extension: 158,
	prompt: 136,
	schema: 121,
	docs: 91,
	runtime: 80,
	state: 63,
	config: 55,
	security: 55,
	ui: 54,
	worktree: 43,
	"(root)": 43,
	benchmark: 37,
	agents: 31,
	workflows: 24,
	skills: 24,
	utils: 20,
	hooks: 20,
	observability: 16,
};

/** Top-level dir key of a test file path (relative or absolute, any base). */
export function shardDirKey(file) {
	const norm = String(file).replaceAll("\\", "/").replace(/^\.\//, "");
	// Drop empty segments (absolute-path leading "", stray "//") before prefix logic.
	const parts = norm.split("/").filter((p) => p !== "");
	// Locate a "test/unit" pair ANYWHERE in the path so absolute paths from CI
	// checkouts map like relative ones ('.../pi-crew/test/unit/runtime/x' → 'runtime').
	// Bare base-relative paths ('runtime/x.test.ts') fall back to segment 0. A
	// file DIRECTLY under the base dir has no deeper segment → "(root)" bucket.
	let i = 0;
	const unitIdx = parts.indexOf("unit");
	if (unitIdx > 0 && parts[unitIdx - 1] === "test") i = unitIdx + 1;
	else if (parts[0] === "test") i = 1;
	return parts.length <= i + 1 ? "(root)" : parts[i];
}

/**
 * Deterministic weighted contiguous partition (DP-03).
 * Sorts the file list (stable, locale-independent), accumulates each file's
 * directory weight, and cuts the sorted list into `total` contiguous runs
 * whose accumulated weights are as close to totalWeight/total as greedy fill
 * allows. The requested shard's slice is returned.
 * Determinism contract: same input list + same weights => byte-identical
 * shard contents across runs/machines (sorted input, integer weights).
 */
export function partitionShard(files, { shard, total, weights = SHARD_DIR_WEIGHTS }) {
	if (!Number.isInteger(shard) || !Number.isInteger(total) || total < 1 || shard < 0 || shard >= total) {
		throw new Error(`invalid shard spec: shard=${shard} total=${total} (want 0 <= shard < total, total >= 1)`);
	}
	const sorted = [...files].map((f) => String(f)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	if (total === 1) return sorted;
	const weightOf = (f) => {
		const key = shardDirKey(f);
		const w = weights[key];
		if (w === undefined) throw new Error(`no shard weight for directory '${key}' (${f}) — add it to SHARD_DIR_WEIGHTS`);
		return w;
	};
	const totalWeight = sorted.reduce((acc, f) => acc + weightOf(f), 0);
	const target = totalWeight / total;
	const out = [];
	let idx = 0;
	for (let s = 0; s < total; s += 1) {
		let acc = 0;
		while (idx < sorted.length) {
			// Last shard takes everything that remains.
			if (s === total - 1) {
				out.push(sorted[idx]);
				idx += 1;
				continue;
			}
			out.push(sorted[idx]);
			acc += weightOf(sorted[idx]);
			idx += 1;
			if (acc >= target) break;
		}
		if (s === shard) return out.splice(0);
		out.length = 0;
	}
	return [];
}

/** Parse a '--shard=i/n' CLI arg; returns {shard, total} or undefined. */
export function parseShardArg(arg) {
	const m = /^--shard=(\d+)\/(\d+)$/.exec(String(arg));
	if (!m) return undefined;
	return { shard: Number(m[1]), total: Number(m[2]) };
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
/** Best-effort post-suite sweep — never throws, never changes the exit code. */
function runTmpSweep(suiteStartMs) {
	if (process.env.PI_CREW_TEST_NO_TMP_SWEEP === "1") return;
	try {
		const out = sweepStaleTestTmpdirs({ thresholdMs: suiteStartMs - 30 * 60 * 1000 });
		if (out.removed > 0 || out.errors > 0) {
			console.log(`[test-runner] tmp-sweep: removed=${out.removed} skipped=${out.skipped} errors=${out.errors} (pre-existing pi-crew-* debris older than suite start − 30min)`);
		}
	} catch {
		/* sweep must never affect the test verdict */
	}
}

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

// Post-suite tmp sweep threshold: debris created/touched ≥30min BEFORE this
// suite started. Anything younger — including dirs from a CONCURRENT suite —
// is left alone (see sweep-test-tmp.mjs for the safety rules). Escapable via
// PI_CREW_TEST_NO_TMP_SWEEP=1.
const suiteStartMs = Date.now();

// DP-03: --shard=i/n selects this job's deterministic slice of the expanded
// file list (see partitionShard). Parsed BEFORE glob expansion so shards see
// the SAME fully-expanded list that a non-sharded run sees.
const shardSpec = args.map(parseShardArg).find((s) => s !== undefined);

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

// DP-03: apply the shard slice AFTER glob expansion (the shard must see the
// same recursive walk a full run sees, so union(shards) == full suite).
if (shardSpec) {
	const testFiles = finalArgs.filter((a) => !a.startsWith("--"));
	// Keep every flag EXCEPT the --shard arg itself (node rejects unknown options).
	const flags = finalArgs.filter((a) => a.startsWith("--") && parseShardArg(a) === undefined);
	const slice = partitionShard(testFiles, shardSpec);
	console.log(`[test-runner] shard ${shardSpec.shard}/${shardSpec.total}: ${slice.length}/${testFiles.length} files`);
	finalArgs = [...flags, ...slice];
}

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
	// 2026-09-24: shard runs are executed in BATCHES of ~20 files per spawn.
	// Two windows-latest CI runs (36026082690, 36030292059) stalled mid-shard
	// with ZERO failing tests: the child produced no output for the full
	// spawn budget (ETIMEDOUT) — consistent with a hosted-runner grandchild
	// spawn stall (Defender real-time scan / runner starvation), not test
	// code. One-spawn-per-shard turns such a stall into a total loss; batches
	// bound the damage to one batch, which is retried ONCE (stalls are
	// transient and stateless — files are independent).
	const perSpawnTimeoutMs = Number(process.env.PI_CREW_TEST_RUNNER_TIMEOUT_MS ?? 1_500_000);
	const batchSize = Number(process.env.PI_CREW_TEST_BATCH_SIZE ?? 20);
	const files = testArgs.filter((a) => !a.startsWith("--"));
	const flags = testArgs.filter((a) => a.startsWith("--"));

	const runSpawn = (args) =>
		spawnSync(process.execPath, [...nodeFlags, ...args], {
			stdio: "inherit",
			env: buildChildEnv(),
			// 2026-07-01: bumped from 600s → 900s after atomic-write.ts added
			// fs.fsyncSync for the mailbox-replay flake fix. fsync adds ~5-10ms
			// per atomic-write, which compounded across 5800 tests pushed
			// Windows CI just over the 10-minute budget.
			// 2026-09-17: bumped 900s → 1500s (per-spawn budget; with batching a
			// normal batch is 1–3 min, so the default only matters for
			// non-sharded whole-suite runs). Fail-closed per F05 below.
			timeout: perSpawnTimeoutMs,
		});

	if (shardSpec && files.length > batchSize) {
		const batchCount = Math.ceil(files.length / batchSize);
		let shardFailed = false;
		for (let b = 0; b < batchCount; b += 1) {
			const batch = files.slice(b * batchSize, (b + 1) * batchSize);
			const label = `batch ${b + 1}/${batchCount} (${batch.length} files)`;
			let result = runSpawn([...flags, ...batch]);
			let diagnostic = describeExitOutcome(result);
			// Transient-stall retry: only for spawn-level anomalies (timeout /
			// signal / spawn error), NEVER for a genuine nonzero test-failure
			// status — real test failures speak for themselves and retrying
			// would just double the cycle time.
			if (diagnostic) {
				console.error(`\n[test-runner] ${label}: ${diagnostic} — retrying this batch ONCE (transient stall policy).`);
				result = runSpawn([...flags, ...batch]);
				diagnostic = describeExitOutcome(result);
			}
			if (diagnostic || resolveExitCode(result) !== 0) {
				console.error(`\n[test-runner] ${label}: FAIL (inconclusive): ${diagnostic ?? "test failures"}.`);
				console.error("[test-runner] Treating this as a test FAILURE (fail closed) — exit code will be non-zero.");
				if (result.error) console.error("[test-runner] cause:", result.error.message);
				shardFailed = true;
				break; // fail fast: remaining batches don't change the verdict
			}
			console.log(`[test-runner] ${label}: OK`);
		}
		// Post-suite sweep of pre-existing leaked test tmpdirs (best-effort).
		runTmpSweep(suiteStartMs);
		process.exit(shardFailed ? 1 : 0);
	}

	const result = runSpawn(testArgs);

	// F05: fail closed. `status === null` means the child died by SIGNAL (or the
	// spawn itself failed) — the old `result.status ?? 0` turned that into a
	// green build. Only an explicit 0 with no signal is success.
	const diagnostic = describeExitOutcome(result);
	if (diagnostic) {
		console.error(`\n[test-runner] FAIL (inconclusive): ${diagnostic}.`);
		console.error("[test-runner] Treating this as a test FAILURE (fail closed) — exit code will be non-zero.");
		if (result.error) console.error("[test-runner] cause:", result.error.message);
	}
	runTmpSweep(suiteStartMs);
	process.exit(resolveExitCode(result));
}

} // end !isEntryPoint else-branch

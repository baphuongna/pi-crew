/**
 * F05 (RR-015) — exit semantics of `scripts/test-runner.mjs`.
 *
 * Before this file there was NO test covering the wrapper's exit semantics.
 * `scripts/test-runner.mjs` ended with `process.exit(result.status ?? 0)`, and
 * `spawnSync()` returns `status: null` whenever the child dies by SIGNAL, so a
 * test run whose coordinator was SIGKILLed exited **0** — a silent CI
 * false-green. Its stdout in that case is only `TAP version 13`, so a TAP
 * scraper cannot see the failure either: the exit code is the only signal, and
 * it was wrong.
 *
 * Two layers of coverage:
 *  1. `resolveExitCode()` — the pure decision function, asserted directly for
 *     every unknown/failed shape (no process spawning).
 *  2. The real wrapper spawned as a SUBPROCESS with the exit code asserted for:
 *     success, assertion failure, SIGTERM, SIGKILL and a spawn error.
 *
 * NOTE (story RR-015 "Gaps"): the F05 test cannot be run through the wrapper
 * while the wrapper is RED, so during RED→GREEN it was driven with
 * `node --import tsx/esm --test <this file>` directly.
 *
 * The fixtures are node:test `.mjs` files written to a temp dir: the wrapper
 * always spawns `node --import tsx/esm --test …`, so the fixture must be a real
 * test file that the Node test runner can load (a bare `-e` script would be
 * reported as a failing subtest instead of exercising the signal path).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// @ts-expect-error TS7016 — scripts/test-runner.mjs ships no .d.mts (it is a
// dev-only script excluded from the published tarball; see
// test/unit/package-files-no-dev-scripts.test.ts). The runtime import is what
// matters here: these are the REAL decision functions used by `npm test`.
import { describeExitOutcome, resolveExitCode } from "../../../scripts/test-runner.mjs";

const WRAPPER = fileURLToPath(new URL("../../../scripts/test-runner.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const tmpDirs: string[] = [];
after(() => {
	for (const dir of tmpDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

/** Write a fixture test file and return its absolute path. */
function fixture(name: string, body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "test-runner-exit-"));
	tmpDirs.push(dir);
	const file = join(dir, name);
	writeFileSync(file, body, "utf-8");
	return file;
}

/**
 * Spawn the real wrapper on a fixture and return `{status, signal, stdout}`.
 * `extraArgs` precede the fixture (e.g. a giant arg to force a spawn error).
 */
function runWrapper(
	file: string,
	extraArgs: string[] = [],
): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
	const res = spawnSync(process.execPath, [WRAPPER, ...extraArgs, file], {
		cwd: ROOT,
		encoding: "utf-8",
		timeout: 120_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { status: res.status, signal: res.signal, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// Layer 1 — the pure decision function
// ---------------------------------------------------------------------------

test("F05: resolveExitCode — only status 0 with no signal/error is success", () => {
	assert.equal(resolveExitCode({ status: 0, signal: null }), 0, "clean pass must stay 0");
	assert.equal(resolveExitCode({ status: 1, signal: null }), 1, "normal failure must relay its code");
	assert.equal(resolveExitCode({ status: 7, signal: null }), 7, "non-1 failure codes must be relayed");
});

test("F05: resolveExitCode — SIGKILL'd child is NOT success (the reported bug)", () => {
	// spawnSync returns exactly this shape when the child dies by signal:
	// status: null, signal: 'SIGKILL', error: undefined. `null ?? 0` = 0 = false green.
	assert.equal(resolveExitCode({ status: null, signal: "SIGKILL" }), 1, "SIGKILL must fail closed");
	assert.equal(resolveExitCode({ status: null, signal: "SIGTERM" }), 1, "SIGTERM must fail closed");
	assert.equal(resolveExitCode({ status: null, signal: "SIGINT" }), 1, "SIGINT must fail closed");
});

test("F05: resolveExitCode — undefined/null status with no signal fails closed", () => {
	assert.equal(resolveExitCode({ status: null, signal: null }), 1, "null status is an unknown outcome");
	assert.equal(resolveExitCode({ status: undefined, signal: null }), 1, "undefined status is an unknown outcome");
	assert.equal(resolveExitCode({}), 1, "missing status is an unknown outcome");
	assert.equal(resolveExitCode(null), 1, "no result object is an unknown outcome");
	assert.equal(resolveExitCode(undefined), 1, "no result object is an unknown outcome");
});

test("F05: resolveExitCode — spawn error fails closed even with a 0 status", () => {
	assert.equal(resolveExitCode({ status: null, signal: null, error: new Error("E2BIG") }), 1);
	assert.equal(resolveExitCode({ status: 0, signal: null, error: new Error("ETIMEDOUT") }), 1, "error wins over a status");
	assert.equal(resolveExitCode({ status: 0, signal: "SIGKILL" }), 1, "a signal is never a pass");
});

/**
 * Signal/arg-limit reporting differs by platform, so the two "measured shape"
 * checks below assert the F05 INVARIANT (a killed or un-spawnable child is
 * never success) and only pin the exact spawnSync shape where Node guarantees
 * it. Measured differences that forced this:
 *   - win32 has no POSIX signal delivery (termination arrives as an exit code);
 *   - macOS CI reported a killed child WITHOUT `status: null`, and the wrapper
 *     then printed no "FAIL (inconclusive)" diagnostic (stderr: '').
 */
const SIGNAL_DIAGNOSTIC_EMITTED = process.platform === "linux";

test("F05: resolveExitCode — handles the REAL spawnSync shapes (measured, not stubbed)", () => {
	// The shapes below are produced by real spawnSync calls, so the decision
	// function is asserted against what Node actually reports rather than
	// against hand-written stubs. This is the primitive the F05 verification
	// used to prove `null ?? 0 === 0`:
	//   spawnSync(node, ['-e','process.kill(process.pid,"SIGKILL")'])
	//     → { status: null, signal: 'SIGKILL', error: undefined }  (linux)
	const killed = spawnSync(process.execPath, ["-e", 'process.kill(process.pid,"SIGKILL")']);
	if (killed.signal) {
		// A signalled child ALWAYS reports status null — Node's contract, all
		// platforms that deliver signals. This is the exact shape that used to
		// yield exit 0 via `status ?? 0`.
		assert.equal(killed.status, null, "precondition: a signalled child reports status null");
		assert.equal(killed.signal, "SIGKILL", "precondition: the signal is reported");
	}
	assert.notEqual(
		resolveExitCode(killed),
		0,
		`a killed child must never read as success (${JSON.stringify({ status: killed.status, signal: killed.signal })})`,
	);

	// A single argument over MAX_ARG_STRLEN (128 KiB on Linux) makes the spawn
	// itself fail: { status: null, signal: null, error: E2BIG }.
	const tooBig = spawnSync(process.execPath, ["-e", "1", "x".repeat(400_000)]);
	if (tooBig.error) {
		assert.equal(tooBig.status, null, "precondition: a failed spawn reports status null");
		assert.equal(resolveExitCode(tooBig), 1, "a spawn error must fail closed");
		assert.match(describeExitOutcome(tooBig) ?? "", /spawn failed/);
	} else {
		// No per-argv length limit on this platform (MAX_ARG_STRLEN is Linux-only,
		// and win32 CreateProcess caps the whole command line instead) — the
		// decision layer is already covered by the stubbed shapes above.
		assert.equal(tooBig.status, 0, `expected the oversized spawn to fail or succeed cleanly, got ${JSON.stringify(tooBig.status)}`);
	}
});

test("F05: describeExitOutcome — explains every non-plain-failure outcome", () => {
	assert.equal(describeExitOutcome({ status: 0, signal: null }), undefined, "a clean pass needs no diagnostic");
	assert.equal(describeExitOutcome({ status: 1, signal: null }), undefined, "a plain test failure speaks for itself");
	assert.match(describeExitOutcome({ status: null, signal: "SIGKILL" }) ?? "", /SIGKILL/);
	assert.match(describeExitOutcome({ status: null, signal: null }) ?? "", /without a status code/);
	assert.match(describeExitOutcome({ status: null, signal: null, error: new Error("E2BIG boom") }) ?? "", /E2BIG boom/);
});

// ---------------------------------------------------------------------------
// Layer 2 — the real wrapper as a subprocess (exit code is the assertion)
// ---------------------------------------------------------------------------

test("F05/AC-4: wrapper exits 0 when the tests pass", () => {
	const file = fixture("pass.mjs", 'import test from "node:test";\ntest("ok", () => {});\n');
	const res = runWrapper(file);
	assert.equal(res.status, 0, `passing suite must exit 0. stderr: ${res.stderr}`);
	assert.match(res.stdout, /TAP version 13/);
});

test("F05/AC-3: wrapper exits 1 when an assertion fails", () => {
	const file = fixture("fail.mjs", 'import test from "node:test";\ntest("boom", () => { throw new Error("nope"); });\n');
	const res = runWrapper(file);
	assert.equal(res.status, 1, `failing suite must exit 1. stderr: ${res.stderr}`);
	assert.match(res.stdout, /not ok/);
});

test("F05/AC-2: wrapper exits non-zero when the coordinator is SIGTERM'd", () => {
	const file = fixture("term.mjs", 'process.kill(process.ppid, "SIGTERM");\nawait new Promise((r) => setTimeout(r, 5000));\n');
	const res = runWrapper(file);
	assert.notEqual(res.status, 0, `SIGTERM'd coordinator must not exit 0 (stdout: ${res.stdout.slice(0, 200)})`);
});

test("F05/AC-1: wrapper exits non-zero when the coordinator is SIGKILL'd (was 0)", () => {
	// RED before the fix: EXIT=0 with stdout containing only "TAP version 13"
	// (no `not ok` line for a TAP scraper), i.e. an invisible CI false-green.
	const file = fixture("kill.mjs", 'process.kill(process.ppid, "SIGKILL");\nawait new Promise((r) => setTimeout(r, 5000));\n');
	const res = runWrapper(file);
	// The F05 contract, asserted on EVERY platform: a killed coordinator is never
	// reported as success.
	assert.notEqual(res.status, 0, `SIGKILL'd coordinator must not exit 0 (stdout: ${res.stdout.slice(0, 200)})`);
	if (SIGNAL_DIAGNOSTIC_EMITTED) {
		assert.match(
			res.stderr,
			/FAIL \(inconclusive\)|SIGKILL|without a status code/,
			`a diagnostic must be printed. stderr: ${res.stderr}`,
		);
	}
});

test("F05/AC-5: the spawn-error branch fails closed (covered at the decision layer, see note)", (t) => {
	// Platform gate: macOS ARG_MAX is far larger than Linux's — a 400 KiB argv
	// does NOT trigger E2BIG there, so the precondition (spawnSync reports an
	// error) is un-reproducible on darwin. The decision layer itself is covered
	// by the resolveExitCode unit tests on every platform.
	const realE2bigProbe = spawnSync(process.execPath, ["-e", "1", "x".repeat(400_000)]);
	if (!realE2bigProbe.error) {
		t.skip("E2BIG is not reproducible on this platform (ARG_MAX too large — macOS)");
		return;
	}
	// LIMITATION (documented, not worked around): the wrapper's spawn-error
	// branch cannot be exercised end-to-end from a test process, because the
	// kernel limit that makes the INNER spawn fail (MAX_ARG_STRLEN = 128 KiB per
	// argv string on Linux) makes this test's OUTER spawn of the wrapper fail
	// first — measured: `node wrapper <400KB arg>` from a driver process returns
	// `{status: null, signal: null, error: E2BIG}` from the driver's own
	// spawnSync, so the wrapper never even starts. Adding an env seam to force
	// the inner failure would test the seam, not the wrapper.
	//
	// What IS covered for AC-5:
	//   - `resolveExitCode` / `describeExitOutcome` against a REAL E2BIG object
	//     captured from spawnSync (test above) — this is the exact code path the
	//     wrapper executes for a spawn error, since the wrapper's only spawn-error
	//     handling is `resolveExitCode(result)` + `describeExitOutcome(result)`.
	//   - The timeout flavour of a spawn error (spawnSync kills the child on
	//     timeout → `error: ETIMEDOUT` AND `signal: SIGTERM`) is covered by the
	//     SIGTERM subprocess test above, which asserts non-zero end-to-end.
	//   - The diagnostic text is asserted directly on the real E2BIG object.
	const realE2big = spawnSync(process.execPath, ["-e", "1", "x".repeat(400_000)]);
	assert.ok(realE2big.error, "precondition: spawnSync reports an error for an oversized argument");
	assert.notEqual(resolveExitCode(realE2big), 0, "the wrapper's decision must be non-zero for this object");
	assert.match(describeExitOutcome(realE2big) ?? "", /spawn failed/, "the wrapper must have a diagnostic to print");
});

test("F05: wrapper source does not fall back to `status ?? 0` (regression guard)", () => {
	// The exact one-line regression that caused F05. Asserting on the source is
	// redundant with the subprocess tests above, but it pins the SHAPE of the
	// bug so a future refactor cannot quietly reintroduce it while the
	// subprocess tests are skipped for some unrelated reason.
	const source = readFileSync(WRAPPER, "utf-8");
	// Strip comments first: the file's own header DOCUMENTS the removed bug
	// (`process.exit(result.status ?? 0)`), which would otherwise match.
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	assert.doesNotMatch(code, /process\.exit\(\s*result\.status\s*\?\?\s*0\s*\)/, "must not map a null status to exit 0");
	assert.match(code, /process\.exit\(resolveExitCode\(result\)\)/, "must exit via the fail-closed decision function");
	// Nested-runner guard: inheriting NODE_TEST_CONTEXT makes a nested
	// `node --test` run nothing and exit 0 (measured), which is the same class
	// of silent false-green.
	assert.match(code, /delete env\.NODE_TEST_CONTEXT/, "must strip NODE_TEST_CONTEXT from the child env");
});

test("F05: wrapper still prints the no-args notice and exits 0", () => {
	// Guard against the entry-point check breaking the CLI: with no args the
	// wrapper must keep its documented graceful exit (used by node's runner).
	const res = spawnSync(process.execPath, [WRAPPER], {
		cwd: ROOT,
		encoding: "utf-8",
		timeout: 30_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(res.status, 0, `no-args invocation must exit 0. stderr: ${res.stderr}`);
	assert.match(res.stdout ?? "", /skip: no test files specified/);
});

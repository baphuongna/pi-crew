import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	__test__validateGateCommand,
	CARGO_RUST_GATES,
	computeGreenLevelFromResults,
	executeCommand,
	executeVerificationCommands,
	NPM_TYPESCRIPT_GATES,
	runPhaseGates,
} from "../../../../src/runtime/verification/verification-gates.ts";
import type { VerificationCommandResult } from "../../../../src/state/types.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

test("verification-gates: NPM_TYPESCRIPT_GATES has expected phases", () => {
	assert.equal(NPM_TYPESCRIPT_GATES.length, 4);
	assert.ok(NPM_TYPESCRIPT_GATES.every((g) => g.name && g.command));
});

test("verification-gates: CARGO_RUST_GATES has expected phases", () => {
	assert.equal(CARGO_RUST_GATES.length, 3);
	assert.ok(CARGO_RUST_GATES.every((g) => g.name && g.command));
});

test("verification-gates: runPhaseGates executes commands sequentially", async () => {
	const gates = [
		{ name: "echo", command: "echo 'hello'", critical: true },
		{ name: "echo2", command: "echo 'world'", critical: true },
	];
	const result = await runPhaseGates(gates, process.cwd());
	assert.equal(result.results.length, 2);
	assert.equal(result.results[0].status, "passed");
	assert.equal(result.results[1].status, "passed");
	assert.ok(result.allPassed);
});

test("verification-gates: runPhaseGates stops on critical failure", async () => {
	const gates = [
		{ name: "success", command: "true", critical: true },
		{ name: "fails", command: "false", critical: true },
		{
			name: "would-run",
			command: "echo 'should not run'",
			critical: true,
		},
	];
	const result = await runPhaseGates(gates, process.cwd());
	// Results contain only executed gates (not skipped)
	assert.equal(result.results.length, 2);
	assert.equal(result.results[0].status, "passed");
	assert.equal(result.results[1].status, "failed");
	assert.ok(!result.allPassed);
	assert.equal(result.stoppedAt, 2);
});

test("verification-gates: runPhaseGates continues on non-critical failure", async () => {
	const gates = [
		{ name: "success", command: "true", critical: true },
		{ name: "fails", command: "false", critical: false },
		{
			name: "continues",
			command: "echo 'still going'",
			critical: true,
		},
	];
	const result = await runPhaseGates(gates, process.cwd());
	assert.equal(result.results.length, 3);
	assert.equal(result.results[0].status, "passed");
	assert.equal(result.results[1].status, "failed");
	assert.equal(result.results[2].status, "passed");
});

test("verification-gates: computeGreenLevelFromResults all passed", () => {
	const results: VerificationCommandResult[] = [
		{ cmd: "npm test", status: "passed", exitCode: 0 },
		{ cmd: "npm run build", status: "passed", exitCode: 0 },
	];
	const level = computeGreenLevelFromResults(results, "targeted");
	assert.equal(level, "targeted");
});

test("verification-gates: computeGreenLevelFromResults all failed", () => {
	const results: VerificationCommandResult[] = [{ cmd: "npm test", status: "failed", exitCode: 1 }];
	const level = computeGreenLevelFromResults(results, "targeted");
	assert.equal(level, "none");
});

test("verification-gates: computeGreenLevelFromResults partial pass", () => {
	const results: VerificationCommandResult[] = [
		{ cmd: "npm test", status: "passed", exitCode: 0 },
		{ cmd: "npm run build", status: "not_run" },
	];
	const level = computeGreenLevelFromResults(results, "targeted");
	assert.equal(level, "targeted");
});

test("verification-gates: computeGreenLevelFromResults empty commands", () => {
	const results: VerificationCommandResult[] = [];
	const level = computeGreenLevelFromResults(results, "targeted");
	assert.equal(level, "none");
});

test("verification-gates: executeVerificationCommands with empty contract", async () => {
	const results = await executeVerificationCommands(
		{
			requiredGreenLevel: "targeted",
			commands: [],
			allowManualEvidence: true,
		},
		process.cwd(),
		"test-run",
		"test-task",
		"/tmp",
	);
	assert.deepEqual(results, []);
});

// ── P-4 (DR-04 round-7): capped accumulation while streaming ────────────────
// The final result was always sliced to 100k, but the live buffer concatenated
// EVERY chunk until close/timeout — a multi-MB/GB-emitting gate held it all in
// memory. Past ~200KB the appender must stop and pin "[truncated]".

test("verification-gates: executeCommand bounds the accumulation buffer past the cap", { timeout: 60_000 }, async () => {
	// 300KB of output (> 200KB cap) from an allowlisted reader command. S-3
	// note: the original fixture was `head -c 300000 /dev/zero`, but reader
	// path args must stay cwd-relative now — write the blob to a temp dir
	// under cwd and read it via a relative path. (An `echo` with a 300KB
	// literal hits Linux MAX_ARG_STRLEN and the spawn dies with E2BIG.)
	const bigDir = path.join(process.cwd(), ".test-artifacts-tmp");
	fs.mkdirSync(bigDir, { recursive: true });
	fs.writeFileSync(path.join(bigDir, "p4-big.bin"), Buffer.alloc(300_000, 0x78)); // 'x' × 300KB
	try {
		const res = await executeCommand("head -c 300000 .test-artifacts-tmp/p4-big.bin", process.cwd(), 30000);
		assert.equal(res.exitCode, 0);
		// Final slice(-100000) still bounds the result…
		assert.ok(res.output.length <= 100000, `result must stay ≤100000 chars, got ${res.output.length}`);
		// …and the streaming buffer stopped at the cap with a visible marker.
		assert.ok(res.output.includes("[truncated]"), "capped stream must carry the [truncated] marker");
		assert.ok(res.durationMs >= 0);
	} finally {
		await removeDirWithRetry(bigDir);
	}
});

test("verification-gates: executeCommand output under the cap is untruncated", { timeout: 30_000 }, async () => {
	const res = await executeCommand("echo small-output", process.cwd(), 30000);
	assert.equal(res.exitCode, 0);
	assert.ok(res.output.includes("small-output"));
	assert.ok(!res.output.includes("[truncated]"), "small output must not be marked truncated");
});

// ── S-3 (deep review 2026-10-31): gate allowlist hardening ─────────────────
// (1) `printenv` is dropped — it is an env-dump read primitive no built-in
//     gate needs, and its output is captured into verification artifacts.
// (2) grep/head/rg/tail remain allowlisted only as cwd-scoped evidence
//     extractors: path arguments must stay inside the gate cwd, so absolute
//     and `~`-prefixed args (quoted or bare) are rejected.

const rejectGateCommand = (cmd: string) => assert.throws(() => __test__validateGateCommand(cmd), /Security/i, `expected rejection: ${cmd}`);
const acceptGateCommand = (cmd: string) => __test__validateGateCommand(cmd); /* no throw */

test("verification-gates: S-3 printenv is rejected (env-dump read primitive)", () => {
	rejectGateCommand("printenv");
	rejectGateCommand("printenv PATH");
	rejectGateCommand("printenv ANTHROPIC_API_KEY");
});

test("verification-gates: S-3 reader commands reject absolute path args", () => {
	rejectGateCommand("grep -m1 . /etc/passwd");
	rejectGateCommand("head -n 5 /etc/passwd");
	rejectGateCommand("tail -f /var/log/syslog");
	rejectGateCommand("rg secret /home");
	// Quoted absolute paths must not slip through (sh expands quotes before
	// path resolution).
	rejectGateCommand('grep -m1 . "/etc/passwd"');
	rejectGateCommand("grep -m1 . '/etc/passwd'");
});

test("verification-gates: S-3 reader commands reject ~ path args", () => {
	rejectGateCommand("grep -rn secret ~/notes.txt");
	rejectGateCommand("head ~/.ssh/authorized_keys");
});

test("verification-gates: S-3 reader commands allow cwd-relative path args", () => {
	acceptGateCommand("grep -r pattern src/");
	acceptGateCommand("grep -c marker dist/index.mjs");
	acceptGateCommand("head -c 100 package.json");
	acceptGateCommand("tail -40");
	// Pipeline sides are checked separately — an allowed runner piped into a
	// pathless reader stays valid.
	acceptGateCommand("npm test 2>&1 | tail -40");
});

test("verification-gates: S-3 hardening — reader path args are CONTAINED in the gate cwd", () => {
	// Closing hardening (2026-10-31, LOW ruling): ..-traversal escapes, Windows
	// absolute forms, attached option values carrying paths, and the rg --pre
	// preprocessor execution primitive. gateCwd threads from executeCommand's
	// cwd — exactly where the reader will actually resolve its args.
	const gateCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-reader-cwd-"));
	try {
		const rejectInCwd = (cmd: string) =>
			assert.throws(() => __test__validateGateCommand(cmd, gateCwd), /Security/i, `expected rejection: ${cmd}`);
		const acceptInCwd = (cmd: string) => __test__validateGateCommand(cmd, gateCwd); /* no throw */
		// ..-relative escapes: leading (lexical) and MID-PATH (needs the cwd
		// resolve — a leading-`..`-only check would miss sub/../../x).
		rejectInCwd("grep -r x ../../../etc/passwd");
		rejectInCwd("grep -r x sub/../../escape.txt");
		// Windows absolute forms — drive letter and UNC share.
		rejectInCwd("grep -m1 . C:/Windows/win.ini");
		rejectInCwd("head -n 1 \\\\host\\share\\secret.txt");
		// Attached option values carrying a path smuggle absolutes past the
		// positional checks.
		rejectInCwd("grep -f/etc/x secret");
		// rg --pre executes an arbitrary preprocessor per file read.
		rejectInCwd("rg --pre=/usr/bin/id x");
		rejectInCwd("rg --pre /usr/bin/id x");
		// Cwd-relative evidence extraction keeps working (the packet pin), and
		// in-cwd `..` round-trips stay allowed — containment, not a naive ban.
		acceptInCwd("grep -m1 . dist.txt");
		acceptInCwd("grep -rn pattern src/");
		acceptInCwd("grep -c marker sub/../dist.txt");
	} finally {
		fs.rmSync(gateCwd, { recursive: true, force: true });
	}
});

test("verification-gates: S-3 runner patterns unaffected by reader path scoping", () => {
	acceptGateCommand("npm test");
	acceptGateCommand("npm run ci");
	acceptGateCommand("pnpm run build");
	acceptGateCommand("yarn test");
	acceptGateCommand("npx biome check .");
	acceptGateCommand("npx --no-install tsc --noEmit");
	acceptGateCommand("biome format .");
	acceptGateCommand("node --experimental-strip-types --no-warnings --test test/unit/x.test.ts");
});

/**
 * HB-004 smoke #1: argv flags the real `pi` binary accepts.
 *
 * Regression guard for the `--crew-subagent` bug (commit c55d3e2): an earlier
 * process-safety fix prepended an unknown flag to argv, and pi's strict option
 * parser exited non-zero on every ctx.agent() call. The unit suite missed it
 * because it never invokes the real binary.
 *
 * ── F19 (RR-015) REWRITE — WHAT THIS PROBE DOES AND DOES NOT PROVE ──────────
 *
 * The previous version was VACUOUS. It built `built.args` (lines 33-38), then
 * invoked the real binary with `["--version"]` ONLY — `built.args` never
 * reached any spawn. Worse, its premise was false: it claimed
 *
 *     "a flag pi rejects will error immediately even on --version
 *      (the parser runs before the version print)"
 *
 * Measured against pi 0.85.1, `--version` short-circuits BEFORE flag
 * validation:
 *
 *     pi --version --definitely-not-a-flag   → EXIT 0, stdout "0.85.1"
 *     pi --definitely-not-a-flag             → EXIT 1, "Error: Unknown option: …"
 *
 * so appending `built.args` to `--version` would NOT have made the test catch
 * anything. `--version` proves only that the binary starts.
 *
 * This version exercises a REAL parse. Measured on pi 0.85.1:
 *
 *   a) `built.args` + a bogus flag            → EXIT 1, "Error: Unknown option: <flag>"
 *   b) built.args alone (auth-free HOME)      → EXIT 1, "No API key found …"
 *      i.e. it clears the PARSER and dies later, at the model/provider stage
 *   c) built.args + `--help`                  → EXIT 0 (help short-circuits like --version)
 *
 * So the discriminating assertions are (a) and (b):
 *   - The parser runs on the FULL constructed argv (proved by (a): the bogus
 *     flag is reported by name, i.e. the parser saw it), and
 *   - every flag buildPiWorkerArgs emits is ACCEPTED (proved by (b): the run
 *     gets PAST the parser to the provider stage — if any emitted flag were
 *     unknown, the error would be "Unknown option: <that flag>" instead of
 *     "No API key found").
 *
 * WHAT IT STILL DOES NOT PROVE: that a worker actually RUNS. No model is
 * called here (deliberately — this probe must stay token-free so the weekly
 * canary can run it without credentials). Semantics of the flags, and the
 * end-to-end spawn lifecycle, are covered by the LLM-billed smoke tests
 * (agent-*.smoke.ts) which are gated on model auth via `smokeSkipReason()`.
 *
 * SKIP GATE: `binarySmokeSkipReason()` — PI_CREW_SMOKE=1 only, NO auth
 * required, so this probe really runs in .github/workflows/weekly-smoke.yml
 * (which configures no `secrets.*`).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPiWorkerArgs, cleanupTempDir } from "../../src/runtime/model/pi-args.ts";
import { getPiSpawnCommand } from "../../src/runtime/pi-spawn.ts";
import { binarySmokeSkipReason, fakeExecutorAgent } from "./_helpers.ts";

/** Flags that MUST never appear in worker argv (strict pi parser rejects them). */
const FORBIDDEN_FLAGS = ["--crew-subagent"];

interface RunOutcome {
	status: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Spawn the real `pi` with the given argv, in an AUTH-FREE environment.
 *
 * The HOME override is what makes the probe discriminating: with no
 * credentials, `pi` reaches the provider lookup and fails there with
 * "No API key found" — which is only reachable if the PARSER accepted every
 * argument first. With auth present the run would instead start a real model
 * call (billed), so an auth-free env is both cheaper and stricter here.
 */
function runPi(args: string[], noAuthHome: string): RunOutcome {
	const spec = getPiSpawnCommand([]);
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: noAuthHome, USERPROFILE: noAuthHome };
	delete env.PI_AUTH_JSON;
	delete env.PI_TEAMS_PI_BIN;
	try {
		const stdout = execFileSync(spec.command, [...spec.args, ...args], {
			encoding: "utf-8",
			timeout: 30_000,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		const e = error as { status?: number | null; stdout?: string; stderr?: string };
		return { status: e.status ?? null, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
}

test("smoke: pi's parser accepts every flag buildPiWorkerArgs emits (real argv, real parse)", {
	skip: binarySmokeSkipReason(),
}, () => {
	// A HOME with no ~/.pi/agent/auth.json → auth-free, token-free run.
	const noAuthHome = mkdtempSync(join(tmpdir(), "pi-crew-smoke-noauth-"));
	const built = buildPiWorkerArgs({
		task: "no-op",
		agent: fakeExecutorAgent(),
		sessionEnabled: true,
		role: "executor",
	});

	try {
		// ── Static shape assertions (cheap, catch the original regression) ──
		for (const flag of FORBIDDEN_FLAGS) {
			assert.ok(!built.args.includes(flag), `${flag} must never be emitted (pi rejects unknown flags); see commit c55d3e2`);
		}
		for (const flag of ["--mode", "json", "-p"]) {
			assert.ok(built.args.includes(flag), `expected argv to include "${flag}"`);
		}

		// ── (a) DISCRIMINATION: the parser sees the FULL constructed argv ──
		// A bogus flag appended to built.args must be reported BY NAME. This is
		// what proves the probe is not vacuous: if the parser were short-
		// circuiting (as `--version` does), this would exit 0.
		const sentinel = "--definitely-not-a-flag";
		const withSentinel = runPi([...built.args, sentinel], noAuthHome);
		assert.notEqual(
			withSentinel.status,
			0,
			`a bogus flag appended to built.args must be rejected. stdout: ${withSentinel.stdout.slice(0, 200)}`,
		);
		assert.match(
			withSentinel.stderr,
			new RegExp(`Unknown option.*${sentinel}`),
			`the parser must name the rejected flag (proves built.args reached the parser). stderr: ${withSentinel.stderr.slice(0, 300)}`,
		);

		// ── (b) built.args alone must clear the PARSER ──
		// Auth-free, so the run must fail at the PROVIDER stage ("No API key
		// found"), NOT at the parser. Any unknown emitted flag would surface as
		// "Unknown option: <flag>" instead.
		const clean = runPi(built.args, noAuthHome);
		assert.doesNotMatch(
			clean.stderr,
			/Unknown option/i,
			`pi rejected a flag emitted by buildPiWorkerArgs. stderr: ${clean.stderr.slice(0, 400)}`,
		);
		assert.match(
			clean.stderr,
			/No API key found/i,
			`expected the run to clear the parser and stop at the provider stage (auth-free). stderr: ${clean.stderr.slice(0, 400)}`,
		);
	} finally {
		cleanupTempDir(built.tempDir);
		try {
			rmSync(noAuthHome, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

/**
 * The probe must be able to FAIL. Without this, a future refactor that makes
 * `runPi` swallow every error would leave the test above vacuously green —
 * exactly the F19 failure mode. This asserts the negative control directly:
 * a bare bogus flag (no built.args) is rejected.
 */
test("smoke: the argv probe can fail — a bare unknown flag is rejected by pi", {
	skip: binarySmokeSkipReason(),
}, () => {
	const noAuthHome = mkdtempSync(join(tmpdir(), "pi-crew-smoke-noauth-"));
	try {
		const res = runPi(["--definitely-not-a-flag"], noAuthHome);
		assert.notEqual(res.status, 0, "pi must reject an unknown flag");
		assert.match(res.stderr, /Unknown option/, `stderr: ${res.stderr.slice(0, 300)}`);
	} finally {
		try {
			rmSync(noAuthHome, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

/**
 * Documents the measurement the rewrite is based on: `--version` short-
 * circuits BEFORE flag validation, so it can never be used to validate argv.
 * If a future `pi` starts validating under `--version`, this test fails loudly
 * and the F19 design note must be revisited (story RR-015 "Gaps").
 */
test("smoke: --version does NOT validate flags (why the old probe was vacuous)", {
	skip: binarySmokeSkipReason(),
}, () => {
	const noAuthHome = mkdtempSync(join(tmpdir(), "pi-crew-smoke-noauth-"));
	try {
		const res = runPi(["--version", "--definitely-not-a-flag"], noAuthHome);
		assert.equal(
			res.status,
			0,
			"pi now validates flags under --version — the F19 design note (and this probe's rationale) must be revisited",
		);
		assert.match(res.stdout.trim(), /\d+\.\d+\.\d+/, "pi --version should print a semver");
	} finally {
		try {
			rmSync(noAuthHome, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

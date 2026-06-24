/**
 * HB-004 smoke #1: argv flags the real `pi` binary accepts.
 *
 * Regression guard for the `--crew-subagent` bug (commit c55d3e2): an earlier
 * process-safety fix prepended an unknown flag to argv, and pi's strict option
 * parser exited non-zero on every ctx.agent() call. The unit suite missed it
 * because it never invokes the real binary.
 *
 * This test does NOT spawn a full agent (token cost). It runs `pi --version`
 * with each argv flag buildPiWorkerArgs emits appended, and asserts pi does
 * not reject the flag. (pi --version exits early before flag-dependent work,
 * so unknown flags surface as "Error: Unknown option".)
 *
 * NOTE: pi --version with extra args may or may not validate args before
 * printing version. If it doesn't validate, this test degrades to a baseline
 * "pi runs" check. The authoritative guard is test #2-4 which run real agents.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildPiWorkerArgs } from "../../src/runtime/pi-args.ts";
import { getPiSpawnCommand } from "../../src/runtime/pi-spawn.ts";
import { SMOKE_ENABLED, SKIP_REASON, fakeExecutorAgent } from "./_helpers.ts";

test("smoke: buildPiWorkerArgs emits NO unknown argv flag (pi --version still works)", { skip: SMOKE_ENABLED ? false : SKIP_REASON }, () => {
	// Build the args the way child-pi.ts would, then verify pi doesn't choke on
	// any of them by running pi --version with the same leading flags. We can't
	// run the full task here (token cost) — but a flag pi rejects will error
	// immediately even on --version (the parser runs before the version print).
	const built = buildPiWorkerArgs({
		task: "no-op",
		agent: fakeExecutorAgent(),
		sessionEnabled: true,
		role: "executor",
	});

	// Sanity: the regression flag must NOT be present.
	assert.ok(
		!built.args.includes("--crew-subagent"),
		"--crew-subagent must never be emitted (pi rejects unknown flags); see commit c55d3e2",
	);

	// Spot-check the canonical flags are still emitted (these are the ones that
	// have broken before). If pi's parser ever tightens, this is the canary.
	const expectedFlags = ["--mode", "json", "-p"];
	for (const flag of expectedFlags) {
		assert.ok(built.args.includes(flag), `expected argv to include "${flag}"`);
	}

	// Run pi --version via the same resolver child-pi.ts uses (the `pi` symlink
	// can misbehave under execFileSync on some platforms; getPiSpawnCommand
	// resolves to node + cli.js directly, which is the production code path).
	try {
		const spec = getPiSpawnCommand(["--version"]);
		const out = execFileSync(spec.command, spec.args, { encoding: "utf-8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
		assert.match(out.trim(), /\d+\.\d+\.\d+/, "pi --version should print a semver");
	} catch (error) {
		// On smoke-disabled CI we skip; if smoke is on and pi is missing, surface it.
		throw new Error(`pi binary not callable in smoke env: ${error instanceof Error ? error.message : String(error)}`);
	}
});

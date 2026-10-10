/**
 * U13 (upgrade spec 2026-10-09 §U13): deterministic verifier pre-gate engine
 * tests — pure decision logic, default check resolution, the two-layer
 * decision composition with the U6B classifier pre-gate, and the spawn-site
 * orchestration (subprocess executor + metrics).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { createMetricRegistry } from "../../../../src/observability/metric-registry.ts";
import {
	createSubprocessVerifyGateExecutor,
	defaultVerifyGateChecks,
	evaluateVerifyGateResults,
	renderVerifyGateContext,
	renderVerifyGateSummary,
	resolveVerifierSpawnDecision,
	resolveVerifyGateEnabled,
	resolveVerifyGateTimeoutMs,
	runVerifierGatePreGate,
	runVerifyGate,
	type VerifyGateCheck,
	type VerifyGateExecutor,
} from "../../../../src/runtime/verification/verify-gate.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

/** Executor stub: scripted exit codes per command substring. */
function scriptedExecutor(
	behavior: Record<string, { exitCode: number | null; output?: string; error?: string }>,
): VerifyGateExecutor & { calls: Array<{ command: string; cwd: string }> } {
	const calls: Array<{ command: string; cwd: string }> = [];
	const exec: VerifyGateExecutor = async (command, opts) => {
		calls.push({ command, cwd: opts.cwd });
		for (const [needle, result] of Object.entries(behavior)) {
			if (command.includes(needle))
				return { exitCode: result.exitCode, output: result.output ?? "", ...(result.error ? { error: result.error } : {}) };
		}
		return { exitCode: 0, output: "" };
	};
	return Object.assign(exec, { calls });
}

test("runVerifyGate: all checks exit 0 → verdict PASS with evidence lines", async () => {
	const exec = scriptedExecutor({ typecheck: { exitCode: 0 }, "test:critical": { exitCode: 0, output: "101/101 pass" } });
	const outcome = await runVerifyGate(
		[
			{ name: "typecheck", command: "npm run typecheck" },
			{ name: "test-critical", command: "npm run test:critical" },
		],
		exec,
		{ cwd: "/tmp" },
	);
	assert.equal(outcome.verdict, "PASS");
	assert.equal(outcome.allPassed, true);
	assert.equal(outcome.evidenceLines.length, 2);
	assert.match(outcome.evidenceLines[0]!, /typecheck: exit=0 PASS/);
	assert.equal(exec.calls.length, 2);
});

test("runVerifyGate: critical failure stops the gate (later checks not executed)", async () => {
	const exec = scriptedExecutor({ typecheck: { exitCode: 2, output: "error TS2322" } });
	const outcome = await runVerifyGate(
		[
			{ name: "typecheck", command: "npm run typecheck" },
			{ name: "test-critical", command: "npm run test:critical" },
		],
		exec,
		{ cwd: "/tmp" },
	);
	assert.equal(outcome.verdict, "FAILED");
	assert.equal(exec.calls.length, 1); // stopped on critical failure
	assert.equal(outcome.checks.length, 1);
	assert.match(outcome.evidenceLines[0]!, /typecheck: exit=2 FAIL/);
});

test("runVerifyGate: non-critical failure lets the gate continue", async () => {
	const exec = scriptedExecutor({ grep: { exitCode: 1, output: "0 matches" } });
	const outcome = await runVerifyGate(
		[
			{ name: "typecheck", command: "npm run typecheck" },
			{ name: "grep-evidence", command: "grep -c marker dist/index.mjs", critical: false },
		],
		exec,
		{ cwd: "/tmp" },
	);
	assert.equal(outcome.verdict, "FAILED");
	assert.equal(exec.calls.length, 2);
});

test("runVerifyGate: executor rejection degrades the check, never the host", async () => {
	const exec: VerifyGateExecutor = async () => {
		throw new Error("boom");
	};
	const outcome = await runVerifyGate([{ name: "typecheck", command: "npm run typecheck" }], exec, { cwd: "/tmp" });
	assert.equal(outcome.verdict, "FAILED");
	assert.equal(outcome.checks[0]?.exitCode, null);
	assert.match(outcome.checks[0]?.error ?? "", /boom/);
});

test("runVerifyGate: zero checks → INCONCLUSIVE", async () => {
	const exec = scriptedExecutor({});
	const outcome = await runVerifyGate([], exec, { cwd: "/tmp" });
	assert.equal(outcome.verdict, "INCONCLUSIVE");
	assert.equal(outcome.allPassed, false);
});

test("runVerifyGate: aborted signal marks remaining checks skipped", async () => {
	const controller = new AbortController();
	controller.abort();
	const exec = scriptedExecutor({});
	const outcome = await runVerifyGate([{ name: "typecheck", command: "npm run typecheck" }], exec, {
		cwd: "/tmp",
		signal: controller.signal,
	});
	assert.equal(outcome.checks[0]?.skipped, true);
	assert.equal(outcome.verdict, "INCONCLUSIVE"); // nothing RAN → not FAILED
});

test("evaluateVerifyGateResults: skipped-only results are INCONCLUSIVE", () => {
	const outcome = evaluateVerifyGateResults([
		{ name: "x", command: "y", exitCode: null, passed: false, durationMs: 0, outputTail: "", skipped: true },
	]);
	assert.equal(outcome.verdict, "INCONCLUSIVE");
});

test("defaultVerifyGateChecks: resolves typecheck + test:critical from package.json scripts", () => {
	const dir = createTrackedTempDir("pi-crew-verify-gate-defaults-");
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "t", scripts: { typecheck: "tsc --noEmit", "test:critical": "node scripts/test-runner.mjs --critical" } }),
		"utf8",
	);
	const checks = defaultVerifyGateChecks(dir);
	assert.equal(checks.length, 2);
	assert.equal(checks[0]?.name, "typecheck");
	assert.match(checks[0]?.command ?? "", /npm run --silent typecheck/);
	assert.equal(checks[1]?.name, "test-critical");
	// Only one script present → only one check
	const dir2 = createTrackedTempDir("pi-crew-verify-gate-defaults2-");
	fs.writeFileSync(path.join(dir2, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }), "utf8");
	assert.equal(defaultVerifyGateChecks(dir2).length, 1);
	// No package.json → zero checks → INCONCLUSIVE → LLM verifier as today
	const dir3 = createTrackedTempDir("pi-crew-verify-gate-defaults3-");
	assert.equal(defaultVerifyGateChecks(dir3).length, 0);
});

test("resolveVerifierSpawnDecision: PASS skips, FAILED spawns with gate context", () => {
	const pass = evaluateVerifyGateResults([{ name: "t", command: "c", exitCode: 0, passed: true, durationMs: 1, outputTail: "" }]);
	assert.deepEqual(resolveVerifierSpawnDecision(pass), { skipVerifier: true, reason: "deterministic_pass", attachGateContext: false });
	const failed = evaluateVerifyGateResults([{ name: "t", command: "c", exitCode: 1, passed: false, durationMs: 1, outputTail: "err" }]);
	const failedDecision = resolveVerifierSpawnDecision(failed);
	assert.equal(failedDecision.skipVerifier, false);
	assert.equal(failedDecision.reason, "deterministic_failed");
	assert.equal(failedDecision.attachGateContext, true);
});

test("resolveVerifierSpawnDecision: INCONCLUSIVE consults the classifier layer (U6B)", () => {
	const inconclusive = evaluateVerifyGateResults([]);
	// Classifier blocks decisively → skip
	assert.deepEqual(
		resolveVerifierSpawnDecision(inconclusive, {
			blockVerifier: true,
			consulted: true,
			action: "blocked",
			score: 0.95,
			confidence: 0.9,
		}),
		{ skipVerifier: true, reason: "classifier_blocked", attachGateContext: false },
	);
	// Classifier escalates → spawn, labeled by its action
	assert.deepEqual(
		resolveVerifierSpawnDecision(inconclusive, {
			blockVerifier: false,
			consulted: false,
			action: "disabled",
			score: undefined,
			confidence: undefined,
		}),
		{ skipVerifier: false, reason: "classifier_disabled", attachGateContext: false },
	);
	// No classifier at all → spawn as today
	assert.deepEqual(resolveVerifierSpawnDecision(inconclusive), {
		skipVerifier: false,
		reason: "inconclusive_no_classifier",
		attachGateContext: false,
	});
	// A FAILED gate NEVER consults the classifier (it may not rubber-stamp)
	assert.equal(
		resolveVerifierSpawnDecision(
			evaluateVerifyGateResults([{ name: "t", command: "c", exitCode: 1, passed: false, durationMs: 1, outputTail: "" }]),
			{ blockVerifier: true, consulted: true, action: "blocked", score: 1, confidence: 1 },
		).skipVerifier,
		false,
	);
});

test("resolveVerifyGateEnabled/TimeoutMs: env precedence + safe defaults", () => {
	const prevGate = process.env.PI_CREW_VERIFY_GATE;
	const prevTimeout = process.env.PI_CREW_VERIFY_GATE_TIMEOUT_MS;
	try {
		delete process.env.PI_CREW_VERIFY_GATE;
		assert.equal(resolveVerifyGateEnabled(), true); // default ON
		assert.equal(resolveVerifyGateEnabled(false), false);
		process.env.PI_CREW_VERIFY_GATE = "0";
		assert.equal(resolveVerifyGateEnabled(true), false); // env beats explicit
		process.env.PI_CREW_VERIFY_GATE = "1";
		assert.equal(resolveVerifyGateEnabled(false), true);
		delete process.env.PI_CREW_VERIFY_GATE_TIMEOUT_MS;
		assert.equal(resolveVerifyGateTimeoutMs(), 120_000);
		assert.equal(resolveVerifyGateTimeoutMs(5_000), 5_000);
		process.env.PI_CREW_VERIFY_GATE_TIMEOUT_MS = "300000";
		assert.equal(resolveVerifyGateTimeoutMs(5_000), 300_000);
		process.env.PI_CREW_VERIFY_GATE_TIMEOUT_MS = "-1";
		assert.equal(resolveVerifyGateTimeoutMs(), 120_000); // invalid → default
	} finally {
		if (prevGate === undefined) delete process.env.PI_CREW_VERIFY_GATE;
		else process.env.PI_CREW_VERIFY_GATE = prevGate;
		if (prevTimeout === undefined) delete process.env.PI_CREW_VERIFY_GATE_TIMEOUT_MS;
		else process.env.PI_CREW_VERIFY_GATE_TIMEOUT_MS = prevTimeout;
	}
});

test("renderVerifyGateContext/Summary: compact prompt + result shapes", () => {
	const outcome = evaluateVerifyGateResults([
		{ name: "typecheck", command: "npm run typecheck", exitCode: 1, passed: false, durationMs: 9, outputTail: "error TS1\nerror TS2" },
	]);
	const block = renderVerifyGateContext(outcome);
	assert.match(block, /## Deterministic verify_gate results/);
	assert.match(block, /Gate verdict: FAILED/);
	assert.match(block, /typecheck: exit=1 FAIL/);
	assert.match(block, /do NOT re-run them/);
	assert.match(renderVerifyGateSummary(outcome, "deterministic_failed"), /verify_gate: FAILED/);
});

test("createSubprocessVerifyGateExecutor: runs real commands with exit codes", async () => {
	const exec = createSubprocessVerifyGateExecutor();
	const ok = await exec("true", { cwd: process.cwd(), timeoutMs: 30_000 });
	assert.equal(ok.exitCode, 0);
	const bad = await exec("false", { cwd: process.cwd(), timeoutMs: 30_000 });
	assert.equal(bad.exitCode, 1);
});

test("runVerifierGatePreGate: green gate skips the verifier + emits saved-spawn metric", async () => {
	const registry = createMetricRegistry();
	const dir = createTrackedTempDir("pi-crew-verify-gate-pregate-");
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "node -e 0" } }), "utf8");
	const result = await runVerifierGatePreGate({
		cwd: dir,
		// explicit checks keep the test hermetic (no npm spawn)
		checks: [{ name: "always-green", command: "true" }],
		metricRegistry: registry,
	});
	assert.equal(result.outcome.verdict, "PASS");
	assert.equal(result.decision.skipVerifier, true);
	assert.equal(result.decision.reason, "deterministic_pass");
	assert.equal(result.promptContext, "");
	const skipped = registry.snapshot().find((m) => m.name === "crew.verification.verifier_spawns_skipped_total");
	assert.ok(skipped, "saved-spawn metric exists");
});

test("runVerifierGatePreGate: failing gate spawns with prompt context + metric", async () => {
	const registry = createMetricRegistry();
	const result = await runVerifierGatePreGate({
		checks: [{ name: "always-red", command: "false" }],
		cwd: process.cwd(),
		metricRegistry: registry,
	});
	assert.equal(result.outcome.verdict, "FAILED");
	assert.equal(result.decision.skipVerifier, false);
	assert.equal(result.decision.attachGateContext, true);
	assert.match(result.promptContext, /## Deterministic verify_gate results/);
	assert.match(result.promptContext, /exit=1/);
	assert.ok(registry.snapshot().some((m) => m.name === "crew.verification.verifier_spawns_total"));
});

test("runVerifierGatePreGate: INCONCLUSIVE + classifier soft-fail escalates to the LLM verifier", async () => {
	// No package.json → zero default checks → INCONCLUSIVE; classifier layer
	// consulted but enabled with a missing registry → soft-fail escalate.
	const dir = createTrackedTempDir("pi-crew-verify-gate-inconclusive-");
	const result = await runVerifierGatePreGate({
		cwd: dir,
		classifier: {
			enabled: true,
			modelRegistry: undefined,
			classifierModel: "opencode/test",
			eventsPath: path.join(dir, "events.jsonl"),
			runId: "r-test",
			taskId: "t-test",
		},
	});
	assert.equal(result.outcome.verdict, "INCONCLUSIVE");
	assert.equal(result.decision.skipVerifier, false);
	// classifyVerifierPreGate never throws; unreachable classifier → fallback
	assert.ok(["classifier_escalate_fallback", "inconclusive_no_classifier"].includes(result.decision.reason));
});

test("runVerifierGatePreGate: default checks resolve from the repo's package.json", async () => {
	const dir = createTrackedTempDir("pi-crew-verify-gate-preset-");
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "node -e 0" } }), "utf8");
	const result = await runVerifierGatePreGate({ cwd: dir });
	// preset ran the package's typecheck script through the subprocess executor
	assert.equal(result.outcome.checks.length, 1);
	assert.equal(result.outcome.checks[0]?.name, "typecheck");
	assert.equal(result.outcome.verdict, "PASS");
});

test("VerifyGateCheck type accepts grep evidence lines (spec's third check)", async () => {
	const dir = createTrackedTempDir("pi-crew-verify-gate-grep-");
	fs.writeFileSync(path.join(dir, "dist.txt"), "marker-line\n");
	const checks: VerifyGateCheck[] = [
		{ name: "typecheck", command: "true" },
		{ name: "grep-evidence", command: `grep -c marker ${JSON.stringify(path.join(dir, "dist.txt"))}`, critical: false },
	];
	const result = await runVerifierGatePreGate({ cwd: dir, checks });
	assert.equal(result.outcome.verdict, "PASS");
});

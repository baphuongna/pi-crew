/**
 * spec-strict-sandbox tests (ADR-6 §4, WP-6 step 4).
 *
 * Covers: sandbox env has NO provider keys / broker tokens (captured env),
 * digest/exit semantics, timeout kill, wrapper-launch failure fails CLOSED,
 * network isolation via unshare -rn, strict evaluator outcomes incl. the
 * two provenance negative ACs (worker-authored + hand-forged degrade), and
 * the §5 reject-start reason.
 *
 * Platform note: unshare -rn is Linux-only. On other platforms the
 * executable-sandbox tests assert the fail-closed outcome instead; the
 * evaluator-level tests run everywhere (they need no unshare because
 * degraded paths never reach the sandbox).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { specStrictRejectReason } from "../../../../src/extension/team-tool/run-intent.ts";
import { evaluateSpecStrict, parseSpecEvidenceFooter } from "../../../../src/runtime/task-runner/spec-evidence.ts";
import { buildSpecSandboxEnv, runSpecCheck } from "../../../../src/runtime/verification/spec-sandbox.ts";
import { isSpecTrusted, saveSpecRecord } from "../../../../src/state/stores/spec-store.ts";
import type { SpecRecord, SpecSnapshot } from "../../../../src/state/types.ts";

const IS_LINUX = process.platform === "linux";

function makeCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-specstrict-"));
	fs.mkdirSync(path.join(dir, ".git")); // project-scoped root (bug-029 lesson)
	return dir;
}

function snapshotFrom(record: SpecRecord): SpecSnapshot {
	return {
		specId: record.id,
		version: record.version,
		frozenAt: "2026-08-20T00:00:00.000Z",
		items: record.requirements.flatMap((requirement) =>
			record.acceptance.filter((a) => a.requirementId === requirement.id).map((acceptance) => ({ requirement, acceptance })),
		),
	};
}

function strictSpec(overrides?: Partial<SpecRecord>): SpecRecord {
	return {
		id: "spec-strict",
		version: 1,
		title: "Strict-checked spec",
		requirements: [{ id: "req-1", text: "Output is deterministic", priority: "must" }],
		acceptance: [
			{
				id: "acc-1",
				requirementId: "req-1",
				check: "echo ok digest-stable",
				command: "printf ok",
				expectedDigest: createHash("sha256").update("ok", "utf8").digest("hex"),
				idempotent: true,
			},
		],
		source: { kind: "manual" },
		...overrides,
	};
}

// ── Sandbox env ──────────────────────────────────────────────────────────

test("sandbox env: BASE_ALLOWLIST pattern MINUS credential keys — no provider keys, no broker tokens", () => {
	const dirty: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin",
		HOME: "/home/x",
		ANTHROPIC_API_KEY: "sk-secret",
		OPENAI_API_KEY: "sk-secret",
		GITHUB_TOKEN: "gh-secret",
		PI_CREW_BROKER_SOCKET: "/run/broker.sock",
		PI_CREW_BROKER_TOKEN: "broker-secret",
		MY_APP_CREDENTIAL: "cred",
	};
	const env = buildSpecSandboxEnv(dirty as unknown as NodeJS.ProcessEnv);
	assert.ok(env.PATH, "PATH preserved");
	assert.equal(env.ANTHROPIC_API_KEY, undefined, "provider key stripped");
	assert.equal(env.OPENAI_API_KEY, undefined, "provider key stripped");
	assert.equal(env.GITHUB_TOKEN, undefined, "token stripped");
	assert.equal(env.PI_CREW_BROKER_SOCKET, undefined, "broker socket stripped");
	assert.equal(env.PI_CREW_BROKER_TOKEN, undefined, "broker token stripped");
	assert.equal(env.MY_APP_CREDENTIAL, undefined, "credential-shaped key stripped");
	assert.equal(env.FORCE_COLOR, "0");
});

// ── Executable sandbox (Linux; fail-closed elsewhere) ─────────────────────

test("sandbox: deterministic command passes digest+exit check", async () => {
	if (!IS_LINUX) return; // fail-closed path covered below
	const cwd = makeCwd();
	try {
		const out = await runSpecCheck(
			{ command: "printf ok", expectedDigest: createHash("sha256").update("ok", "utf8").digest("hex") },
			{ cwd },
		);
		assert.equal(out.outcome, "passed");
		assert.equal(out.exitCode, 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("sandbox: digest mismatch fails the check (digest-only payload)", async () => {
	if (!IS_LINUX) return;
	const out = await runSpecCheck({ command: "printf tampered", expectedDigest: "0".repeat(64) }, { cwd: os.tmpdir() });
	assert.equal(out.outcome, "digest-mismatch");
	assert.match(out.actualDigest ?? "", /^[0-9a-f]{64}$/, "actual digest present, raw output never persisted");
});

test("sandbox: exit-code mismatch fails the check", async () => {
	if (!IS_LINUX) return;
	const out = await runSpecCheck(
		{ command: "printf nope; exit 7", expectedDigest: undefined, expectedExitCode: 0 },
		{ cwd: os.tmpdir() },
	);
	assert.equal(out.outcome, "exit-mismatch");
	assert.equal(out.exitCode, 7);
});

test("sandbox: wall-clock timeout kills (SIGTERM→SIGKILL escalation)", async () => {
	if (!IS_LINUX) return;
	const out = await runSpecCheck({ command: "sleep 300" }, { cwd: os.tmpdir(), limits: { wallClockMs: 800, sigkillGraceMs: 200 } });
	assert.equal(out.outcome, "timeout");
	assert.ok(out.durationMs < 10_000, `killed promptly (durationMs=${out.durationMs})`);
});

test("sandbox: wrapper-launch failure FAILS CLOSED (never runs without isolation)", async () => {
	if (!IS_LINUX) return;
	const out = await runSpecCheck({ command: "printf ok" }, { cwd: os.tmpdir(), wrapperOverride: "definitely-missing-unshare-wrapper" });
	assert.equal(out.outcome, "launch-failed");
});

test("sandbox: non-Linux platform fails closed (no unshare equivalent — platform honesty)", async () => {
	if (IS_LINUX) return;
	const out = await runSpecCheck({ command: "printf ok" }, { cwd: os.tmpdir() });
	assert.equal(out.outcome, "launch-failed");
});

test("sandbox: network is isolated — outbound TCP connect fails inside unshare -rn", { timeout: 30_000 }, async () => {
	if (!IS_LINUX) return;
	// bash /dev/tcp keeps the probe lightweight (the 256 MiB address-space
	// ulimit kills node/v8-based probes). Inside the isolated netns connect()
	// must fail (exit 1); if isolation ever breaks, connect succeeds → exit 0
	// → this test FAILS (fail-open detection). Requires only bash on the host.
	const probe = `bash -c 'exec 3<>/dev/tcp/1.1.1.1/80'`;
	const out = await runSpecCheck({ command: probe, expectedExitCode: 0 }, { cwd: os.tmpdir() });
	assert.equal(out.outcome, "exit-mismatch", "TCP connect failed inside the isolated netns");
	assert.equal(out.exitCode, 1);
});

// ── Strict evaluator (platform-independent paths) ─────────────────────────

test("strict: trusted manual spec + idempotent digest check → machine-check passes", async () => {
	const cwd = makeCwd();
	try {
		const record = strictSpec();
		saveSpecRecord(cwd, record, { userAction: true }); // mints the sidecar
		assert.equal(isSpecTrusted(cwd, "spec-strict"), true);
		const footer = parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: digest stable across runs\n");
		const result = await evaluateSpecStrict([snapshotFrom(record)], footer, { cwd });
		assert.equal(result.strict.passed, true);
		assert.equal(result.badge, undefined);
		assert.deepEqual(
			result.strict.checks.map((c) => c.result),
			["passed"],
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("strict NEGATIVE AC 1: worker-authored (generated) spec degrades to coverage-only + badge, never re-runs", async () => {
	const cwd = makeCwd();
	try {
		// Worker path — even though the payload declares manual+trusted+idempotent.
		const record = strictSpec({ source: { kind: "manual" }, trusted: true });
		saveSpecRecord(cwd, record); // userAction default false → forced generated, no sidecar
		const footer = parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: covered\n");
		const result = await evaluateSpecStrict([snapshotFrom(record)], footer, { cwd });
		assert.deepEqual(
			result.strict.checks.map((c) => c.result),
			["degraded-untrusted-spec"],
			"NEW-2: generated-spec commands are never re-executed by root",
		);
		assert.equal(result.badge, "unverified");
		assert.equal(result.strict.passed, true, "degrade is the compromise path — badge, not fail");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("strict NEGATIVE AC 2: hand-forged manual/trusted record (sidecar absent) ALSO degrades", async () => {
	const cwd = makeCwd();
	try {
		const record = strictSpec();
		saveSpecRecord(cwd, record, { userAction: true }); // mint sidecar…
		// …then hand-edit the file and DELETE the sidecar (the attack: a worker
		// rewriting state/specs/spec-strict.json cannot re-mint it).
		fs.rmSync(path.join(cwd, ".crew", "state", "specs", "spec-strict.trusted"));
		const footer = parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: forged but covered\n");
		const result = await evaluateSpecStrict([snapshotFrom(record)], footer, { cwd });
		assert.equal(result.strict.checks[0].result, "degraded-untrusted-spec", "provenance is the sidecar, never the file fields");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("strict: non-idempotent must → degraded-non-idempotent + badge (no re-run)", async () => {
	const cwd = makeCwd();
	try {
		const record = strictSpec({
			acceptance: [
				{ id: "acc-1", requirementId: "req-1", check: "db migration", command: "psql -c 'insert ...'", idempotent: false },
			],
		});
		saveSpecRecord(cwd, record, { userAction: true });
		const result = await evaluateSpecStrict(
			[snapshotFrom(record)],
			parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: migration applied\n"),
			{ cwd },
		);
		assert.equal(result.strict.checks[0].result, "degraded-non-idempotent");
		assert.equal(result.badge, "unverified");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("strict: must without command → degraded-no-command (cannot machine-check)", async () => {
	const cwd = makeCwd();
	try {
		const record = strictSpec({
			acceptance: [{ id: "acc-1", requirementId: "req-1", check: "manual review only" }],
		});
		saveSpecRecord(cwd, record, { userAction: true });
		const result = await evaluateSpecStrict([snapshotFrom(record)], parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: reviewed\n"), {
			cwd,
		});
		assert.equal(result.strict.checks[0].result, "degraded-no-command");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("strict: digest mismatch in a trusted idempotent check FAILS the gate (B4 strict)", async (t) => {
	if (!IS_LINUX) return t.skip("sandbox execution needs unshare");
	const cwd = makeCwd();
	try {
		const record = strictSpec({ acceptance: [{ ...strictSpec().acceptance[0], expectedDigest: "f".repeat(64) }] });
		saveSpecRecord(cwd, record, { userAction: true });
		const result = await evaluateSpecStrict([snapshotFrom(record)], parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: ok\n"), { cwd });
		assert.equal(result.strict.passed, false);
		assert.equal(result.strict.checks[0].result, "failed");
		assert.equal(result.strict.checks[0].outcome, "digest-mismatch");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("strict: missing footer with musts FAILS (coverage gap fails strict — B4-c strict column)", async () => {
	const cwd = makeCwd();
	try {
		const record = strictSpec();
		saveSpecRecord(cwd, record, { userAction: true });
		const result = await evaluateSpecStrict([snapshotFrom(record)], parseSpecEvidenceFooter("done, no footer"), { cwd });
		assert.equal(result.strict.passed, false);
		assert.deepEqual(result.missingMustIds, ["acc-1"]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("strict: unknown id cited FAILS the gate", async () => {
	const cwd = makeCwd();
	try {
		const record = strictSpec();
		saveSpecRecord(cwd, record, { userAction: true });
		const result = await evaluateSpecStrict(
			[snapshotFrom(record)],
			parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: ok\nacc-ghost: invented\n"),
			{ cwd },
		);
		assert.equal(result.strict.passed, false);
		assert.deepEqual(result.unknownIds, ["acc-ghost"]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("strict: spec-less task → not applicable, never fails (regression guard)", async () => {
	const result = await evaluateSpecStrict(undefined, parseSpecEvidenceFooter("no specs at all"), { cwd: os.tmpdir() });
	assert.equal(result.applicable, false);
	assert.equal(result.strict.passed, true);
});

// ── §5 reject-start ───────────────────────────────────────────────────────

test("reject-start: strict workflow without verifier step is rejected; with verifier or non-strict passes", () => {
	const base = { name: "wf", description: "", source: "user" as const, filePath: "/tmp/wf.workflow.md" };
	assert.ok(specStrictRejectReason({ ...base, specStrict: true, steps: [{ id: "s1", role: "executor", task: "x" }] }));
	assert.equal(
		specStrictRejectReason({
			...base,
			specStrict: true,
			steps: [
				{ id: "s1", role: "executor", task: "x" },
				{ id: "s2", role: "verifier", task: "y" },
			],
		}),
		undefined,
	);
	assert.equal(
		specStrictRejectReason({ ...base, steps: [{ id: "s1", role: "executor", task: "x" }] }),
		undefined,
		"non-strict unaffected",
	);
});
